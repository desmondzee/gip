#!/usr/bin/env bun
/**
 * Smoke test for scripts/train-lora.ts JSONL output.
 *
 * Validates that data/lora-train.jsonl (and lora-eval.jsonl if present)
 * conforms to Together AI's chat-completions fine-tunes format:
 *
 *   { "messages": [
 *       { "role": "user", "content": "..." },
 *       { "role": "assistant", "content": "..." }
 *     ]
 *   }
 *
 * Also checks: line count, sanitization (no lone surrogates / control chars),
 * per-source-class diversity (the 3 reverse-prompt templates produced
 * register-appropriate questions on average).
 *
 * Run AFTER `bun run train-lora -- --dry-run` so the JSONL files exist.
 *
 * Usage: bun scripts/smoke-train-lora.ts
 * Exits: 0 on success, 1 with diagnostic on failure.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = process.cwd()
const TRAIN_PATH = resolve(ROOT, "data/lora-train.jsonl")
const EVAL_PATH = resolve(ROOT, "data/lora-eval.jsonl")

const MIN_TRAIN_PAIRS = 5 // smoke test only — real gate is in train-lora.ts (1000)

interface ChatPair {
  messages: Array<{ role?: string; content?: string }>
}

function fail(msg: string, extra?: unknown): never {
  console.error(`[smoke-train-lora] FAIL: ${msg}`)
  if (extra !== undefined) console.error(extra)
  process.exit(1)
}

function validateLine(line: string, idx: number, file: string): ChatPair {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (e) {
    fail(`${file}:${idx + 1} not valid JSON: ${e instanceof Error ? e.message : e}`, line.slice(0, 120))
  }
  const obj = parsed as ChatPair
  if (!obj || typeof obj !== "object") fail(`${file}:${idx + 1} not an object`, parsed)
  if (!Array.isArray(obj.messages)) fail(`${file}:${idx + 1} missing messages array`, obj)
  if (obj.messages.length !== 2) fail(`${file}:${idx + 1} expected exactly 2 messages, got ${obj.messages.length}`, obj)
  const [u, a] = obj.messages
  if (u.role !== "user") fail(`${file}:${idx + 1} messages[0].role must be 'user', got ${u.role}`, obj)
  if (a.role !== "assistant") fail(`${file}:${idx + 1} messages[1].role must be 'assistant', got ${a.role}`, obj)
  if (typeof u.content !== "string" || u.content.length === 0) {
    fail(`${file}:${idx + 1} user.content empty or not string`, obj)
  }
  if (typeof a.content !== "string" || a.content.length === 0) {
    fail(`${file}:${idx + 1} assistant.content empty or not string`, obj)
  }
  // Sanitization check: no lone surrogates, no control chars (except tab/newline)
  for (const text of [u.content, a.content]) {
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
      fail(`${file}:${idx + 1} contains control characters that survived sanitize`, text.slice(0, 80))
    }
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
      fail(`${file}:${idx + 1} contains lone UTF-16 surrogate`, text.slice(0, 80))
    }
  }
  return obj
}

function loadJsonl(path: string): ChatPair[] {
  if (!existsSync(path)) fail(`missing ${path} — run \`bun run train-lora -- --dry-run\` first`)
  const text = readFileSync(path, "utf8")
  const lines = text.split("\n").filter((l) => l.trim().length > 0)
  return lines.map((l, i) => validateLine(l, i, path))
}

function checkDiversity(pairs: ChatPair[]): void {
  // Reverse-prompts produced via three different templates should NOT all
  // start with the same boilerplate. Check that the user-side question
  // distribution has at least 3 distinct first words (a coarse proxy for
  // template diversity).
  const firstWords = new Set<string>()
  for (const p of pairs.slice(0, 100)) {
    const w = p.messages[0].content!.trim().split(/\s+/)[0]?.toLowerCase()
    if (w) firstWords.add(w)
  }
  if (firstWords.size < 3) {
    fail(
      `low diversity in user-side questions (only ${firstWords.size} distinct first words across first 100 pairs). ` +
        `Reverse-prompt templates may not be source-class-aware. Expected: 3+ source classes producing varied openers.`,
      [...firstWords],
    )
  }
}

function main(): void {
  console.log(`smoke-train-lora — validating ${TRAIN_PATH}`)
  const train = loadJsonl(TRAIN_PATH)
  console.log(`  train: ${train.length} pairs`)
  if (train.length < MIN_TRAIN_PAIRS) {
    fail(`train set has ${train.length} pairs (need >= ${MIN_TRAIN_PAIRS} for smoke validity)`)
  }
  checkDiversity(train)

  if (existsSync(EVAL_PATH)) {
    const held = loadJsonl(EVAL_PATH)
    console.log(`  eval: ${held.length} pairs`)
    if (held.length === 0) fail("eval set is empty — held-out gate will be vibes")
  } else {
    console.warn(`  eval: ${EVAL_PATH} missing (held-out quality gate disabled)`)
  }

  console.log("[smoke-train-lora] PASS")
  process.exit(0)
}

main()
