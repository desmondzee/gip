import { Composio } from "@composio/core"
import { memoriesOf, closeDb, type SourceName } from "../lib/db"
import { embed } from "../lib/embeddings"
import type { Memory } from "../lib/schemas"

// ---------------------------------------------------------------------------
// Composio client (lazy singleton)
// ---------------------------------------------------------------------------

let _composio: Composio | null = null

function getComposio(): { client: Composio; userId: string } {
  const apiKey = process.env.COMPOSIO_API_KEY
  const userId = process.env.COMPOSIO_USER_ID
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in .env")
  if (!userId) throw new Error("COMPOSIO_USER_ID is not set in .env")
  if (!_composio) _composio = new Composio({ apiKey })
  return { client: _composio, userId }
}

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

export async function ingestGmailViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  // Fetch emails from the last 90 days — adjust the window with the `query` param
  const cutoffSec = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000)

  const result: any = await client.tools.execute("GMAIL_FETCH_EMAILS", {
    userId,
    arguments: {
      query: `after:${cutoffSec}`,
      max_results: 200,
      include_spam_trash: false,
    },
    dangerouslySkipVersionCheck: true,
  })

  const messages: any[] = result?.data?.messages ?? result?.messages ?? []

  return messages.map((msg: any) => ({
    external_id: `gmail_${msg.id ?? msg.messageId}`,
    ts: msg.internalDate
      ? new Date(Number(msg.internalDate))
      : new Date(msg.date ?? Date.now()),
    text: [msg.subject, msg.body ?? msg.snippet ?? ""].filter(Boolean).join("\n\n"),
    metadata: {
      from: msg.from ?? null,
      to: msg.to ?? null,
      subject: msg.subject ?? null,
      labels: msg.labelIds ?? msg.labels ?? [],
      snippet: msg.snippet ?? null,
      thread_id: msg.threadId ?? null,
    },
  }))
}

export async function ingestCalendarViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  // Past 12 months + next 3 months
  const timeMin = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
  const timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()

  const result: any = await client.tools.execute("GOOGLECALENDAR_EVENTS_LIST", {
    userId,
    arguments: {
      calendar_id: "primary",
      time_min: timeMin,
      time_max: timeMax,
      max_results: 500,
      single_events: true,
      order_by: "startTime",
    },
    dangerouslySkipVersionCheck: true,
  })

  const events: any[] = result?.data?.items ?? result?.items ?? []

  return events.map((evt: any) => ({
    external_id: `gcal_${evt.id}`,
    ts: new Date(evt.start?.dateTime ?? evt.start?.date ?? Date.now()),
    text: [evt.summary, evt.description].filter(Boolean).join("\n\n"),
    metadata: {
      summary: evt.summary ?? null,
      location: evt.location ?? null,
      attendees: (evt.attendees ?? []).map((a: any) => a.email),
      organizer: evt.organizer?.email ?? null,
      end: evt.end?.dateTime ?? evt.end?.date ?? null,
      status: evt.status ?? null,
      html_link: evt.htmlLink ?? null,
    },
  }))
}

export async function ingestSlackViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  // Step 1: list all joined channels
  const channelRes: any = await client.tools.execute("SLACK_LIST_CONVERSATIONS", {
    userId,
    arguments: {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    },
    dangerouslySkipVersionCheck: true,
  })

  const channels: any[] = channelRes?.data?.channels ?? channelRes?.channels ?? []

  // Step 2: fetch recent message history per channel (last 90 days)
  const oldestSec = String((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000)
  const items: RawItem[] = []

  for (const channel of channels) {
    try {
      const histRes: any = await client.tools.execute("SLACK_FETCH_CONVERSATION_HISTORY", {
        userId,
        arguments: {
          channel: channel.id,
          oldest: oldestSec,
          limit: 200,
        },
        dangerouslySkipVersionCheck: true,
      })

      const messages: any[] = histRes?.data?.messages ?? histRes?.messages ?? []

      for (const msg of messages) {
        if (!msg.text) continue
        items.push({
          external_id: `slack_${channel.id}_${msg.ts}`,
          ts: new Date(Number(msg.ts) * 1000),
          text: msg.text,
          metadata: {
            channel_id: channel.id,
            channel_name: channel.name ?? null,
            user: msg.user ?? null,
            thread_ts: msg.thread_ts ?? null,
          },
        })
      }
    } catch (err) {
      // A channel may be inaccessible (e.g., archived mid-run, missing scopes)
      console.warn(`[slack] skipped channel ${channel.name ?? channel.id}: ${err}`)
    }
  }

  return items
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
