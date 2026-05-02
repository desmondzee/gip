#!/usr/bin/env bun
/**
 * LoRA training pipeline for the voice-generation layer.
 *
 * Pipeline (per design + eng reviews 2A, 2B):
 *
 *   1. Pull all metadata.from_user === true items from VOICE_SOURCE_CLASSES
 *   2. Reverse-prompt Claude per source-class (conversational / document /
 *      code) to synthesize the question the user was responding to. Pair
 *      each synthesized question with the authored text as the assistant
 *      message. Three templates so register matches: a casual reply gets
 *      a casual ask, a notion doc gets a draft request, a github commit
 *      gets a technical task.
 *   3. Sanitize, hold out 5 items as an eval set, write JSONL training file
 *      to data/lora-train.jsonl + held-out to data/lora-eval.jsonl
 *   4. Upload the file via Together AI /v1/files
 *   5. Kick off /v1/fine-tunes with the training file id
 *   6. Poll the job until terminal (succeeded / failed / cancelled). On
 *      transient 5xx, retry with exponential backoff. On 4xx, surface
 *      immediately with a clear message.
 *   7. Write final state to data/lora-training.json — Sunday morning's
 *      single-file go/no-go signal
 *
 * Usage:
 *   bun scripts/train-lora.ts --dry-run           # corpus only, no upload
 *   bun scripts/train-lora.ts --corpus-only       # alias for --dry-run
 *   bun scripts/train-lora.ts                     # full pipeline
 *   bun scripts/train-lora.ts --base-model NAME   # override Llama 3.1 8B Instruct
 *
 * Required env: ANTHROPIC_API_KEY (reverse-prompt), MONGODB_URI, plus
 * (for non-dry-run) TOGETHER_API_KEY.
 */
import Anthropic from "@anthropic-ai/sdk"
import { writeFile, mkdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { getDb, closeDb, type SourceName } from "../lib/db"
import { sanitizeText, safeTruncate } from "../lib/util/sanitize"

const TOGETHER_BASE = "https://api.together.xyz/v1"
const ROOT = process.cwd()
const DATA_DIR = resolve(ROOT, "data")
const TRAIN_PATH = resolve(DATA_DIR, "lora-train.jsonl")
const EVAL_PATH = resolve(DATA_DIR, "lora-eval.jsonl")
const STATE_PATH = resolve(DATA_DIR, "lora-training.json")

const HOLDOUT_SIZE = 5
const MIN_TRAIN_PAIRS = 1000 // eng review 2A: need >=1000 for voice transfer
const MAX_PAIRS_PER_SOURCE = 800 // cap per source so no single source dominates
const MAX_REVERSE_CONCURRENCY = 8

const REVERSE_MODEL = process.env.ANTHROPIC_REVERSE_MODEL ?? "claude-haiku-4-5"

type SourceClass = "conversational" | "document" | "code"

interface SourceClassMap {
  source: SourceName
  klass: SourceClass
}

const SOURCE_CLASSES: SourceClassMap[] = [
  { source: "gmail_msgs", klass: "conversational" },
  { source: "notion_docs", klass: "document" },
  { source: "gdocs_pages", klass: "document" },
  { source: "github_activity", klass: "code" },
]

interface ChatPair {
  messages: Array<{ role: "user" | "assistant"; content: string }>
}

interface CliArgs {
  dryRun: boolean
  baseModel: string
  loraRank: number
  epochs: number
}

function parseArgs(): CliArgs {
  let dryRun = false
  let baseModel = process.env.PERSONA_LORA_BASE ?? "meta-llama/Meta-Llama-3.1-8B-Instruct-Reference"
  let loraRank = 16
  let epochs = 3
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    switch (a) {
      case "--dry-run":
      case "--corpus-only":
        dryRun = true
        break
      case "--base-model":
        baseModel = process.argv[++i]
        break
      case "--rank":
        loraRank = Number(process.argv[++i])
        break
      case "--epochs":
        epochs = Number(process.argv[++i])
        break
      case "-h":
      case "--help":
        console.log(
          "usage: bun scripts/train-lora.ts [--dry-run] [--base-model NAME] [--rank N] [--epochs N]",
        )
        process.exit(0)
      default:
        throw new Error(`unknown arg ${a}`)
    }
  }
  return { dryRun, baseModel, loraRank, epochs }
}

