import Anthropic from "@anthropic-ai/sdk"
import type { SearchHit } from "./schemas"

const RERANK_MODEL = process.env.ANTHROPIC_RERANK_MODEL ?? "claude-haiku-4-5"
const PREVIEW_CHARS = 220

let _client: Anthropic | null = null
function client(): Anthropic {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set")
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export interface RerankedHit extends SearchHit {
  rerank_score?: number
}

export async function llmRerank(query: string, hits: SearchHit[]): Promise<RerankedHit[]> {
  if (hits.length <= 1) return hits
  const indexed = hits.map((h, i) => ({
    idx: i,
    id: h._id,
    src: h.source,
    text: h.text.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim(),
  }))

  const prompt = `Score each candidate 0-10 for how well it answers the QUERY. 10 = directly answers. 5 = related context. 0 = irrelevant.

QUERY: ${query}

CANDIDATES:
${indexed.map((c) => `[${c.idx}] (${c.src}) ${c.text}`).join("\n")}

Reply with ONLY a JSON array, one object per candidate: [{"idx": 0, "score": <0-10>}, ...]. Include every candidate. No prose.`

  try {
    const res = await client().messages.create({
      model: RERANK_MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    })
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) return fallback(hits)
    const parsed = JSON.parse(match[0]) as { idx?: number; score?: number }[]
    const scoreByIdx = new Map<number, number>()
    for (const item of parsed) {
      if (typeof item.idx === "number" && typeof item.score === "number") {
        scoreByIdx.set(item.idx, item.score)
      }
    }
    if (scoreByIdx.size === 0) return fallback(hits)
    return hits
      .map((h, i) => ({ ...h, rerank_score: scoreByIdx.get(i) ?? 0 }))
      .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0))
  } catch {
    return fallback(hits)
  }
}

function fallback(hits: SearchHit[]): RerankedHit[] {
  return [...hits].sort((a, b) => b.score - a.score)
}
