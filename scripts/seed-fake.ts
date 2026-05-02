import { ingest, type RawItem } from "./ingest"
import { closeDb, type SourceName } from "../lib/db"

const FAKE_DATA: Record<SourceName, RawItem[]> = {
  gmail_msgs: [
    {
      external_id: "gm-001",
      ts: new Date("2026-03-12T14:22:00Z"),
      text: "Subject: Re: dinner Friday — Maru is fine but honestly the omakase at Sushi Ginza Onodera was way better last time. Either way I'm in.",
      metadata: { from: "me", to: ["alex@example.com"], subject: "Re: dinner Friday", thread_id: "t1", from_user: true },
    },
    {
      external_id: "gm-002",
      ts: new Date("2026-04-02T09:10:00Z"),
      text: "Subject: Conference invite — RAG Summit 2026. Genuinely don't think these summits are useful, last one was 90% panel filler. Skipping.",
      metadata: { from: "me", to: ["org@ragsummit.example"], subject: "Re: RAG Summit", thread_id: "t2", from_user: true },
    },
    {
      external_id: "gm-003",
      ts: new Date("2026-02-18T19:45:00Z"),
      text: "Subject: Re: cookbook recommendation — I've been cooking from Salt Fat Acid Heat for two years and it's still my favorite. Everything else feels like a downgrade.",
      metadata: { from: "me", to: ["mom@example.com"], subject: "Re: cookbook", thread_id: "t3", from_user: true },
    },
  ],
  slack_msgs: [
    {
      external_id: "sl-001",
      ts: new Date("2026-04-15T11:32:00Z"),
      text: "ugh that bagel place on 3rd is so overrated, lukewarm coffee and the lox tasted like it sat out",
      metadata: { channel: "#food", author: "me", from_user: true },
    },
    {
      external_id: "sl-002",
      ts: new Date("2026-03-28T16:01:00Z"),
      text: "honestly the new claude tool use just works, switched off the langchain agent entirely and latency dropped 40%",
      metadata: { channel: "#eng", author: "me", from_user: true },
    },
    {
      external_id: "sl-003",
      ts: new Date("2026-04-22T22:14:00Z"),
      text: "watched dune part 2 again, denis villeneuve is now my favorite working director, it's not even close",
      metadata: { channel: "#random", author: "me", from_user: true },
    },
    {
      external_id: "sl-004",
      ts: new Date("2026-04-25T08:30:00Z"),
      text: "if i have one more 4-person standup that could've been a slack message i'm going to lose it",
      metadata: { channel: "#vent", author: "me", from_user: true },
    },
  ],
  calendar_events: [
    {
      external_id: "cal-001",
      ts: new Date("2026-05-05T18:00:00Z"),
      text: "Coffee with Sam — Blue Bottle SoMa, 30 min",
      metadata: { location: "Blue Bottle SoMa", attendees: ["sam@example.com", "me"] },
    },
    {
      external_id: "cal-002",
      ts: new Date("2026-04-30T15:00:00Z"),
      text: "Engineering all-hands — quarterly review, 60 min",
      metadata: { location: "HQ", attendees: ["all@example.com", "me"] },
    },
  ],
  notion_docs: [
    {
      external_id: "nt-001",
      ts: new Date("2026-01-04T10:00:00Z"),
      text: "2026 Goals\n\n- Ship one independent project per quarter\n- Read more fiction (last year was too much non-fiction)\n- Cook at home 4 nights a week\n- Stop saying yes to coffee chats by default",
      metadata: { title: "2026 Goals", from_user: true },
    },
  ],
  github_activity: [
    {
      external_id: "gh-001",
      ts: new Date("2026-04-10T20:15:00Z"),
      text: "Commit: refactor: drop langchain in favor of native anthropic SDK — agent loop is now 200 lines instead of 600, latency down ~40%",
      metadata: { repo: "personal/persona", author: "me", from_user: true },
    },
  ],
  maps_history: [
    {
      external_id: "mp-001",
      ts: new Date("2026-04-15T11:00:00Z"),
      text: "Visited Bagel Empire, 3rd Ave — 1 visit",
      metadata: { place: "Bagel Empire", address: "3rd Ave" },
    },
  ],
  photos_meta: [
    {
      external_id: "ph-001",
      ts: new Date("2026-03-12T20:00:00Z"),
      text: "Photo: dinner at Sushi Ginza Onodera, omakase plate, well-lit",
      metadata: { place: "Sushi Ginza Onodera", caption: "omakase" },
    },
  ],
}

async function main() {
  const arg = process.argv[2]
  const sources = arg ? [arg as SourceName] : (Object.keys(FAKE_DATA) as SourceName[])

  for (const source of sources) {
    const items = FAKE_DATA[source]
    if (!items) {
      console.warn(`No fake data for ${source}, skipping.`)
      continue
    }
    const res = await ingest(source, items)
    console.log(`[${source}] seeded: ${res.inserted} inserted, ${res.updated} updated`)
  }

  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
