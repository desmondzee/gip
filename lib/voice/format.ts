/**
 * Three-layer cameo formatter (eng review per design D5).
 *
 * Renders the MCP cameo answer with two visually-distinct blockquote
 * sections — "What happened" (events memory) and "How I said it" (voice
 * exemplars from user-authored memory) — so a judge can see all three
 * layers in one frame:
 *
 *   1. Events memory (search) → "What happened" blockquotes
 *   2. Voice memory (search_voice) → "How I said it" blockquotes
 *   3. LoRA adapter (voicePhase) → the answer's actual cadence
 *
 * The summary line names the events sources, voice sources, and adapter id
 * so the rubric-completeness evidence is visible to any client that just
 * reads the markdown.
 *
 * Layered fallbacks (design premise 6):
 *   - voice section omitted when there are no voice exemplars
 *   - events section omitted when there are no event citations
 *   - adapter token reads "off" when PERSONA_LORA_ADAPTER unset
 */
import type { RunResult } from "../agent/loop"
import { voicerLabel } from "../agent/loop"
import type { SearchHit, TraceEvent } from "../schemas"
import { isUserAuthored } from "../agent/tools"
import { sanitizeText, safeTruncate } from "../util/sanitize"

const TOP_PER_SECTION = 3
const SNIPPET_CHARS = 120

function toolCallCount(events: TraceEvent[]): number {
  return events.filter((e) => e.type === "tool_call").length
}

function blockquote(c: SearchHit): string {
  const date = new Date(c.ts).toISOString().slice(0, 10)
  const snippet = safeTruncate(c.text, SNIPPET_CHARS).replace(/\n/g, " ")
  return `> _from your ${c.source} (${date}): "${snippet}..."_`
}

function renderSection(label: string, hits: SearchHit[]): string {
  if (hits.length === 0) return ""
  const lines = hits.slice(0, TOP_PER_SECTION).map(blockquote)
  return `**${label}**\n${lines.join("\n")}`
}

export function formatCameoAnswer(r: RunResult): string {
  const voice = r.citations.filter(isUserAuthored)
  const events = r.citations.filter((c) => !isUserAuthored(c))

  const eventsBlock = renderSection("What happened", events)
  const voiceBlock = renderSection("How I said it", voice)

  const eventSources = [...new Set(events.slice(0, TOP_PER_SECTION).map((c) => c.source))]
  const voiceSources = [...new Set(voice.slice(0, TOP_PER_SECTION).map((c) => c.source))]

  const summary =
    `_events: ${toolCallCount(r.events)} calls · ` +
    `${(r.total_ms / 1000).toFixed(1)}s · ` +
    `events=[${eventSources.join(", ") || "none"}] · ` +
    `voice=[${voiceSources.join(", ") || "none"}] · ` +
    `voicer=${voicerLabel()}_`

  const body = sanitizeText(r.answer)
  const sections = [eventsBlock, voiceBlock].filter(Boolean).join("\n\n")
  return sections
    ? `${body}\n\n${sections}\n\n---\n${summary}`
    : `${body}\n\n---\n${summary}`
}
