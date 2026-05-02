#!/usr/bin/env bun
/**
 * Smoke test for the search_voice tool.
 *
 * Spawns bin/mcp-persona.ts, sends a voice/draft question, asserts the
 * trace shows the agent calling search_voice. Works whether or not the
 * voice corpus is populated — the assertion is "agent recognized this as
 * a voice question and called the right tool", not "results came back."
 *
 * Reuses the JSON-RPC client pattern from scripts/smoke-mcp.ts so any
 * future MCP smoke tests have a consistent shape.
 *
 * Usage: bun scripts/smoke-search-voice.ts
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
const TIMEOUT_MS = 60_000

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
      }, TIMEOUT_MS)
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }
}

function fail(msg: string, extra?: unknown): never {
  console.error(`[smoke-search-voice] FAIL: ${msg}`)
  if (extra !== undefined) console.error(extra)
  process.exit(1)
}

interface TraceEvent {
  type: string
  tool?: string
  hit_ids?: string[]
}

async function main(): Promise<void> {
  loadEnvFile()
  if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY missing")
  if (!process.env.MONGODB_URI) fail("MONGODB_URI missing")

  console.error("[smoke-search-voice] spawning bun", BIN)
  const child = spawn("bun", [BIN], { stdio: ["pipe", "pipe", "inherit"], env: process.env })
  child.on("exit", (code, sig) => {
    if (code !== null && code !== 0) {
      console.error(`[smoke-search-voice] child exited code=${code} sig=${sig}`)
    }
  })

  const cli = new McpClient(child)

  try {
    await cli.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-search-voice", version: "0.0.0" },
    })
    await cli.send("notifications/initialized", {}, false)

    // A voice/draft-style question that SHOULD make the agent reach for search_voice
    const question = "draft an email to my team summarizing what I worked on this week, in my voice"
    console.error(`[smoke-search-voice] asking: "${question}"`)
    const call = await cli.send("tools/call", {
      name: "ask_persona",
      arguments: { question },
    })
    if (call.error) fail("tools/call returned JSON-RPC error", call.error)
    const content = (call.result as { content?: Array<{ type?: string; text?: string }> })?.content
    if (!Array.isArray(content) || content.length < 2) {
      fail("tools/call did not return both markdown + events content blocks", call.result)
    }
    // content[1] is the JSON-stringified events blob (per bin/mcp-persona.ts)
    const blob = content[1].text ?? ""
    let parsed: { events?: TraceEvent[] }
    try {
      parsed = JSON.parse(blob)
    } catch (e) {
      fail(`could not parse events blob: ${e instanceof Error ? e.message : e}`, blob.slice(0, 200))
    }
    const events = parsed.events ?? []
    const toolCalls = events.filter((e) => e.type === "tool_call")
    const voiceCalls = toolCalls.filter((e) => e.tool === "search_voice")

    if (voiceCalls.length === 0) {
      fail(
        `agent did not call search_voice for a voice question. Tools called: ${toolCalls.map((t) => t.tool).join(", ") || "(none)"}. ` +
          `Likely a prompt or registration regression in lib/agent/prompts.ts or lib/agent/tools.ts.`,
      )
    }
    console.error(`[smoke-search-voice] search_voice fired ${voiceCalls.length}x`)

    // Soft assertion: did the call return any hits? OK if 0 (corpus may be empty)
    const totalVoiceHits = voiceCalls.reduce((sum, e) => sum + (e.hit_ids?.length ?? 0), 0)
    if (totalVoiceHits === 0) {
      console.warn(
        `[smoke-search-voice] search_voice returned 0 hits across ${voiceCalls.length} calls — voice corpus may be empty (run backfill-from-user first)`,
      )
    } else {
      console.error(`[smoke-search-voice] voice hits returned: ${totalVoiceHits} (across ${voiceCalls.length} calls)`)
    }

    console.error("[smoke-search-voice] PASS")
    child.kill()
    process.exit(0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    fail(msg)
  }
}

main()
