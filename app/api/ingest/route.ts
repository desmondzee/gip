<<<<<<< Updated upstream
import { ingest, getFetcher } from "@/scripts/ingest"
import { SOURCES, type SourceName } from "@/lib/db"
import { invalidateLayoutCache } from "@/app/api/persona/layout/route"
=======
import {
  ingest,
  ingestGmailViaComposio,
  ingestCalendarViaComposio,
  ingestSlackViaComposio,
  ingestGithubViaComposio,
  ingestNotionViaComposio,
  ingestSheetsViaComposio,
  ingestOutlookViaComposio,
  ingestDriveViaComposio,
  ingestDocsViaComposio,
  ingestYoutubeViaComposio,
  ingestDiscordViaComposio,
  ingestLinkedinViaComposio,
  ingestInstagramViaComposio,
} from "@/scripts/ingest"
import type { SourceName } from "@/lib/db"
>>>>>>> Stashed changes

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

<<<<<<< Updated upstream
=======
const FETCHERS: Record<string, () => Promise<any[]>> = {
  gmail_msgs: ingestGmailViaComposio,
  calendar_events: ingestCalendarViaComposio,
  slack_msgs: ingestSlackViaComposio,
  github_activity: ingestGithubViaComposio,
  notion_docs: ingestNotionViaComposio,
  sheets_data: ingestSheetsViaComposio,
  outlook_msgs: ingestOutlookViaComposio,
  drive_files: ingestDriveViaComposio,
  docs_content: ingestDocsViaComposio,
  youtube_history: ingestYoutubeViaComposio,
  discord_msgs: ingestDiscordViaComposio,
  linkedin_activity: ingestLinkedinViaComposio,
  instagram_posts: ingestInstagramViaComposio,
}

>>>>>>> Stashed changes
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
