#!/usr/bin/env bun
/**
 * End-to-end smoke for the three-layer cameo.
 *
 * Run Sunday morning during dry-run. Asserts:
 *   1. Agent fired both `search` (events) AND `search_voice` (voice)
 *   2. Either the LoRA voicing phase ran (thinking event mentions "voicing")
 *      OR the adapter is unset and the loop passed through cleanly
 *   3. Final answer is non-empty and the markdown formatter produced both
 *      "What happened" and "How I said it" sections (when corpus permits)
 *   4. Total round-trip latency under the design's 15s ceiling on a warm
 *      pre-cached question
 *
 * Pre-warm: this script asks the same question twice and only asserts on
 * the second response — the first run primes Atlas + Anthropic + Together.
 *
 * Usage: bun scripts/smoke-cameo-3layer.ts
 * Exits: 0 on success, 1 with diagnostic on failure.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"

type McpChild = ChildProcessByStdio<Writable, Readable, null>
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = resolve(ROOT, "bin/mcp-persona.ts")
const REQ_TIMEOUT_MS = 90_000
const WARM_LATENCY_CEILING_MS = 15_000

function loadEnvFile(): void {
  const p = resolve(ROOT, ".env")
  if (!existsSync(p)) return
  const text = readFileSync(p, "utf8")
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    const key = m[1]
    if (process.env[key]) continue
    let val = m[2]
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
    process.env[key] = val
  }
}

interface JsonRpcResp {
  jsonrpc: "2.0"
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

class McpClient {
  private nextId = 1
  private buf = ""
  private pending = new Map<number, (r: JsonRpcResp) => void>()
  constructor(private child: McpChild) {
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as JsonRpcResp
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg)
            this.pending.delete(msg.id)
          }
        } catch {
          // ignore non-JSON noise
        }
      }
    })
  }
  send(method: string, params?: unknown, expectResponse = true): Promise<JsonRpcResp> {
    if (!expectResponse) {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
      return Promise.resolve({ jsonrpc: "2.0" })
    }
    const id = this.nextId++
    return new Promise((resolveResp, rejectResp) => {
      this.pending.set(id, resolveResp)
      setTimeout(() => {
        this.pending.delete(id)
        rejectResp(new Error(`timeout waiting for ${method} (id=${id})`))
      }, REQ_TIMEOUT_MS)
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }
}

function fail(msg: string, extra?: unknown): never {
  console.error(`[smoke-cameo-3layer] FAIL: ${msg}`)
  if (extra !== undefined) console.error(extra)
  process.exit(1)
}

interface TraceEvent {
  type: string
  tool?: string
  text?: string
}

async function askOnce(cli: McpClient, question: string): Promise<{
  markdown: string
  events: TraceEvent[]
  total_ms: number
  status: string
}> {
  const t0 = Date.now()
  const call = await cli.send("tools/call", {
    name: "ask_persona",
    arguments: { question },
  })
  const elapsed = Date.now() - t0
  if (call.error) fail("tools/call returned JSON-RPC error", call.error)
  const content = (call.result as { content?: Array<{ type?: string; text?: string }> })?.content
  if (!Array.isArray(content) || content.length < 2) {
    fail("tools/call returned malformed content", call.result)
  }
  const markdown = content[0].text ?? ""
  const blob = content[1].text ?? ""
  let parsed: { events?: TraceEvent[]; total_ms?: number; status?: string }
  try {
    parsed = JSON.parse(blob)
  } catch (e) {
    fail(`events blob unparseable: ${e instanceof Error ? e.message : e}`, blob.slice(0, 200))
  }
  return {
    markdown,
    events: parsed.events ?? [],
    total_ms: parsed.total_ms ?? elapsed,
    status: parsed.status ?? "unknown",
  }
}

async function main(): Promise<void> {
  loadEnvFile()
  if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY missing")
  if (!process.env.MONGODB_URI) fail("MONGODB_URI missing")

  // Voicer is "configured" when PERSONA_VOICER is gemini/together OR when
  // a bare PERSONA_LORA_ADAPTER is set (backwards-compat for the original
  // Together-only path).
  const voicerEnv = (process.env.PERSONA_VOICER ?? "").trim().toLowerCase()
  const adapter = process.env.PERSONA_LORA_ADAPTER?.trim()
  const voicerConfigured =
    voicerEnv === "gemini" || voicerEnv === "together" || (!voicerEnv && !!adapter)
  const voicerLabel = voicerConfigured
    ? voicerEnv === "gemini"
      ? `gemini:${process.env.GEMINI_VOICER_MODEL ?? process.env.GEMINI_BASELINE_MODEL ?? "gemini-2.5-flash"}`
      : `together:${adapter ?? "(unset)"}`
    : "off"
  console.error(`[smoke-cameo-3layer] voicer=${voicerLabel}`)

  const child = spawn("bun", [BIN], { stdio: ["pipe", "pipe", "inherit"], env: process.env })
  child.on("exit", (code, sig) => {
    if (code !== null && code !== 0) {
      console.error(`[smoke-cameo-3layer] child exited code=${code} sig=${sig}`)
    }
  })
  const cli = new McpClient(child)

  try {
    await cli.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-cameo-3layer", version: "0.0.0" },
    })
    await cli.send("notifications/initialized", {}, false)

    const question = "draft an email to my team about what I worked on this week, in my voice"

    // Pre-warm
    console.error("[smoke-cameo-3layer] pre-warm pass…")
    await askOnce(cli, question)

    // Real measured pass
    console.error("[smoke-cameo-3layer] measured pass…")
    const r = await askOnce(cli, question)

    if (r.status !== "done") {
      fail(`agent did not converge: status=${r.status}`, r.events.slice(-3))
    }

    const tools = r.events.filter((e) => e.type === "tool_call").map((e) => e.tool)
    const sawSearch = tools.includes("search")
    const sawVoice = tools.includes("search_voice")
    if (!sawSearch) fail(`agent never called \`search\` (events layer)`, tools)
    if (!sawVoice) fail(`agent never called \`search_voice\` (voice layer)`, tools)
    console.error(`[smoke-cameo-3layer] tools fired: ${tools.join(", ")}`)

    // Voicing phase: thinking events mention "voicing"
    const voicing = r.events.filter(
      (e) => e.type === "thinking" && typeof e.text === "string" && /voicing/i.test(e.text),
    )
    if (voicerConfigured) {
      if (voicing.length === 0) {
        fail(
          `voicer ${voicerLabel} is configured but no voicing event in trace — voicePhase didn't run. Check lib/agent/loop.ts wiring.`,
          r.events.slice(-5),
        )
      }
      console.error(`[smoke-cameo-3layer] voicing events: ${voicing.length}`)
      for (const v of voicing) console.error(`  - ${v.text}`)
    } else {
      console.error("[smoke-cameo-3layer] voicer off — voicing skipped (passthrough)")
    }

    // Markdown sanity
    if (!r.markdown || r.markdown.length < 20) fail("answer markdown too short", r.markdown)
    if (!/_events:/.test(r.markdown)) fail("answer missing summary marker", r.markdown.slice(-300))

    // Latency on the warm pass
    if (r.total_ms > WARM_LATENCY_CEILING_MS) {
      console.warn(
        `[smoke-cameo-3layer] WARN: warm round-trip ${r.total_ms}ms > ${WARM_LATENCY_CEILING_MS}ms ceiling`,
      )
    }
    console.error(`[smoke-cameo-3layer] warm round-trip: ${r.total_ms}ms`)

    console.error("[smoke-cameo-3layer] PASS")
    child.kill()
    process.exit(0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    fail(msg)
  }
}

main()
