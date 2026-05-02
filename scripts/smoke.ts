import { runAgent } from "../lib/agent/loop"
import { closeDb } from "../lib/db"

const question = process.argv.slice(2).join(" ") || "What classes do I have on my calendar most often?"
console.log(`Q: ${question}\n`)

const r = await runAgent(question, {
  userName: process.env.PERSONA_USER_NAME ?? "the user",
})

console.log(`status: ${r.status}`)
console.log(`total_ms: ${r.total_ms}`)
console.log(`tool_calls: ${r.events.filter((e) => e.type === "tool_call").length}`)
console.log(`\nanswer:\n${r.answer}\n`)
console.log("---events---")
for (const e of r.events) {
  if (e.type === "classify")
    console.log(`  ⊕ classify → ${e.strategy} (${e.reasoning})`)
  else if (e.type === "tool_call")
    console.log(`  → ${e.tool}(${JSON.stringify(e.args).slice(0, 140)})`)
  else if (e.type === "tool_result") {
    console.log(`  ← ${e.tool}: ${e.result_summary.slice(0, 200)} [${e.latency_ms}ms]`)
    if (e.candidates && e.candidates.length > 0) {
      const top = e.candidates.slice(0, 5)
      for (const c of top) {
        console.log(
          `      [${c.source ?? "?"}] ${c.score.toFixed(2)} ${(c.text_preview ?? "").slice(0, 60)}`,
        )
      }
    }
  }
  else if (e.type === "thinking") console.log(`  💭 ${e.text.slice(0, 140)}`)
  else if (e.type === "answer") {
    /* already printed above */
  } else if (e.type === "error") console.log(`  ✗ ${e.message}`)
}
await closeDb()
