import { runAgent } from "../lib/agent/loop"
import { closeDb } from "../lib/db"
import { clearMemoryCache } from "../lib/agent/tools"
import type { BenchmarkQuestion } from "../lib/schemas"
import { readFileSync } from "node:fs"

async function main() {
  const path = process.argv[2] ?? "data/questions.example.json"
  const concurrency = Number(process.argv[3] ?? "5")

  const questions = JSON.parse(readFileSync(path, "utf-8")) as BenchmarkQuestion[]
  console.log(`Running ${questions.length} questions, concurrency=${concurrency}, file=${path}`)

  const results: Array<{
    q: BenchmarkQuestion
    answer: string
    status: string
    total_ms: number
    tool_calls: number
  }> = []

  let cursor = 0
  async function worker() {
    while (cursor < questions.length) {
      const i = cursor++
      const q = questions[i]
      clearMemoryCache()
      const tStart = Date.now()
      const r = await runAgent(q.question, { userName: process.env.PERSONA_USER_NAME ?? "the user" })
      const tool_calls = r.events.filter((e) => e.type === "tool_call").length
      results.push({
        q,
        answer: r.answer,
        status: r.status,
        total_ms: r.total_ms,
        tool_calls,
      })
      const t = Date.now() - tStart
      console.log(
        `[${q.id}] ${q.category.padEnd(11)} ${r.status.padEnd(8)} ${tool_calls} calls / ${t}ms\n  Q: ${q.question}\n  truth:  ${q.ground_truth}\n  agent:  ${r.answer}\n`,
      )
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  results.sort((a, b) => a.q.id.localeCompare(b.q.id))
  const okCount = results.filter((r) => r.status === "done").length
  console.log(`\n${okCount}/${results.length} completed cleanly`)
  console.log(`avg latency: ${Math.round(results.reduce((s, r) => s + r.total_ms, 0) / results.length)}ms`)
  console.log(`avg tool calls: ${(results.reduce((s, r) => s + r.tool_calls, 0) / results.length).toFixed(1)}`)

  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
