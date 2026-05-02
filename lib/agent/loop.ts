import Anthropic from "@anthropic-ai/sdk"
import { TOOL_DEFS, dispatchTool } from "./tools"
import { systemPrompt } from "./prompts"
import type { SearchHit, ToolName, TraceEvent } from "../schemas"

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"
const DEFAULT_USER_NAME = process.env.PERSONA_USER_NAME ?? "the user"
const MAX_TURNS = 8
const HARD_TIMEOUT_MS = 90_000

let _client: Anthropic | null = null
function client(): Anthropic {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set")
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export interface RunResult {
  answer: string
  citations: SearchHit[]
  events: TraceEvent[]
  total_ms: number
  status: "done" | "timeout" | "error" | "exhausted"
  error?: string
}

export async function runAgent(
  question: string,
  opts: { userName?: string; maxTurns?: number; onEvent?: (e: TraceEvent) => void } = {},
): Promise<RunResult> {
  const userName = opts.userName ?? DEFAULT_USER_NAME
  const maxTurns = opts.maxTurns ?? MAX_TURNS
  const start = Date.now()
  const events: TraceEvent[] = []
  const emit = (e: TraceEvent) => {
    events.push(e)
    opts.onEvent?.(e)
  }

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: question },
  ]

  let finalAnswer = ""
  let finalCitations: SearchHit[] = []
  let status: RunResult["status"] = "exhausted"
  let errorMsg: string | undefined

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (Date.now() - start > HARD_TIMEOUT_MS) {
        status = "timeout"
        break
      }

      const response = await client().messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt(userName),
        tools: TOOL_DEFS as unknown as Anthropic.Messages.Tool[],
        messages,
      })

      const toolUses = response.content.filter((b) => b.type === "tool_use")
      const textBlocks = response.content.filter((b) => b.type === "text")

      for (const tb of textBlocks) {
        if (tb.type === "text" && tb.text.trim().length > 0) {
          emit({ type: "thinking", text: tb.text, t: Date.now() - start })
        }
      }

      messages.push({ role: "assistant", content: response.content })

      if (toolUses.length === 0) {
        finalAnswer = textBlocks
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n")
          .trim()
        status = "done"
        emit({
          type: "answer",
          text: finalAnswer || "(no answer)",
          citation_ids: [],
          t: Date.now() - start,
        })
        break
      }

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
      let didTerminate = false

      for (const tu of toolUses) {
        if (tu.type !== "tool_use") continue
        const toolName = tu.name as ToolName
        const args = tu.input as Record<string, unknown>
        const tCallStart = Date.now()
        emit({
          type: "tool_call",
          tool_use_id: tu.id,
          tool: toolName,
          args,
          t: tCallStart - start,
        })

        let result
        try {
          result = await dispatchTool(toolName, args)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          emit({
            type: "tool_result",
            tool_use_id: tu.id,
            tool: toolName,
            result_summary: `ERROR: ${msg}`,
            latency_ms: Date.now() - tCallStart,
            t: Date.now() - start,
          })
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `error: ${msg}`,
            is_error: true,
          })
          continue
        }

        emit({
          type: "tool_result",
          tool_use_id: tu.id,
          tool: toolName,
          result_summary: result.summary,
          latency_ms: Date.now() - tCallStart,
          t: Date.now() - start,
        })

        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result.summary,
        })

        if (toolName === "summarize_for_answer") {
          const raw = result.raw as { answer: string; citation_ids: string[]; citations: SearchHit[] }
          finalAnswer = raw.answer
          finalCitations = raw.citations
          status = "done"
          didTerminate = true
          emit({
            type: "answer",
            text: finalAnswer,
            citation_ids: raw.citation_ids,
            t: Date.now() - start,
          })
        }
      }

      messages.push({ role: "user", content: toolResults })

      if (didTerminate) break
    }
  } catch (e) {
    status = "error"
    errorMsg = e instanceof Error ? e.message : String(e)
    emit({ type: "error", message: errorMsg, t: Date.now() - start })
  }

  return {
    answer: finalAnswer,
    citations: finalCitations,
    events,
    total_ms: Date.now() - start,
    status,
    error: errorMsg,
  }
}
