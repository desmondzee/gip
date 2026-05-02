import { getDb, SOURCES, closeDb } from "../lib/db"

async function main() {
  const db = await getDb()
  console.log(`DB: ${db.databaseName}\n`)

  let total = 0
  for (const source of SOURCES) {
    const col = db.collection(source)
    const count = await col.countDocuments()
    total += count

    if (count === 0) {
      console.log(`[${source.padEnd(18)}] 0 docs`)
      continue
    }

    const sample = await col.find({}).sort({ ingested_at: -1 }).limit(3).toArray()
    const oldest = await col.find({}).sort({ ts: 1 }).limit(1).toArray()
    const newest = await col.find({}).sort({ ts: -1 }).limit(1).toArray()
    const lastIngest = await col.find({}).sort({ ingested_at: -1 }).limit(1).toArray()

    const tsRange =
      oldest[0] && newest[0]
        ? `${oldest[0].ts.toISOString().slice(0, 10)} → ${newest[0].ts.toISOString().slice(0, 10)}`
        : "?"
    const lastIng = lastIngest[0]?.ingested_at?.toISOString?.() ?? "?"

    console.log(`[${source.padEnd(18)}] ${count.toString().padStart(4)} docs · range ${tsRange} · last ingest ${lastIng}`)
    for (const s of sample) {
      const text = (s.text ?? "").replace(/\s+/g, " ").slice(0, 100)
      console.log(`    [${s.external_id}] ${text}`)
    }
  }

  console.log(`\nTOTAL: ${total} docs across ${SOURCES.length} collections`)
  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
