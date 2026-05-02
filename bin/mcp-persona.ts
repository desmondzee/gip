#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import Anthropic from "@anthropic-ai/sdk"
import { runAgent } from "../lib/agent/loop"
import { getDb } from "../lib/db"
import {
  formatPersonaAnswer,
  formatPersonaError,
  formatThrownError,
} from "../lib/mcp/format"

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
  // search hits a warm pool. Per eng review A2.
  const db = await getDb()
  await db.command({ ping: 1 })
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
        `real digital memories (Gmail, Calendar, Slack, Notion, GitHub, Maps, Drive, etc.). ` +
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
          const markdown = formatPersonaAnswer(result)
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
