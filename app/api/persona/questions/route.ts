import { readFileSync } from "node:fs"
import { join } from "node:path"

export const runtime = "nodejs"

export async function GET() {
  const path = join(process.cwd(), "data", "questions.example.json")
  const text = readFileSync(path, "utf-8")
  return new Response(text, {
    headers: { "Content-Type": "application/json" },
  })
}
