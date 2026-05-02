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

    const textIndexDefinition = {
      mappings: {
        dynamic: false,
        fields: {
          text: { type: "string", analyzer: "lucene.standard" },
          metadata: { type: "document", dynamic: true },
        },
      },
    }

    try {
      const existing = await col.listSearchIndexes().toArray()
      const haveVector = existing.some((i) => i.name === vectorIndexName)
      const haveText = existing.some((i) => i.name === textIndexName)

      const vectorIndexDefinition = {
        fields: [
          {
            type: "vector" as const,
            path: "embedding",
            numDimensions: EMBED_DIM,
            similarity: "cosine" as const,
          },
          { type: "filter" as const, path: "source" },
          { type: "filter" as const, path: "ts" },
          // Voice memory layer: search_voice filters at the index level
          // (eng review 4A) so the per-cameo cost stays under budget.
          { type: "filter" as const, path: "metadata.from_user" },
        ],
      }

      if (!haveVector) {
        await col.createSearchIndex({
          name: vectorIndexName,
          type: "vectorSearch",
          definition: vectorIndexDefinition,
        })
        console.log(`[${source}] created ${vectorIndexName}`)
      } else {
        // Update so the from_user filter is added to indexes that pre-date the voice layer
        try {
          await col.updateSearchIndex(vectorIndexName, vectorIndexDefinition)
          console.log(`[${source}] updated ${vectorIndexName} (metadata.from_user filter ensured)`)
        } catch (e) {
          // updateSearchIndex throws if the definition matches — benign
          const msg = e instanceof Error ? e.message : String(e)
          if (!msg.toLowerCase().includes("no change")) {
            console.warn(`[${source}] ${vectorIndexName} update warning: ${msg}`)
          } else {
            console.log(`[${source}] ${vectorIndexName} unchanged`)
          }
        }
      }

      if (!haveText) {
        await col.createSearchIndex({
          name: textIndexName,
          definition: textIndexDefinition,
        })
        console.log(`[${source}] created ${textIndexName}`)
      } else {
        await col.updateSearchIndex(textIndexName, textIndexDefinition)
        console.log(`[${source}] updated ${textIndexName} (metadata.* now indexed)`)
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
