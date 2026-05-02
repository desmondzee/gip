#!/usr/bin/env bun
/**
 * Smoke test for bin/mcp-persona.ts.
 *
 * Spawns the MCP server as a child process, completes the initialize
 * handshake, lists tools, calls ask_persona once, and asserts the response
 * shape. Loads .env from the repo root before spawning so the child inherits
 * ANTHROPIC_API_KEY + MONGODB_URI in dev (Claude Desktop sets env explicitly
 * in production).
 *
 * Usage: bun scripts/smoke-mcp.ts
 * Exits: 0 on success, 1 with diagnostic on failure.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = resolve(ROOT, "bin/mcp-persona.ts")
const TIMEOUT_MS = 30_000

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
  constructor(private child: ChildProcessWithoutNullStreams) {
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
      const t = setTimeout(() => {
        this.pending.delete(id)
        rejectResp(new Error(`timeout waiting for ${method} (id=${id})`))
      }, TIMEOUT_MS)
      ;(this.pending.get(id) as unknown as { _t?: NodeJS.Timeout })._t = t
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }
}

function fail(msg: string, extra?: unknown): never {
  console.error(`[smoke-mcp] FAIL: ${msg}`)
  if (extra !== undefined) console.error(extra)
  process.exit(1)
}

async function main(): Promise<void> {
  loadEnvFile()
  if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY missing — cannot smoke-test eager init")
  if (!process.env.MONGODB_URI) fail("MONGODB_URI missing — cannot smoke-test eager init")

  console.error("[smoke-mcp] spawning bun", BIN)
  const child = spawn("bun", [BIN], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  })
  child.on("exit", (code, sig) => {
    if (code !== null && code !== 0) {
      console.error(`[smoke-mcp] child exited code=${code} sig=${sig}`)
    }
  })

  const cli = new McpClient(child)

  try {
    // Phase 1: initialize handshake
    const init = await cli.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-mcp", version: "0.0.0" },
    })
    if (!init.result) fail("initialize returned no result", init)
    await cli.send("notifications/initialized", {}, false)

    // Phase 2: tools/list — must include ask_persona with a question schema
    const list = await cli.send("tools/list", {})
    const tools = (list.result as { tools?: Array<Record<string, unknown>> })?.tools ?? []
    const ask = tools.find((t) => t.name === "ask_persona")
    if (!ask) fail("ask_persona not registered", tools)
    const schema = ask.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
    if (!schema?.properties?.question) fail("ask_persona schema missing 'question' property", schema)
    if (!schema.required?.includes("question")) fail("'question' not marked required", schema)
    console.error("[smoke-mcp] tools/list ok — ask_persona registered")

    // Phase 3: tools/call — make a real query, assert response shape
    const call = await cli.send("tools/call", {
      name: "ask_persona",
      arguments: { question: "say the word ok" },
    })
    if (call.error) fail("tools/call returned JSON-RPC error", call.error)
    const content = (call.result as { content?: Array<{ type?: string; text?: string }> })?.content
    if (!Array.isArray(content) || content.length === 0) fail("tools/call returned no content", call.result)
    if (content[0].type !== "text") fail("content[0].type is not 'text'", content[0])
    const text = content[0].text ?? ""
    // Must end with the formatter's summary line marker (works on success or
    // graceful error path — both formatters emit `_events:` or `_status:`)
    if (!/_events:|_status:/.test(text)) {
      fail("response markdown missing summary marker (`_events:` or `_status:`)", text.slice(-300))
    }
    console.error("[smoke-mcp] tools/call ok — response has summary marker")

    console.error("[smoke-mcp] PASS")
    child.kill()
    process.exit(0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    fail(msg)
  }
}

main()
