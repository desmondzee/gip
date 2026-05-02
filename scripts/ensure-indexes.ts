import { getDb, SOURCES, closeDb } from "../lib/db"
import { EMBED_DIM } from "../lib/embeddings"

async function main() {
  const db = await getDb()
  console.log(`Ensuring indexes in DB: ${db.databaseName}`)

  for (const source of SOURCES) {
    const col = db.collection(source)

    await col.createIndex({ external_id: 1 }, { unique: true })
    await col.createIndex({ ts: -1 })
    console.log(`[${source}] standard indexes ok`)

    const vectorIndexName = `${source}_vector_index`
    const textIndexName = `${source}_text_index`

    try {
      const existing = await col.listSearchIndexes().toArray()
      const haveVector = existing.some((i) => i.name === vectorIndexName)
      const haveText = existing.some((i) => i.name === textIndexName)

      if (!haveVector) {
        await col.createSearchIndex({
          name: vectorIndexName,
          type: "vectorSearch",
          definition: {
            fields: [
              {
                type: "vector",
                path: "embedding",
                numDimensions: EMBED_DIM,
                similarity: "cosine",
              },
              { type: "filter", path: "source" },
              { type: "filter", path: "ts" },
            ],
          },
        })
        console.log(`[${source}] created ${vectorIndexName}`)
      } else {
        console.log(`[${source}] ${vectorIndexName} exists`)
      }

      if (!haveText) {
        await col.createSearchIndex({
          name: textIndexName,
          definition: {
            mappings: {
              dynamic: false,
              fields: {
                text: { type: "string", analyzer: "lucene.standard" },
              },
            },
          },
        })
        console.log(`[${source}] created ${textIndexName}`)
      } else {
        console.log(`[${source}] ${textIndexName} exists`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[${source}] search index error: ${msg}`)
      console.warn(`If this is a free M0 cluster on a region without Atlas Search, indexes will need manual creation in the Atlas UI.`)
    }
  }

  console.log("Done. Atlas Search indexes may take 1-2 minutes to become queryable.")
  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
