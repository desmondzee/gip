import { ingest, getFetcher } from "@/scripts/ingest"
import { SOURCES, type SourceName } from "@/lib/db"
import { invalidateLayoutCache } from "@/app/api/persona/layout/route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const { source } = (await req.json()) as { source: string }

  if (!SOURCES.includes(source as SourceName)) {
    return Response.json({ error: `unknown source: ${source}` }, { status: 400 })
  }
  const fetcher = getFetcher(source as SourceName)

  try {
    const items = await fetcher()
    const result = await ingest(source as SourceName, items)
    if ((result.inserted ?? 0) > 0 || (result.updated ?? 0) > 0) {
      invalidateLayoutCache()
    }
    return Response.json({ source, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500 })
  }
}
