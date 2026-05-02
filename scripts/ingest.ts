import { memoriesOf, closeDb, type SourceName } from "../lib/db"
import { embed } from "../lib/embeddings"
import type { Memory } from "../lib/schemas"

export interface RawItem {
  external_id: string
  ts: Date
  text: string
  metadata: Record<string, unknown>
}

export async function ingest(source: SourceName, items: RawItem[]): Promise<{ inserted: number; updated: number }> {
  if (items.length === 0) return { inserted: 0, updated: 0 }
  const col = await memoriesOf(source)

  const ops = []
  for (const item of items) {
    const embedding = await embed(item.text)
    const doc: Memory = {
      source,
      external_id: item.external_id,
      ts: item.ts,
      text: item.text,
      embedding,
      metadata: item.metadata,
      ingested_at: new Date(),
    }
    ops.push({
      updateOne: {
        filter: { external_id: item.external_id },
        update: { $set: doc },
        upsert: true,
      },
    })
  }

  const res = await col.bulkWrite(ops, { ordered: false })
  return {
    inserted: res.upsertedCount ?? 0,
    updated: res.modifiedCount ?? 0,
  }
}

async function ingestGmailViaComposio(): Promise<RawItem[]> {
  console.warn("ingestGmailViaComposio: implement using Composio when key is ready")
  return []
}

async function ingestCalendarViaComposio(): Promise<RawItem[]> {
  console.warn("ingestCalendarViaComposio: implement using Composio when key is ready")
  return []
}

async function ingestSlackViaComposio(): Promise<RawItem[]> {
  console.warn("ingestSlackViaComposio: implement using Composio when key is ready")
  return []
}

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error("Usage: bun scripts/ingest.ts <source>")
    console.error(`Sources: gmail_msgs, calendar_events, slack_msgs, notion_docs, github_activity, maps_history, photos_meta`)
    process.exit(1)
  }

  let items: RawItem[] = []
  switch (arg) {
    case "gmail_msgs":
      items = await ingestGmailViaComposio()
      break
    case "calendar_events":
      items = await ingestCalendarViaComposio()
      break
    case "slack_msgs":
      items = await ingestSlackViaComposio()
      break
    default:
      console.error(`Source ${arg} not yet wired. Add a fetcher.`)
      process.exit(1)
  }

  const res = await ingest(arg as SourceName, items)
  console.log(`[${arg}] ingested: ${res.inserted} new, ${res.updated} updated`)
  await closeDb()
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
