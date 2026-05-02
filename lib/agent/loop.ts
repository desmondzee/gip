import Anthropic from "@anthropic-ai/sdk"
import { TOOL_DEFS, dispatchTool, isUserAuthored } from "./tools"
import { systemPrompt, voicePromptMessages } from "./prompts"
import { classifyQuestion } from "./classify"
import { chat as togetherChat, TogetherError } from "../voice/together-client"
import { chat as geminiChat, voicerModel as geminiVoicerModel, GeminiError } from "../voice/gemini-client"
import type { CandidateScore, SearchHit, ToolName, TraceEvent } from "../schemas"
import { safeTruncate } from "../util/sanitize"

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
    const classification = await classifyQuestion(question)
    emit({
      type: "classify",
      strategy: classification.category,
      reasoning: classification.reasoning,
      t: Date.now() - start,
    })
    const sysPrompt = systemPrompt(userName, classification.category)

    for (let turn = 0; turn < maxTurns; turn++) {
      if (Date.now() - start > HARD_TIMEOUT_MS) {
        status = "timeout"
        break
      }

      const response = await client().messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: sysPrompt,
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

        const candidates: CandidateScore[] | undefined = result.hits?.map((h) => ({
          id: h._id,
          score: h.score,
          match_kind: h.match_kind,
          ts: h.ts,
          source: h.source,
          text_preview: safeTruncate(h.text, 80),
        }))

        emit({
          type: "tool_result",
          tool_use_id: tu.id,
          tool: toolName,
          result_summary: result.summary,
          latency_ms: Date.now() - tCallStart,
          t: Date.now() - start,
          hit_ids: result.hit_ids,
          candidates,
        })

        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result.summary,
        })

        if (toolName === "summarize_for_answer") {
          const raw = result.raw as { answer: string; citation_ids: string[]; citations: SearchHit[] }
          finalCitations = raw.citations
          // Voicing phase (eng review 1A): if PERSONA_LORA_ADAPTER is set,
          // route the draft through Together AI for cadence rewriting. On
          // any failure, fall back to the draft — the layered fallback
          // (premise 6) keeps the demo intact even when the LoRA leg breaks.
          finalAnswer = await voicePhase({
            userName,
            question,
            draftAnswer: raw.answer,
            citations: raw.citations,
            emit,
            startMs: start,
          })
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

// ---------------------------------------------------------------------------
// Voicing phase (eng review 1A)
//
// Splits the agent's citations into events vs voice exemplars, builds the
// voicing prompt (eng review 1C — has_voice_exemplars flag included), and
// routes through whichever voicer is configured. The fallback path is one
// branch — the design's "layered fallback" (premise 6) is implemented here:
// any voicer failure returns the draft unchanged.
//
// Voicer routing is by PERSONA_VOICER env:
//   - "off" / unset       → passthrough (default)
//   - "gemini"            → Gemini generateContent (in-context voicing)
//   - "together"          → Together AI LoRA adapter (learned-weights voicing)
// ---------------------------------------------------------------------------

// Gemini 2.5 thinking-mode calls routinely take 4-10s. Together LoRA
// serverless is faster (1-3s warm) but cold-start can hit 30s. Default 15s
// covers both warm paths; override with PERSONA_VOICE_TIMEOUT_MS for tighter
// or looser limits.
const VOICE_TIMEOUT_MS = Number(process.env.PERSONA_VOICE_TIMEOUT_MS ?? "15000")

type Voicer = "off" | "gemini" | "together"

function resolvedVoicer(): { voicer: Voicer; modelLabel: string } {
  const raw = (process.env.PERSONA_VOICER ?? "").trim().toLowerCase()
  if (raw === "gemini") return { voicer: "gemini", modelLabel: geminiVoicerModel() }
  if (raw === "together") {
    const adapter = process.env.PERSONA_LORA_ADAPTER?.trim() ?? ""
    return { voicer: "together", modelLabel: adapter || "(unset adapter)" }
  }
  // Backwards-compat: a bare PERSONA_LORA_ADAPTER without PERSONA_VOICER
  // implies the original Together-only path. Keeps the prior cameo working
  // even after this file picks up the new dispatch.
  if (!raw && process.env.PERSONA_LORA_ADAPTER?.trim()) {
    return { voicer: "together", modelLabel: process.env.PERSONA_LORA_ADAPTER.trim() }
  }
  return { voicer: "off", modelLabel: "passthrough" }
}

export function voicerLabel(): string {
  const r = resolvedVoicer()
  return r.voicer === "off" ? "off" : `${r.voicer}:${r.modelLabel}`
}

interface VoicePhaseInput {
  userName: string
  question: string
  draftAnswer: string
  citations: SearchHit[]
  emit: (e: TraceEvent) => void
  startMs: number
}

async function voicePhase(i: VoicePhaseInput): Promise<string> {
  const { voicer, modelLabel } = resolvedVoicer()
  if (voicer === "off") return i.draftAnswer // passthrough — voicing disabled

  // Split citations: voice exemplars are user-authored; events are everything else.
  const voiceHits = i.citations.filter(isUserAuthored)
  const eventHits = i.citations.filter((c) => !isUserAuthored(c))
  const hasVoiceExemplars = voiceHits.length > 0

  const t0 = Date.now()
  i.emit({
    type: "thinking",
    text:
      `voicing via ${voicer} (${modelLabel}) — ${eventHits.length} events, ` +
      `${voiceHits.length} voice exemplars${hasVoiceExemplars ? "" : " (NONE — empty-voice path)"}`,
    t: t0 - i.startMs,
  })

  const prompt = voicePromptMessages({
    userName: i.userName,
    question: i.question,
    draftAnswer: i.draftAnswer,
    eventFacts: eventHits.map((h) => ({
      source: h.source,
      ts: new Date(h.ts).toISOString(),
      text: h.text,
    })),
    voiceExemplars: voiceHits.map((h) => ({
      source: h.source,
      ts: new Date(h.ts).toISOString(),
      text: h.text,
    })),
    hasVoiceExemplars,
  })

  try {
    let rewritten: string
    if (voicer === "together") {
      rewritten = await togetherChat({
        model: modelLabel,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: 400,
        temperature: 0.7,
        timeoutMs: VOICE_TIMEOUT_MS,
      })
    } else {
      // Gemini — in-context voicer using the existing GEMINI_API_KEY.
      // System instruction goes in systemInstruction; user prompt becomes
      // the only user-role turn (gemini-client maps the shape internally).
      // Higher token budget than Together because gemini-2.5-* spends
      // budget on internal thinking before emitting output.
      rewritten = await geminiChat({
        model: modelLabel,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: 4000,
        temperature: 0.7,
        timeoutMs: VOICE_TIMEOUT_MS,
      })
    }
    i.emit({
      type: "thinking",
      text: `voicing ok in ${Date.now() - t0}ms — ${voicer} rewrote draft (${i.draftAnswer.length}ch → ${rewritten.length}ch)`,
      t: Date.now() - i.startMs,
    })
    return rewritten
  } catch (err) {
    const msg =
      err instanceof TogetherError || err instanceof GeminiError
        ? `${err.message}${err.status ? ` (status ${err.status})` : ""}`
        : err instanceof Error
          ? err.message
          : String(err)
    i.emit({
      type: "thinking",
      text: `voicing failed in ${Date.now() - t0}ms — ${safeTruncate(msg, 240)}; falling back to draft`,
      t: Date.now() - i.startMs,
    })
    return i.draftAnswer
  }
}
