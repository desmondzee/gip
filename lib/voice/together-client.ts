/**
 * Together AI chat-completions client for the LoRA voicing phase.
 *
 * Together's API is OpenAI-compatible. Adapters trained via Together's
 * fine-tunes API show up as serverless model IDs in the same /chat/completions
 * endpoint — no special LoRA flag needed. This client wraps that with:
 *   - 5xx retries with exponential backoff (transient capacity / queue)
 *   - 4xx surfaced immediately (auth, validation — won't help to retry)
 *   - per-call timeout (default 10s; warm serverless is 1-3s, cold 30-60s)
 *   - eager validation hook for MCP startup (eng review 1D)
 */

const ENDPOINT = "https://api.together.xyz/v1/chat/completions"
const MODELS_ENDPOINT = "https://api.together.xyz/v1/models"

const DEFAULT_TIMEOUT_MS = 10_000
const VALIDATE_TIMEOUT_MS = 5_000
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 500

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface ChatOpts {
  model: string
  messages: ChatMessage[]
  max_tokens?: number
  temperature?: number
  timeoutMs?: number
}

export class TogetherError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = "TogetherError"
  }
}

function apiKey(): string {
  const k = process.env.TOGETHER_API_KEY
  if (!k) throw new TogetherError("TOGETHER_API_KEY is not set", null, false)
  return k
}

async function postWithTimeout(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(t)
  }
}

async function getWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(t)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Run one chat-completions call with retry/backoff on transient errors.
 *
 * Returns the assistant's text content. Throws TogetherError on terminal
 * failures (4xx, exhausted retries). Callers should catch and fall back to
 * the agent loop's draft answer (eng review 1A).
 */
export async function chat(opts: ChatOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const body = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.max_tokens ?? 400,
    temperature: opts.temperature ?? 0.7,
  }

  let lastErr: TogetherError | null = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res: Response
    try {
      res = await postWithTimeout(ENDPOINT, body, timeoutMs)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const aborted = msg.toLowerCase().includes("abort")
      lastErr = new TogetherError(
        aborted ? `Together AI timed out after ${timeoutMs}ms` : `Together AI network error: ${msg}`,
        null,
        true,
      )
      await sleep(BASE_BACKOFF_MS * 2 ** attempt)
      continue
    }

    if (res.ok) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const text = json.choices?.[0]?.message?.content?.trim()
      if (!text) {
        throw new TogetherError("Together AI returned empty content", res.status, false)
      }
      return text
    }

    // Non-2xx: 4xx is terminal, 5xx is retryable
    let errBody = ""
    try {
      errBody = await res.text()
    } catch {
      errBody = "(could not read body)"
    }
    const retryable = res.status >= 500 && res.status < 600
    lastErr = new TogetherError(
      `Together AI ${res.status}: ${errBody.slice(0, 240)}`,
      res.status,
      retryable,
    )
    if (!retryable) throw lastErr
    await sleep(BASE_BACKOFF_MS * 2 ** attempt)
  }

  throw lastErr ?? new TogetherError("Together AI exhausted retries", null, true)
}

/**
 * Validate that Together AI is reachable AND the configured adapter exists.
 *
 * Called from bin/mcp-persona.ts at startup when PERSONA_LORA_ADAPTER is set
 * (eng review 1D). Returns true on success. Throws TogetherError with a
 * loud, actionable message on failure — so a typo'd adapter id or expired
 * API key fails before Claude Desktop sees the persona tool.
 *
 * Strategy: GET /v1/models, scan for the adapter id. The endpoint returns
 * the user's available models including fine-tunes.
 */
export async function validateAdapter(adapterId: string): Promise<{ exists: boolean; models_seen: number }> {
  let res: Response
  try {
    res = await getWithTimeout(MODELS_ENDPOINT, VALIDATE_TIMEOUT_MS)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new TogetherError(`Together AI unreachable for adapter validation: ${msg}`, null, true)
  }

  if (res.status === 401 || res.status === 403) {
    throw new TogetherError(
      `Together AI rejected the API key (${res.status}). Check TOGETHER_API_KEY.`,
      res.status,
      false,
    )
  }
  if (!res.ok) {
    throw new TogetherError(
      `Together AI /v1/models returned ${res.status} during adapter validation`,
      res.status,
      false,
    )
  }

  let json: unknown
  try {
    json = await res.json()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new TogetherError(`Together AI /v1/models invalid JSON: ${msg}`, res.status, false)
  }

  // Together returns either an array or { data: [...] }. Handle both.
  const list = Array.isArray(json)
    ? (json as Array<{ id?: string }>)
    : ((json as { data?: Array<{ id?: string }> }).data ?? [])

  const exists = list.some((m) => m.id === adapterId)
  if (!exists) {
    throw new TogetherError(
      `Adapter "${adapterId}" not found among ${list.length} models on TOGETHER_API_KEY's account. ` +
        `Check PERSONA_LORA_ADAPTER for typos, or unset it to disable the LoRA voicing path.`,
      404,
      false,
    )
  }
  return { exists: true, models_seen: list.length }
}
