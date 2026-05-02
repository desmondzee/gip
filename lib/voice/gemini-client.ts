/**
 * Gemini generateContent client for the voicing phase.
 *
 * Drop-in alternative to lib/voice/together-client.ts for users who'd
 * rather not stand up a Together AI account + LoRA fine-tune. The voice
 * RAG layer is unchanged — Gemini just gets the same retrieved exemplars
 * as in-context guidance and rewrites the answer with cleaner separation
 * from the agent loop's planning context.
 *
 *   - Different model from the planner (Anthropic) → trace shows a
 *     discrete voicing step the rubric can point at
 *   - Voice exemplars become few-shot guidance instead of training data
 *   - No fine-tuning step → Saturday becomes a one-line env change
 *
 * Tradeoff: this is in-context voicing, not learned-weights voicing.
 * Cadence transfer is weaker than a real LoRA on 1k+ pairs but still
 * stronger than the planner's default register on the same prompt.
 *
 * Same retry + validate shape as together-client so voicePhase can switch
 * between them via PERSONA_VOICER without restructuring the call site.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta"
const DEFAULT_MODEL = "gemini-2.5-flash"
const DEFAULT_TIMEOUT_MS = 10_000
const VALIDATE_TIMEOUT_MS = 5_000
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 500

export interface GeminiChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface GeminiChatOpts {
  model?: string
  messages: GeminiChatMessage[]
  max_tokens?: number
  temperature?: number
  timeoutMs?: number
}

export class GeminiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = "GeminiError"
  }
}

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY
  if (!k) throw new GeminiError("GEMINI_API_KEY is not set", null, false)
  return k
}

export function voicerModel(): string {
  return (
    process.env.GEMINI_VOICER_MODEL?.trim() ||
    process.env.GEMINI_BASELINE_MODEL?.trim() ||
    DEFAULT_MODEL
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function postWithTimeout(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(t)
  }
}

interface GeminiContent {
  parts: Array<{ text: string }>
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: GeminiContent
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
}

/**
 * One-shot chat call. Returns the assistant text. Throws GeminiError on
 * terminal failures; voicePhase catches and falls back to the draft.
 *
 * Maps the OpenAI-style { role: system|user|assistant, content } shape
 * into Gemini's { systemInstruction, contents } shape so callers can use
 * the same prompt builder they use for Together.
 */
export async function chat(opts: GeminiChatOpts): Promise<string> {
  const model = opts.model ?? voicerModel()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = `${ENDPOINT}/models/${model}:generateContent?key=${apiKey()}`

  const systemMsgs = opts.messages.filter((m) => m.role === "system")
  const turns = opts.messages.filter((m) => m.role !== "system")

  // Gemini 2.5 models reserve part of maxOutputTokens for internal thinking.
  // gemini-2.5-pro requires thinking mode (can't disable) and easily eats
  // 400-1000 tokens reasoning before producing output. Default to a generous
  // 4000-token budget so the model can think AND emit a 100-300 token rewrite.
  // The voicing prompt tells the model to be concise, so wasted budget is
  // small in practice.
  const body = {
    systemInstruction:
      systemMsgs.length > 0
        ? { parts: [{ text: systemMsgs.map((m) => m.content).join("\n\n") }] }
        : undefined,
    contents: turns.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: opts.max_tokens ?? 4000,
      temperature: opts.temperature ?? 0.7,
    },
  }

  let lastErr: GeminiError | null = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res: Response
    try {
      res = await postWithTimeout(url, body, timeoutMs)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const aborted = msg.toLowerCase().includes("abort")
      lastErr = new GeminiError(
        aborted ? `Gemini timed out after ${timeoutMs}ms` : `Gemini network error: ${msg}`,
        null,
        true,
      )
      await sleep(BASE_BACKOFF_MS * 2 ** attempt)
      continue
    }

    if (res.ok) {
      const json = (await res.json()) as GenerateContentResponse
      if (json.promptFeedback?.blockReason) {
        throw new GeminiError(
          `Gemini blocked the prompt: ${json.promptFeedback.blockReason}`,
          res.status,
          false,
        )
      }
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim()
      if (!text) {
        throw new GeminiError("Gemini returned empty content", res.status, false)
      }
      return text
    }

    let errBody = ""
    try {
      errBody = await res.text()
    } catch {
      errBody = "(could not read body)"
    }
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600)
    lastErr = new GeminiError(
      `Gemini ${res.status}: ${errBody.slice(0, 240)}`,
      res.status,
      retryable,
    )
    if (!retryable) throw lastErr
    await sleep(BASE_BACKOFF_MS * 2 ** attempt)
  }

  throw lastErr ?? new GeminiError("Gemini exhausted retries", null, true)
}

/**
 * Probe Gemini at MCP startup so a missing/expired API key fails loud
 * before Claude Desktop sees the persona tool. The probe is a tiny
 * generateContent call ("ok") — costs ~nothing, confirms the key works
 * AND the configured model id resolves.
 */
export async function validateVoicerModel(model?: string): Promise<{ model: string }> {
  const m = model ?? voicerModel()
  const url = `${ENDPOINT}/models/${m}:generateContent?key=${apiKey()}`
  let res: Response
  try {
    res = await postWithTimeout(
      url,
      {
        contents: [{ role: "user", parts: [{ text: "ok" }] }],
        generationConfig: { maxOutputTokens: 8 },
      },
      VALIDATE_TIMEOUT_MS,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new GeminiError(`Gemini unreachable for validation: ${msg}`, null, true)
  }
  if (res.status === 401 || res.status === 403) {
    throw new GeminiError(
      `Gemini rejected the API key (${res.status}). Check GEMINI_API_KEY.`,
      res.status,
      false,
    )
  }
  if (res.status === 404) {
    throw new GeminiError(
      `Gemini model "${m}" not found (${res.status}). Set GEMINI_VOICER_MODEL to a valid model id (e.g., gemini-2.5-flash, gemini-2.5-pro).`,
      res.status,
      false,
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new GeminiError(
      `Gemini validation returned ${res.status}: ${body.slice(0, 200)}`,
      res.status,
      false,
    )
  }
  return { model: m }
}