// --------------------------------------------------------------------------
// Reverse-prompts (eng review 2A — three source-class templates)
// --------------------------------------------------------------------------

function reversePromptFor(klass: SourceClass, authored: string): string {
  switch (klass) {
    case "conversational":
      return `Read this message that someone sent in a chat or email:

"""
${authored}
"""

Imagine the most likely question or message they were responding to. Phrase it as a casual ask in the same register (chat-casual, not formal). Keep it short — under 25 words. Output ONLY the synthesized question, no preamble, no quotes around it.`
    case "document":
      return `Read this document or page someone wrote:

"""
${authored}
"""

Imagine the request that produced this document. Phrase it as a draft request: "Draft me X about Y" or "Write up Z" — the kind of request a colleague or friend would make. Keep it short. Output ONLY the synthesized request, no preamble, no quotes around it.`
    case "code":
      return `Read this commit message, issue, or PR description someone wrote:

"""
${authored}
"""

Imagine the technical task they were working on. Phrase it as the work request: "Fix X" or "Help me Y" or "Why does Z behave this way?". Keep it short and technical. Output ONLY the synthesized task, no preamble, no quotes around it.`
  }
}

// --------------------------------------------------------------------------
// Corpus prep
// --------------------------------------------------------------------------

let _anth: Anthropic | null = null
function anth(): Anthropic {
  if (_anth) return _anth
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set")
  _anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _anth
}

