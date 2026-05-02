import { SOURCES, type SourceName } from "../db"
import { search } from "../atlas-search"
import { llmRerank } from "../rerank"
import type { SearchHit, ToolName } from "../schemas"

export const TOOL_DEFS = [
  {
    name: "search",
    description:
      "Search one source collection. Use vector for semantic intent, text for exact phrases or names, hybrid when in doubt. Call this first. Call again with refined queries if first results are weak. Different sources reveal different aspects (Gmail = explicit statements, Slack = casual reactions, Calendar = time/place context, Notion = structured notes, GitHub = work patterns/code activity, Drive/Docs/Sheets = saved files and longer-form writing, LinkedIn = professional identity, YouTube = subscriptions and playlists revealing taste, Discord = communities the user belongs to, Maps = location/recency, Photos = scenes/people).",
    input_schema: {
      type: "object" as const,
      properties: {
        collection: {
          type: "string",
          enum: SOURCES as unknown as string[],
          description: "Which source collection to search.",
        },
        query: {
          type: "string",
          description:
            "The search query. Rewrite the user question into the language likely to be in this source (e.g. for Slack, casual fragments; for Gmail, formal phrases or sender names).",
        },
        k: {
          type: "number",
          description: "How many results to return. Default 8. Use smaller (3-5) when narrowing.",
        },
        mode: {
          type: "string",
          enum: ["vector", "text", "hybrid"],
          description:
            "vector = semantic similarity, text = lexical match, hybrid = both with rank fusion. Default hybrid.",
        },
        filter: {
          type: "object",
          description:
            "Optional MongoDB match filter applied after retrieval. Useful keys: metadata.from, metadata.to, metadata.attendees, metadata.location, metadata.channel_name, metadata.author. Example: {\"metadata.from\": \"alice@example.com\"}. Use sparingly — only when the question implies a hard constraint.",
          additionalProperties: true,
        },
      },
      required: ["collection", "query"],
    },
  },
  {
    name: "rerank",
    description:
      "Reorder a list of results by a different criterion. Use after search when the user is asking about a temporal pattern (recency), about emotional content (sentiment), or about authorship (authorship). For 'relevance', pass the most specific phrasing of the question as `query` — a small LLM cross-encoder will re-score every candidate against it.",
    input_schema: {
      type: "object" as const,
      properties: {
        result_ids: {
          type: "array",
          items: { type: "string" },
          description: "The _id values of the results to rerank, in their current order.",
        },
        criterion: {
          type: "string",
          enum: ["recency", "relevance", "sentiment_negative", "sentiment_positive", "authorship_user"],
        },
        query: {
          type: "string",
          description:
            "Required when criterion='relevance'. The most specific phrasing of what the user actually wants — used as the reranker's reference point.",
        },
      },
      required: ["result_ids", "criterion"],
    },
  },
  {
    name: "rechunk",
    description:
      "Re-split a single document into different-shaped chunks. Use when a search hit is long and you need a sub-section, or when sentence-level granularity matters (voice questions).",
    input_schema: {
      type: "object" as const,
      properties: {
        doc_id: { type: "string", description: "The _id of the document to rechunk." },
        mode: {
          type: "string",
          enum: ["semantic", "window", "sentence"],
          description: "semantic = paragraph-aware; window = fixed token windows; sentence = one per sentence.",
        },
      },
      required: ["doc_id", "mode"],
    },
  },
  {
    name: "cross_reference",
    description:
      "Find documents in result set A that share a property with documents in result set B (same person mentioned, same place, same time window, same topic). Use to triangulate evidence across sources.",
    input_schema: {
      type: "object" as const,
      properties: {
        result_ids_a: { type: "array", items: { type: "string" } },
        result_ids_b: { type: "array", items: { type: "string" } },
        on: {
          type: "string",
          enum: ["person", "place", "time_window", "topic"],
        },
      },
      required: ["result_ids_a", "result_ids_b", "on"],
    },
  },
  {
    name: "summarize_for_answer",
    description:
      "Terminating tool. Call this last with the result_ids you used as evidence. Returns the answer and the citation list for the trace. Do not call any other tool after this.",
    input_schema: {
      type: "object" as const,
      properties: {
        result_ids: {
          type: "array",
          items: { type: "string" },
          description: "Result _ids that justify the answer.",
        },
        answer: {
          type: "string",
          description: "The answer in the user's voice — first person, plausibly from the user.",
        },
      },
      required: ["result_ids", "answer"],
    },
  },
]

