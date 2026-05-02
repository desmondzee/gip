import { ingest, ingestGmailViaComposio, ingestCalendarViaComposio, ingestSlackViaComposio } from "@/scripts/ingest"
import type { SourceName } from "@/lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const FETCHERS: Record<string, () => Promise<any[]>> = {
  gmail_msgs: ingestGmailViaComposio,
  calendar_events: ingestCalendarViaComposio,
  slack_msgs: ingestSlackViaComposio,
}

export async function POST(req: Request) {
  const { source } = (await req.json()) as { source: string }

  const fetcher = FETCHERS[source]
  if (!fetcher) {
    return Response.json({ error: `unknown source: ${source}` }, { status: 400 })
  }

  try {
    const items = await fetcher()
    const result = await ingest(source as SourceName, items)
    return Response.json({ source, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500 })
  }
}