async function reversePromptOne(klass: SourceClass, authored: string): Promise<string | null> {
  try {
    const res = await anth().messages.create({
      model: REVERSE_MODEL,
      max_tokens: 120,
      messages: [{ role: "user", content: reversePromptFor(klass, authored) }],
    })
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim()
    return text.length > 0 ? text : null
  } catch (e) {
    console.warn(`  reverse-prompt failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

async function fetchAuthoredItems(source: SourceName): Promise<string[]> {
  const db = await getDb()
  const col = db.collection(source)
  const cursor = col.find(
    { "metadata.from_user": true },
    { projection: { text: 1 }, limit: MAX_PAIRS_PER_SOURCE },
  )
  const out: string[] = []
  for await (const doc of cursor) {
    const t = sanitizeText(String(doc.text ?? "")).trim()
    if (t.length < 50) continue // skip low-signal items
    out.push(t.length > 1500 ? t.slice(0, 1500) : t) // cap context length
  }
  return out
}

async function reversePromptParallel(
  klass: SourceClass,
  items: string[],
): Promise<ChatPair[]> {
  const out: ChatPair[] = []
  let i = 0
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++
      const authored = items[idx]
      const synthesized = await reversePromptOne(klass, authored)
      if (synthesized) {
        out.push({
          messages: [
            { role: "user", content: synthesized },
            { role: "assistant", content: authored },
          ],
        })
      }
      if (idx % 50 === 0) process.stdout.write(`.`)
    }
  }
  await Promise.all(Array.from({ length: MAX_REVERSE_CONCURRENCY }, worker))
  process.stdout.write(`\n`)
  return out
}

async function buildCorpus(): Promise<{ train: ChatPair[]; held: ChatPair[]; perSource: Record<string, number> }> {
  const all: ChatPair[] = []
  const perSource: Record<string, number> = {}

  for (const { source, klass } of SOURCE_CLASSES) {
    process.stdout.write(`[${source}] querying authored… `)
    const items = await fetchAuthoredItems(source)
    console.log(`${items.length} items, reverse-prompting (class=${klass})`)
    const pairs = await reversePromptParallel(klass, items)
    perSource[source] = pairs.length
    all.push(...pairs)
    console.log(`[${source}] +${pairs.length} pairs`)
  }

  // Shuffle deterministically by sorting on a hash of content (so reruns
  // produce the same train/held split as long as the corpus is unchanged).
  all.sort((a, b) => {
    const ka = a.messages[1].content.slice(0, 16)
    const kb = b.messages[1].content.slice(0, 16)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  const held = all.slice(0, HOLDOUT_SIZE)
  const train = all.slice(HOLDOUT_SIZE)
  return { train, held, perSource }
}

async function writeJsonl(path: string, pairs: ChatPair[]): Promise<void> {
  const lines = pairs.map((p) => JSON.stringify(p)).join("\n") + "\n"
  await writeFile(path, lines, "utf8")
}

// --------------------------------------------------------------------------
// Together AI fine-tune kickoff + poll (eng review 2B)
// --------------------------------------------------------------------------

interface TogetherJobState {
  job_id: string
  status: string
  output_name?: string
  error?: string
  poll_count: number
  finished_at_iso?: string
}

const POLL_INITIAL_MS = 30_000
const POLL_MAX_MS = 120_000
const POLL_DEADLINE_MS = 90 * 60 * 1000 // 90 min absolute ceiling

function togetherKey(): string {
  const k = process.env.TOGETHER_API_KEY
  if (!k) throw new Error("TOGETHER_API_KEY is not set")
  return k
}

async function uploadTrainingFile(path: string): Promise<string> {
  const fd = new FormData()
  const fileText = await readFile(path, "utf8")
  const fileBlob = new Blob([fileText], { type: "application/jsonl" })
  fd.append("file", fileBlob, "lora-train.jsonl")
  fd.append("purpose", "fine-tune")
  let attempt = 0
  while (attempt < 3) {
    const res = await fetch(`${TOGETHER_BASE}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${togetherKey()}` },
      body: fd,
    })
    if (res.ok) {
      const j = (await res.json()) as { id?: string }
      if (!j.id) throw new Error("Together /files returned no id")
      return j.id
    }
    if (res.status >= 400 && res.status < 500) {
      const body = await res.text()
      throw new Error(`Together /files ${res.status}: ${body.slice(0, 240)}`)
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    attempt++
  }
  throw new Error("Together /files exhausted retries")
}

async function kickoffFineTune(opts: {
  trainFileId: string
  baseModel: string
  loraRank: number
  epochs: number
}): Promise<string> {
  const body = {
    training_file: opts.trainFileId,
    model: opts.baseModel,
    n_epochs: opts.epochs,
    lora: true,
    lora_r: opts.loraRank,
    lora_alpha: opts.loraRank * 2,
    suffix: `persona-${Date.now()}`,
  }
  let attempt = 0
  while (attempt < 3) {
    const res = await fetch(`${TOGETHER_BASE}/fine-tunes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${togetherKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const j = (await res.json()) as { id?: string }
      if (!j.id) throw new Error("Together /fine-tunes returned no id")
      return j.id
    }
    if (res.status >= 400 && res.status < 500) {
      const errBody = await res.text()
      throw new Error(`Together /fine-tunes ${res.status}: ${errBody.slice(0, 240)}`)
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
    attempt++
  }
  throw new Error("Together /fine-tunes exhausted retries")
}

async function pollJob(jobId: string): Promise<TogetherJobState> {
  const start = Date.now()
  let pollCount = 0
  let pollMs = POLL_INITIAL_MS

  while (Date.now() - start < POLL_DEADLINE_MS) {
    pollCount++
    const res = await fetch(`${TOGETHER_BASE}/fine-tunes/${jobId}`, {
      headers: { Authorization: `Bearer ${togetherKey()}` },
    })
    if (res.status === 401 || res.status === 403) {
      return {
        job_id: jobId,
        status: "auth_failed",
        error: `Together rejected the API key (${res.status}) during polling — was TOGETHER_API_KEY rotated?`,
        poll_count: pollCount,
      }
    }
    if (!res.ok) {
      // Transient — retry after backoff
      console.warn(`  poll #${pollCount}: ${res.status}; retrying`)
      await new Promise((r) => setTimeout(r, pollMs))
      pollMs = Math.min(pollMs * 1.5, POLL_MAX_MS)
      continue
    }
    const j = (await res.json()) as {
      status?: string
      output_name?: string
      events?: Array<{ message?: string }>
      error?: string
    }
    const status = (j.status ?? "unknown").toLowerCase()
    process.stdout.write(`  poll #${pollCount} status=${status}\n`)
    if (
      status === "completed" ||
      status === "succeeded" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "error"
    ) {
      return {
        job_id: jobId,
        status,
        output_name: j.output_name,
        error: j.error ?? j.events?.findLast?.((e) => e.message?.toLowerCase().includes("error"))?.message,
        poll_count: pollCount,
        finished_at_iso: new Date().toISOString(),
      }
    }
    await new Promise((r) => setTimeout(r, pollMs))
    pollMs = Math.min(pollMs * 1.5, POLL_MAX_MS)
  }
  return {
    job_id: jobId,
    status: "polling_deadline_exceeded",
    error: `${POLL_DEADLINE_MS / 60000} min deadline reached without terminal state`,
    poll_count: pollCount,
  }
}

async function writeFinalState(state: Record<string, unknown>): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8")
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs()
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true })

  console.log(`train-lora — mode=${args.dryRun ? "DRY RUN (corpus only)" : "FULL PIPELINE"}`)
  console.log(`base model: ${args.baseModel}, rank: ${args.loraRank}, epochs: ${args.epochs}`)
  console.log("")

  // Phase 1: corpus prep
  const startedAt = new Date().toISOString()
  console.log("=== Phase 1: corpus prep ===")
  const { train, held, perSource } = await buildCorpus()
  console.log(`\nfinal: ${train.length} train pairs, ${held.length} held-out`)
  for (const [s, n] of Object.entries(perSource)) {
    console.log(`  ${s}: ${n} pairs`)
  }

  if (train.length < MIN_TRAIN_PAIRS) {
    console.warn(
      `\nWARNING: only ${train.length} training pairs (need >= ${MIN_TRAIN_PAIRS} for voice transfer at LoRA rank ${args.loraRank}).`,
    )
    console.warn(`Either bump --rank to ${args.loraRank * 2} OR drop the LoRA leg and ship two layers.`)
  }

  await writeJsonl(TRAIN_PATH, train)
  await writeJsonl(EVAL_PATH, held)
  console.log(`\nwrote ${TRAIN_PATH} (${train.length} pairs), ${EVAL_PATH} (${held.length} held-out)`)

  if (args.dryRun) {
    await writeFinalState({
      mode: "dry-run",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      train_pairs: train.length,
      held_out: held.length,
      per_source: perSource,
      train_path: TRAIN_PATH,
      eval_path: EVAL_PATH,
    })
    console.log(`\nDRY RUN complete. State written to ${STATE_PATH}`)
    await closeDb()
    return
  }

  // Phase 2: upload + kickoff
  console.log("\n=== Phase 2: Together AI upload + fine-tune kickoff ===")
  let trainFileId: string
  try {
    trainFileId = await uploadTrainingFile(TRAIN_PATH)
    console.log(`uploaded training file: ${trainFileId}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await writeFinalState({
      mode: "upload_failed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error: safeTruncate(msg, 1024),
      train_pairs: train.length,
    })
    console.error(`upload failed: ${msg}`)
    process.exit(1)
  }

  let jobId: string
  try {
    jobId = await kickoffFineTune({
      trainFileId,
      baseModel: args.baseModel,
      loraRank: args.loraRank,
      epochs: args.epochs,
    })
    console.log(`kickoff ok — job_id: ${jobId}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await writeFinalState({
      mode: "kickoff_failed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      train_file_id: trainFileId,
      error: safeTruncate(msg, 1024),
    })
    console.error(`kickoff failed: ${msg}`)
    process.exit(1)
  }

  // Phase 3: poll
  console.log("\n=== Phase 3: poll until terminal ===")
  const final = await pollJob(jobId)
  console.log(`\nfinal status: ${final.status}`)
  if (final.error) console.log(`error: ${final.error}`)
  if (final.output_name) console.log(`output_name: ${final.output_name}`)

  await writeFinalState({
    mode: "full_pipeline",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    train_pairs: train.length,
    held_out: held.length,
    per_source: perSource,
    train_file_id: trainFileId,
    job_id: jobId,
    final_status: final.status,
    output_name: final.output_name,
    error: final.error,
    poll_count: final.poll_count,
    base_model: args.baseModel,
    lora_rank: args.loraRank,
    epochs: args.epochs,
    next_action:
      final.status === "completed" || final.status === "succeeded"
        ? `set PERSONA_LORA_ADAPTER=${final.output_name} in claude_desktop_config.example.json`
        : "drop the LoRA leg, ship two layers (events + voice RAG) Sunday",
  })
  console.log(`\nstate written to ${STATE_PATH}`)
  await closeDb()
}

main().catch((e) => {
  console.error("train-lora failed:", e instanceof Error ? e.message : e)
  process.exit(1)
})
