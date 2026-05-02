import { memoriesOf, type SourceName } from "./db"
import { embedQuery } from "./embeddings"
import type { SearchHit } from "./schemas"

export interface SearchOpts {
  source: SourceName
  query: string
  k?: number
  mode?: "vector" | "text" | "hybrid"
  filter?: Record<string, unknown>
}

const VECTOR_INDEX_SUFFIX = "_vector_index"
const TEXT_INDEX_SUFFIX = "_text_index"

export async function search(opts: SearchOpts): Promise<SearchHit[]> {
  const { source, query, k = 8, mode = "hybrid", filter } = opts
  const col = await memoriesOf(source)

  if (mode === "vector" || mode === "hybrid") {
    const queryVec = await embedQuery(query)

    const vectorPipeline: Record<string, unknown>[] = [
      {
        $vectorSearch: {
          index: `${source}${VECTOR_INDEX_SUFFIX}`,
          path: "embedding",
          queryVector: queryVec,
          numCandidates: Math.max(k * 10, 50),
          limit: k,
          ...(filter ? { filter } : {}),
        },
      },
      {
        $project: {
          _id: 1,
          source: 1,
          external_id: 1,
          ts: 1,
          text: 1,
          metadata: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ]

    const vectorHits = await col.aggregate(vectorPipeline).toArray()
    const vectorMapped: SearchHit[] = vectorHits.map((d) => ({
      _id: String(d._id),
      source,
      external_id: d.external_id,
      ts: d.ts,
      text: d.text,
      metadata: d.metadata ?? {},
      score: d.score,
      match_kind: "vector",
    }))

    if (mode === "vector") return vectorMapped

    const textHits = await runTextSearch(source, query, k, filter)
    return reciprocalRankFusion(vectorMapped, textHits, k)
  }

  return runTextSearch(source, query, k, filter)
}

async function runTextSearch(
  source: SourceName,
  query: string,
  k: number,
  filter: Record<string, unknown> | undefined,
): Promise<SearchHit[]> {
  const col = await memoriesOf(source)
  const pipeline: Record<string, unknown>[] = [
    {
      $search: {
        index: `${source}${TEXT_INDEX_SUFFIX}`,
        text: { query, path: "text" },
      },
    },
    ...(filter ? [{ $match: filter }] : []),
    { $limit: k },
    {
      $project: {
        _id: 1,
        source: 1,
        external_id: 1,
        ts: 1,
        text: 1,
        metadata: 1,
        score: { $meta: "searchScore" },
      },
    },
  ]
  const hits = await col.aggregate(pipeline).toArray()
  return hits.map((d) => ({
    _id: String(d._id),
    source,
    external_id: d.external_id,
    ts: d.ts,
    text: d.text,
    metadata: d.metadata ?? {},
    score: d.score,
    match_kind: "text",
  }))
}

function reciprocalRankFusion(
  a: SearchHit[],
  b: SearchHit[],
  k: number,
): SearchHit[] {
  const C = 60
  const fused = new Map<string, SearchHit & { fused: number }>()
  for (const list of [a, b]) {
    list.forEach((hit, i) => {
      const score = 1 / (C + i)
      const existing = fused.get(hit._id)
      if (existing) {
        existing.fused += score
      } else {
        fused.set(hit._id, { ...hit, fused: score, match_kind: "hybrid" })
      }
    })
  }
  return Array.from(fused.values())
    .sort((x, y) => y.fused - x.fused)
    .slice(0, k)
    .map(({ fused: _f, ...rest }) => rest)
}