const memoryCache = new Map<string, SearchHit>()

export function rememberHits(hits: SearchHit[]): void {
  for (const h of hits) memoryCache.set(h._id, h)
}

export function recallHits(ids: string[]): SearchHit[] {
  const out: SearchHit[] = []
  for (const id of ids) {
    const direct = memoryCache.get(id)
    if (direct) {
      out.push(direct)
      continue
    }
    for (const [k, v] of memoryCache) {
      if (k.endsWith(id) || id.endsWith(k)) {
        out.push(v)
        break
      }
    }
  }
  return out
}

export function clearMemoryCache(): void {
  memoryCache.clear()
}

export interface ToolDispatchResult {
  summary: string
  raw: unknown
  hits?: SearchHit[]
  hit_ids?: string[]
}

export async function dispatchTool(
  name: ToolName,
  args: Record<string, unknown>,
): Promise<ToolDispatchResult> {
  switch (name) {
    case "search": {
      const collection = args.collection as SourceName
      const query = args.query as string
      const k = (args.k as number | undefined) ?? 8
      const mode = (args.mode as "vector" | "text" | "hybrid" | undefined) ?? "hybrid"
      const filter = args.filter as Record<string, unknown> | undefined
      const hits = await search({ source: collection, query, k, mode, filter })
      rememberHits(hits)
      const summary =
        hits.length === 0
          ? `0 hits for "${query}" in ${collection}`
          : `${hits.length} hits in ${collection} (${mode}). Top: ${hits
              .slice(0, 3)
              .map((h) => `[id=${h._id}] ${truncate(h.text, 80)} (score=${h.score.toFixed(3)})`)
              .join(" · ")}`
      return { summary, raw: hits, hits, hit_ids: hits.map((h) => h._id) }
    }
    case "rerank": {
      const ids = args.result_ids as string[]
      const criterion = args.criterion as string
      const query = args.query as string | undefined
      const items = recallHits(ids)
      let reordered: SearchHit[]
      let kindLabel = criterion
      if (criterion === "relevance" && query && items.length > 1) {
        const reranked = await llmRerank(query, items)
        reordered = reranked.map((h) => ({ ...h, score: h.rerank_score ?? h.score }))
        kindLabel = "relevance (LLM cross-encoder)"
      } else {
        reordered = rerankHits(items, criterion)
      }
      const summary =
        reordered.length === 0
          ? `Reranked 0 items by ${criterion} — none of the supplied result_ids were in cache. Run search again first.`
          : `Reranked ${reordered.length} items by ${kindLabel}. New order: ${reordered
              .slice(0, 5)
              .map((h) => `[id=${h._id}] score=${h.score.toFixed(2)}`)
              .join(", ")}`
      // Refresh cache so subsequent recallHits() sees the rerank score on `h.score`.
      rememberHits(reordered)
      return { summary, raw: reordered.map((h) => h._id), hits: reordered, hit_ids: reordered.map((h) => h._id) }
    }
    case "rechunk": {
      const docId = args.doc_id as string
      const mode = args.mode as "semantic" | "window" | "sentence"
      const hit = memoryCache.get(docId)
      if (!hit) return { summary: `doc_id ${docId} not in cache`, raw: null }
      const chunks = chunkText(hit.text, mode)
      const summary = `Split [id=${docId}] into ${chunks.length} ${mode} chunks. First: "${truncate(chunks[0] ?? "", 80)}"`
      return { summary, raw: chunks }
    }
    case "cross_reference": {
      const a = recallHits(args.result_ids_a as string[])
      const b = recallHits(args.result_ids_b as string[])
      const on = args.on as "person" | "place" | "time_window" | "topic"
      const matched = crossReferenceHits(a, b, on)
      const summary =
        matched.length === 0
          ? `No cross-reference matches on ${on}`
          : `${matched.length} cross-ref matches on ${on}: ${matched
              .slice(0, 3)
              .map((h) => `[id=${h._id}]`)
              .join(", ")}`
      return { summary, raw: matched.map((h) => h._id), hits: matched, hit_ids: matched.map((h) => h._id) }
    }
    case "summarize_for_answer": {
      const ids = args.result_ids as string[]
      const answer = args.answer as string
      return {
        summary: `FINAL: ${truncate(answer, 120)} (${ids.length} citations)`,
        raw: { answer, citation_ids: ids, citations: recallHits(ids) },
        hit_ids: ids,
      }
    }
  }
}

