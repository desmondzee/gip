import type { RunResult } from "../agent/loop"
import type { TraceEvent } from "../schemas"
import { sanitizeText } from "../util/sanitize"

function toolCallCount(events: TraceEvent[]): number {
  return events.filter((e) => e.type === "tool_call").length
}

export function formatPersonaAnswer(r: RunResult): string {
  const top = r.citations.slice(0, 3)
  const cites = top
    .map((c) => {
      const date = c.ts.toISOString().slice(0, 10)
      const snippet = sanitizeText(c.text).slice(0, 120).replace(/\n/g, " ")
      return `> _from your ${c.source} (${date}): "${snippet}..."_`
    })
    .join("\n")

  const sources = [...new Set(top.map((c) => c.source))].join(", ") || "none"
  const summary =
    `_events: ${toolCallCount(r.events)} calls · ` +
    `${(r.total_ms / 1000).toFixed(1)}s · ` +
    `sources: ${sources}_`

  const body = sanitizeText(r.answer)
  return cites
    ? `${body}\n\n${cites}\n\n---\n${summary}`
    : `${body}\n\n---\n${summary}`
}

export function formatPersonaError(r: RunResult, fallbackMessage?: string): string {
  const reason =
    r.status === "timeout"
      ? "I couldn't reach my memory in time. Try a narrower question."
      : r.status === "error"
        ? `Atlas hit an error: ${r.error ?? "unknown"}.`
        : r.status === "exhausted"
          ? "I ran out of retrieval steps without converging on an answer."
          : (fallbackMessage ?? "Something went wrong inside the persona.")

  const summary =
    `_events: ${toolCallCount(r.events)} calls · ` +
    `${(r.total_ms / 1000).toFixed(1)}s · status: ${r.status}_`
  return `${reason}\n\n---\n${summary}`
}

export function formatThrownError(message: string): string {
  return `Something went wrong inside the persona: ${message}\n\n---\n_status: thrown_`
}
