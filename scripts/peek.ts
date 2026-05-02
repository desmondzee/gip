import { memoriesOf, closeDb } from "../lib/db"

async function main() {
  const cal = await memoriesOf("calendar_events")

  console.log("=== CALENDAR — top recurring titles (last 12 mo) ===")
  const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
  const titles = await cal
    .aggregate([
      { $match: { ts: { $gte: since }, source: "calendar_events" } },
      {
        $project: {
          title: { $ifNull: ["$metadata.summary", "$text"] },
          ts: 1,
        },
      },
      { $group: { _id: "$title", n: { $sum: 1 }, last: { $max: "$ts" } } },
      { $sort: { n: -1 } },
      { $limit: 25 },
    ])
    .toArray()
  for (const t of titles) {
    if (!t._id) continue
    const last = t.last instanceof Date ? t.last.toISOString().slice(0, 10) : "?"
    console.log(`  ${String(t.n).padStart(3)}× ${last}  ${String(t._id).slice(0, 90)}`)
  }

  console.log("\n=== CALENDAR — upcoming next 14 days ===")
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  const upcoming = await cal
    .find({ ts: { $gte: new Date(), $lte: soon } })
    .sort({ ts: 1 })
    .limit(15)
    .toArray()
  for (const e of upcoming) {
    console.log(`  ${e.ts.toISOString().slice(0, 16)}  ${e.text.slice(0, 100)}`)
  }

  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
