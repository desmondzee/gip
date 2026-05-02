#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import Anthropic from "@anthropic-ai/sdk"
import { runAgent } from "../lib/agent/loop"
import { getDb } from "../lib/db"
import { formatPersonaError, formatThrownError } from "../lib/mcp/format"
import { formatCameoAnswer } from "../lib/voice/format"
import { validateAdapter, TogetherError } from "../lib/voice/together-client"
import { validateVoicerModel, GeminiError } from "../lib/voice/gemini-client"

const PERSONA_USER_NAME = process.env.PERSONA_USER_NAME ?? "the user"

function logErr(...args: unknown[]): void {
  console.error("[mcp-persona]", ...args)
}

async function eagerInit(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set")
  }
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set")
  }
  // Construct the Anthropic client up front. SDK does TLS lazily, but the
  // class instantiation is now done so the agent loop's first call only pays
  // for the request itself.
  void new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Force the Mongo connection pool to establish so the first agent-loop
  // search hits a warm pool. Per prior cameo eng review A2.
  const db = await getDb()
  await db.command({ ping: 1 })

  // Eager-validate the configured voicer (eng review 1D). Fail loud here —
  // better than a silent voicing fallback at demo time. Backwards-compat:
  // a bare PERSONA_LORA_ADAPTER without PERSONA_VOICER still routes Together.
  const voicerEnv = (process.env.PERSONA_VOICER ?? "").trim().toLowerCase()
  const adapter = process.env.PERSONA_LORA_ADAPTER?.trim()
  const voicer =
    voicerEnv === "gemini" || voicerEnv === "together"
      ? voicerEnv
      : adapter
        ? "together"
        : "off"

  if (voicer === "gemini") {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        "PERSONA_VOICER=gemini but GEMINI_API_KEY is missing — voicer cannot reach Gemini",
      )
    }
    try {
      const v = await validateVoicerModel()
      logErr(`gemini voicer ok — "${v.model}" reachable`)
    } catch (e) {
      const msg = e instanceof GeminiError ? e.message : e instanceof Error ? e.message : String(e)
      throw new Error(`Gemini voicer validation failed: ${msg}`)
    }
  } else if (voicer === "together") {
    if (!adapter) {
      throw new Error(
        "PERSONA_VOICER=together but PERSONA_LORA_ADAPTER is missing — voicer has no model",
      )
    }
    if (!process.env.TOGETHER_API_KEY) {
      throw new Error(
        "PERSONA_LORA_ADAPTER is set but TOGETHER_API_KEY is missing — adapter cannot be reached",
      )
    }
    try {
      const v = await validateAdapter(adapter)
      logErr(`together adapter ok — "${adapter}" found among ${v.models_seen} available models`)
    } catch (e) {
      const msg = e instanceof TogetherError ? e.message : e instanceof Error ? e.message : String(e)
      throw new Error(`Together AI adapter validation failed: ${msg}`)
    }
  } else {
    logErr("PERSONA_VOICER unset — voicing phase will passthrough Claude's draft")
  }

  logErr("eager-init done — anthropic client constructed, mongo ping ok")
}

async function main(): Promise<void> {
  await eagerInit()

  const server = new McpServer({
    name: "persona",
    version: "0.1.0",
  })

  server.registerTool(
    "ask_persona",
    {
      description:
        `Answer a question as ${PERSONA_USER_NAME} would, drawing on ${PERSONA_USER_NAME}'s ` +
        `real digital memories (Gmail, Calendar, Notion, GitHub, Maps, Drive, etc.). ` +
        `Returns an answer in ${PERSONA_USER_NAME}'s voice with cited memory snippets.`,
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe(`The question to answer as ${PERSONA_USER_NAME}.`),
      },
    },
    async ({ question }) => {
      try {
        const result = await runAgent(question, { userName: PERSONA_USER_NAME })

        if (result.status === "done") {
          // Three-layer cameo formatter: splits citations into events + voice
          // sections, names the adapter in the summary line. Falls back
          // gracefully when one of the three layers is empty (premise 6).
          const markdown = formatCameoAnswer(result)
          const eventsBlob = JSON.stringify({
            events: result.events,
            status: result.status,
            total_ms: result.total_ms,
          })
          return {
            content: [
              { type: "text" as const, text: markdown },
              { type: "text" as const, text: eventsBlob },
            ],
          }
        }

        // status: timeout | error | exhausted — graceful markdown error per eng A1
        return {
          content: [{ type: "text" as const, text: formatPersonaError(result) }],
          isError: true,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logErr("ask_persona threw:", msg)
        return {
          content: [{ type: "text" as const, text: formatThrownError(msg) }],
          isError: true,
        }
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  logErr("ready on stdio")
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  logErr("fatal:", msg)
  process.exit(1)
})
