import { runAgent } from "../lib/agent/loop"
import { closeDb } from "../lib/db"

const r = await runAgent("What did I think of that bagel place on 3rd Ave?", {
  userName: "Jerry",
})

console.log(`status: ${r.status}`)
console.log(`total_ms: ${r.total_ms}`)
console.log(`answer: ${r.answer}`)
console.log(`tool_calls: ${r.events.filter((e) => e.type === "tool_call").length}`)
console.log("---events---")
for (const e of r.events) {
  if (e.type === "tool_call")
    console.log(`  → ${e.tool}(${JSON.stringify(e.args).slice(0, 120)})`)
  else if (e.type === "tool_result")
    console.log(`  ← ${e.tool}: ${e.result_summary} [${e.latency_ms}ms]`)
  else if (e.type === "thinking") console.log(`  💭 ${e.text.slice(0, 120)}`)
  else if (e.type === "answer") console.log(`  ✓ ${e.text.slice(0, 200)}`)
  else if (e.type === "error") console.log(`  ✗ ${e.message}`)
}
await closeDb()
