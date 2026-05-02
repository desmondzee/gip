import { SOURCES, memoriesOf, type SourceName } from "@/lib/db"
import { pca2D } from "@/lib/projection"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Sources to omit from the visualization (still ingested + searchable; just
// hidden in the scatter so they don't dominate or distort the projection).
const HIDDEN_SOURCES = new Set<SourceName>(["notion_docs"])

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export interface VectorPoint {
  id: string
  source: SourceName
  x: number
  y: number
  ts: string
  preview: string
}

export interface VectorLayout {
  points: VectorPoint[]
  generated_at: string
  count_by_source: Record<string, number>
}

let _cache: VectorLayout | null = null
let _building: Promise<VectorLayout> | null = null

export function invalidateLayoutCache(): void {
  _cache = null
  _building = null
}

async function buildLayout(): Promise<VectorLayout> {
  const ids: string[] = []
  const sources: SourceName[] = []
  const tss: Date[] = []
  const previews: string[] = []
  const embeddings: number[][] = []

  for (const source of SOURCES) {
    if (HIDDEN_SOURCES.has(source)) continue
    const col = await memoriesOf(source)
    const cursor = col.find(
      { embedding: { $exists: true } },
      { projection: { _id: 1, ts: 1, text: 1, embedding: 1 } },
    )
    const docs = await cursor.toArray()
    for (const d of docs) {
      const e = d.embedding
      if (!Array.isArray(e) || e.length === 0) continue
      ids.push(String(d._id))
      sources.push(source)
      tss.push(d.ts ?? new Date(0))
      previews.push(typeof d.text === "string" ? d.text.slice(0, 140) : "")
      embeddings.push(e as number[])
    }
  }

  const N = embeddings.length

  // Build a balanced fit set: cap each source's contribution to PCA so a
  // bulky-but-similar source (e.g. 500 near-duplicate Drive docs) can't yank
  // the principal axes toward itself.
  const FIT_PER_SOURCE = 60
  const perSource: Record<string, number> = {}
  const fitIndices: number[] = []
  for (let i = 0; i < N; i++) {
    const s = sources[i]!
    const c = perSource[s] ?? 0
    if (c < FIT_PER_SOURCE) {
      fitIndices.push(i)
      perSource[s] = c + 1
    }
  }
  const xy = N >= 2 ? pca2D(embeddings, fitIndices) : new Float32Array(N * 2)

  // For N < 2 lay out trivially.
  if (N === 1) {
    xy[0] = 0
    xy[1] = 0
  }

  // Per-source jitter for clusters that PCA collapses to a single point or
  // line (e.g. Instagram's 46 near-duplicate embeddings all landing at x=0.99).
  // We give each such cluster a small disk around its centroid so individual
  // points are visible and can be selected/highlighted.
  const sourceIdx: Record<string, number[]> = {}
  for (let i = 0; i < N; i++) {
    const s = sources[i]!
    ;(sourceIdx[s] ??= []).push(i)
  }
  const MIN_STD = 0.05
  const JITTER_SCALE = 0.08
  for (const idxs of Object.values(sourceIdx)) {
    if (idxs.length < 3) continue
    let sumX = 0
    let sumY = 0
    for (const i of idxs) {
      sumX += xy[i * 2]!
      sumY += xy[i * 2 + 1]!
    }
    const cx = sumX / idxs.length
    const cy = sumY / idxs.length
    let varX = 0
    let varY = 0
    for (const i of idxs) {
      const dx = xy[i * 2]! - cx
      const dy = xy[i * 2 + 1]! - cy
      varX += dx * dx
      varY += dy * dy
    }
    const sx = Math.sqrt(varX / idxs.length)
    const sy = Math.sqrt(varY / idxs.length)
    const needX = sx < MIN_STD
    const needY = sy < MIN_STD
    if (!needX && !needY) continue
    for (const i of idxs) {
      // Stable pseudo-random offsets keyed on row index (deterministic across
      // rebuilds for the same dataset, so points don't visually flicker).
      const ra = Math.sin(i * 12.9898 + 78.233) * 43758.5453
      const rb = Math.sin(i * 39.346 + 12.8) * 23758.5453
      const ja = (ra - Math.floor(ra)) * 2 - 1
      const jb = (rb - Math.floor(rb)) * 2 - 1
      if (needX) xy[i * 2] = clamp(xy[i * 2]! + ja * JITTER_SCALE, -1, 1)
      if (needY) xy[i * 2 + 1] = clamp(xy[i * 2 + 1]! + jb * JITTER_SCALE, -1, 1)
    }
  }

  const points: VectorPoint[] = ids.map((id, i) => ({
    id,
    source: sources[i]!,
    x: xy[i * 2]!,
    y: xy[i * 2 + 1]!,
    ts: tss[i]!.toISOString(),
    preview: previews[i]!,
  }))

  const count_by_source: Record<string, number> = {}
  for (const p of points) {
    count_by_source[p.source] = (count_by_source[p.source] ?? 0) + 1
  }

  return {
    points,
    generated_at: new Date().toISOString(),
    count_by_source,
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const force = url.searchParams.get("rebuild") === "1"

  if (force) {
    _cache = null
    _building = null
  }

  if (!_cache) {
    if (!_building) _building = buildLayout()
    _cache = await _building
    _building = null
  }

  return new Response(JSON.stringify(_cache), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
}
