import { MongoClient, type Collection, type Db } from "mongodb"
import type { Memory } from "./schemas"

let _client: MongoClient | null = null
let _db: Db | null = null

export const SOURCES = [
  "gmail_msgs",
  "calendar_events",
  "notion_docs",
  "github_activity",
  "gdrive_files",
  "gdocs_pages",
  "gsheets_sheets",
  "linkedin_profile",
  "youtube_activity",
  "discord_servers",
  "instagram_posts",
  "maps_history",
  "photos_meta",
] as const

export type SourceName = (typeof SOURCES)[number]

export async function getDb(): Promise<Db> {
  if (_db) return _db
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error("MONGODB_URI is not set")
  _client = new MongoClient(uri, {
    maxPoolSize: 50,
    minPoolSize: 5,
  })
  await _client.connect()
  _db = _client.db(process.env.MONGODB_DB ?? "persona")
  return _db
}

export async function memoriesOf(source: SourceName): Promise<Collection<Memory>> {
  const db = await getDb()
  return db.collection<Memory>(source)
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close()
    _client = null
    _db = null
  }
}
