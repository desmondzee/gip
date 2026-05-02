import { SOURCES, type SourceName } from "../db"
import { search } from "../atlas-search"
import type { SearchHit, ToolName } from "../schemas"

export const TOOL_DEFS = [
  {
    name: "search",
    description:
      "Search one source collection. Use vector for semantic intent, text for exact phrases or names, hybrid when in doubt. Call this first. Call again with refined queries if first results are weak. Different sources reveal different aspects (Gmail = explicit statements, Slack = casual reactions, Calendar = time/place context, Notion = structured notes, GitHub = work patterns, Maps = location/recency, Photos = scenes/people).",
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
      },
      required: ["collection", "query"],
    },
  },
  {
    name: "rerank",
    description:
      "Reorder a list of results by a different criterion. Use after search when the user is asking about a temporal pattern (recency), about emotional content (sentiment), or about authorship (authorship).",
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
      const hits = await search({ source: collection, query, k, mode })
      rememberHits(hits)
      const summary =
        hits.length === 0
          ? `0 hits for "${query}" in ${collection}`
          : `${hits.length} hits in ${collection} (${mode}). Top: ${hits
              .slice(0, 3)
              .map((h) => `[id=${h._id}] ${truncate(h.text, 80)} (score=${h.score.toFixed(3)})`)
              .join(" · ")}`
      return { summary, raw: hits, hits }
    }
    case "rerank": {
      const ids = args.result_ids as string[]
      const criterion = args.criterion as string
      const items = recallHits(ids)
      const reordered = rerankHits(items, criterion)
      const summary =
        reordered.length === 0
          ? `Reranked 0 items by ${criterion} — none of the supplied result_ids were in cache. Run search again first.`
          : `Reranked ${reordered.length} items by ${criterion}. New order: ${reordered
              .slice(0, 5)
              .map((h) => `[id=${h._id}]`)
              .join(", ")}`
      return { summary, raw: reordered.map((h) => h._id), hits: reordered }
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
      return { summary, raw: matched.map((h) => h._id), hits: matched }
    }
    case "summarize_for_answer": {
      const ids = args.result_ids as string[]
      const answer = args.answer as string
      return {
        summary: `FINAL: ${truncate(answer, 120)} (${ids.length} citations)`,
        raw: { answer, citation_ids: ids, citations: recallHits(ids) },
      }
    }
  }
}

function rerankHits(hits: SearchHit[], criterion: string): SearchHit[] {
  const arr = [...hits]
  switch (criterion) {
    case "recency":
      return arr.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    case "relevance":
      return arr.sort((a, b) => b.score - a.score)
    case "sentiment_negative":
      return arr.sort((a, b) => sentimentScore(b.text) - sentimentScore(a.text))
    case "sentiment_positive":
      return arr.sort((a, b) => -sentimentScore(b.text) + sentimentScore(a.text))
    case "authorship_user":
      return arr.sort((a, b) => Number(isUserAuthored(b)) - Number(isUserAuthored(a)))
    default:
      return arr
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