// Each rerank criterion produces a fresh `score` on a 0..1 scale that reflects
// the criterion itself — so bar charts in the trace always agree with row order.
function rerankHits(hits: SearchHit[], criterion: string): SearchHit[] {
  if (hits.length === 0) return hits
  switch (criterion) {
    case "recency": {
      const times = hits.map((h) => new Date(h.ts).getTime())
      const newest = Math.max(...times)
      const oldest = Math.min(...times)
      const span = Math.max(newest - oldest, 1)
      return hits
        .map((h) => ({ ...h, score: (new Date(h.ts).getTime() - oldest) / span }))
        .sort((a, b) => b.score - a.score)
    }
    case "relevance":
      // Heuristic fallback (no LLM query): keep the underlying retrieval score.
      return [...hits].sort((a, b) => b.score - a.score)
    case "sentiment_negative":
      return hits
        .map((h) => ({ ...h, score: Math.max(0, sentimentScore(h.text)) }))
        .sort((a, b) => b.score - a.score)
    case "sentiment_positive":
      return hits
        .map((h) => ({ ...h, score: Math.max(0, -sentimentScore(h.text)) }))
        .sort((a, b) => b.score - a.score)
    case "authorship_user":
      return hits
        .map((h) => ({ ...h, score: isUserAuthored(h) ? 1 : 0 }))
        .sort((a, b) => b.score - a.score)
    default:
      return [...hits]
  }
}

const NEG_TOKENS = ["hate", "annoyed", "frustrated", "ugh", "terrible", "awful", "nope", "skip", "boring", "not great", "didn't like"]
const POS_TOKENS = ["love", "great", "amazing", "fantastic", "perfect", "wonderful", "yes", "absolutely", "favorite"]

function sentimentScore(text: string): number {
  const lower = text.toLowerCase()
  let neg = 0
  let pos = 0
  for (const tok of NEG_TOKENS) if (lower.includes(tok)) neg++
  for (const tok of POS_TOKENS) if (lower.includes(tok)) pos++
  return neg - pos
}

function isUserAuthored(hit: SearchHit): boolean {
  const md = hit.metadata as Record<string, unknown>
  if (md.from_user === true) return true
  if (md.author === "me") return true
  return false
}

function chunkText(text: string, mode: "semantic" | "window" | "sentence"): string[] {
  if (mode === "sentence") {
    return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)
  }
  if (mode === "window") {
    const words = text.split(/\s+/)
    const chunks: string[] = []
    const size = 50
    for (let i = 0; i < words.length; i += size) {
      chunks.push(words.slice(i, i + size).join(" "))
    }
    return chunks
  }
  return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0)
}

function crossReferenceHits(a: SearchHit[], b: SearchHit[], on: string): SearchHit[] {
  const tokenize = (h: SearchHit): Set<string> => {
    const md = h.metadata as Record<string, unknown>
    switch (on) {
      case "person": {
        const set = new Set<string>()
        const candidates = [md.from, md.to, md.author, md.attendees, md.participants]
        for (const c of candidates) {
          if (typeof c === "string") set.add(c.toLowerCase())
          else if (Array.isArray(c)) for (const x of c) if (typeof x === "string") set.add(x.toLowerCase())
        }
        return set
      }
      case "place": {
        const set = new Set<string>()
        for (const k of ["location", "place", "address", "venue"] as const) {
          const v = md[k]
          if (typeof v === "string") set.add(v.toLowerCase())
        }
        return set
      }
      case "time_window": {
        const day = new Date(h.ts).toISOString().slice(0, 10)
        return new Set([day])
      }
      case "topic": {
        return new Set(h.text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [])
      }
      default:
        return new Set()
    }
  }

  const matches: SearchHit[] = []
  for (const ha of a) {
    const ta = tokenize(ha)
    for (const hb of b) {
      const tb = tokenize(hb)
      for (const t of ta) {
        if (tb.has(t)) {
          matches.push(ha)
          break
        }
      }
    }
  }
  return matches
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}
