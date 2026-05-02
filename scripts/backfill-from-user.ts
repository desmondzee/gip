#!/usr/bin/env bun
/**
 * Backfill metadata.from_user across existing memories.
 *
 * After scripts/ingest.ts started tagging from_user at ingest time (eng
 * review 1B), data ingested before the change is missing the flag. This
 * script re-derives from_user for every existing document using the same
 * per-source identity logic and writes the flag in place.
 *
 * Idempotent: rerunning is safe — only docs whose computed from_user
 * differs from what's already stored get rewritten.
 *
 * Usage:
 *   bun scripts/backfill-from-user.ts --dry-run        # count, don't write
 *   bun scripts/backfill-from-user.ts                  # write
 *   bun scripts/backfill-from-user.ts --source notion_docs  # one source
 *
 * Per-source identity comes from env (.env): PERSONA_USER_EMAIL,
 * PERSONA_USER_EMAILS, PERSONA_NOTION_USER_ID, PERSONA_GITHUB_LOGIN.
 * Missing env vars cause the matching source to stay untagged (no
 * false-positive risk — better safe than wrong).
 */
import type { ObjectId, AnyBulkWriteOperation, Document } from "mongodb"
import { getDb, SOURCES, closeDb, type SourceName } from "../lib/db"
import { deriveFromUser } from "./ingest"

interface BackfillStats {
  source: SourceName
  scanned: number
  newly_tagged: number
  newly_untagged: number
  unchanged: number
}

function parseArgs(): { dryRun: boolean; only: SourceName | null } {
  let dryRun = false
  let only: SourceName | null = null
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    if (a === "--dry-run") dryRun = true
    else if (a === "--source") {
      const val = process.argv[++i]
      if (!SOURCES.includes(val as SourceName)) {
        throw new Error(`unknown source ${val}; valid: ${SOURCES.join(", ")}`)
      }
      only = val as SourceName
    } else if (a === "--help" || a === "-h") {
      console.log("usage: bun scripts/backfill-from-user.ts [--dry-run] [--source <name>]")
      process.exit(0)
    } else {
      throw new Error(`unknown arg ${a}`)
    }
  }
  return { dryRun, only }
}

async function backfillSource(source: SourceName, dryRun: boolean): Promise<BackfillStats> {
  const db = await getDb()
  const col = db.collection(source)
  const cursor = col.find({}, { projection: { _id: 1, metadata: 1 } })

  const stats: BackfillStats = {
    source,
    scanned: 0,
    newly_tagged: 0,
    newly_untagged: 0,
    unchanged: 0,
  }

  // Buffer updates and flush in batches so we don't make N round-trips.
  const BATCH = 200
  const ops: AnyBulkWriteOperation<Document>[] = []
  const flush = async (): Promise<void> => {
    if (ops.length === 0) return
    if (!dryRun) {
      await col.bulkWrite(ops, { ordered: false })
    }
    ops.length = 0
  }

  for await (const doc of cursor) {
    stats.scanned++
    const md = (doc.metadata ?? {}) as Record<string, unknown>
    const desired = deriveFromUser(source, md)
    const current = md.from_user === true
    if (desired === current) {
      stats.unchanged++
      continue
    }
    if (desired) stats.newly_tagged++
    else stats.newly_untagged++
    ops.push({
      updateOne: {
        filter: { _id: doc._id as ObjectId },
        update: { $set: { "metadata.from_user": desired } },
      },
    })
    if (ops.length >= BATCH) await flush()
  }
  await flush()
  return stats
}

async function main(): Promise<void> {
  const args = parseArgs()
  const sources = args.only ? [args.only] : (SOURCES as readonly SourceName[])

  console.log(`backfill-from-user — ${args.dryRun ? "DRY RUN" : "WRITE"} mode`)
  const userEmail = (process.env.PERSONA_USER_EMAIL ?? "").trim() || "(unset)"
  const notionId = (process.env.PERSONA_NOTION_USER_ID ?? "").trim() || "(unset)"
  const ghLogin = (process.env.PERSONA_GITHUB_LOGIN ?? "").trim() || "(unset)"
  console.log(`identity: gmail=${userEmail} notion=${notionId} github=${ghLogin}`)
  console.log("")

  const all: BackfillStats[] = []
  for (const s of sources) {
    process.stdout.write(`[${s}] scanning… `)
    try {
      const st = await backfillSource(s, args.dryRun)
      all.push(st)
      console.log(
        `scanned=${st.scanned} +tagged=${st.newly_tagged} -tagged=${st.newly_untagged} unchanged=${st.unchanged}`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`SKIPPED — ${msg}`)
    }
  }

  console.log("\nsummary:")
  let totalScanned = 0
  let totalTagged = 0
  for (const s of all) {
    totalScanned += s.scanned
    totalTagged += s.newly_tagged
    const after = s.unchanged + s.newly_tagged // unchanged includes already-tagged
    console.log(`  ${s.source}: ${after}/${s.scanned} now tagged from_user (+${s.newly_tagged})`)
  }
  console.log(`  TOTAL: ${totalScanned} scanned, +${totalTagged} newly tagged`)
  if (args.dryRun) {
    console.log("\n(dry run — no writes performed; rerun without --dry-run to apply)")
  }

  await closeDb()
}

main().catch((e) => {
  console.error("backfill failed:", e instanceof Error ? e.message : e)
  process.exit(1)
})
