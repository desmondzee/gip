# TODOs (post-judging polish)

Deferred from `/plan-design-review` on 2026-05-02. None blocks the hackathon
demo; all add polish or expand demo value if time allows.

## 1. Brand logotype

- **What:** Small graphic mark to the left of the "persona" wordmark in the
  top bar (replaces the current `•` lime dot).
- **Why:** Pushes the surface from "scaffold with a wordmark" to "actual
  product" in a judge's first impression.
- **Pros:** Cheap visual identity; legitimizes the demo.
- **Cons:** Time spent designing/sourcing a mark instead of shipping function.
- **Context:** Lime dot (`--accent`) currently stands in. Anything that fits
  in 18×18 px and survives at 1× and 2× DPI works.
- **Depends on:** None.

## 2. Score badge tick-up animation

- **What:** When a question completes and the score increments, animate the
  count-up (e.g. 16 → 17 over 300ms) and a brief lime flash on the badge.
- **Why:** Makes the "agent is matching me" moments feel like wins.
- **Pros:** ~20 lines of code, big perceived-quality bump.
- **Cons:** None significant. Respect `prefers-reduced-motion`.
- **Context:** Score lives in the top bar; updates arrive via SSE `final`
  events from `/api/persona/query`.
- **Depends on:** Top bar score badge being implemented first.

## 3. Re-rank step bar chart

- **What:** Inside the trace, the `re-rank` step renders a small
  horizontal bar chart of the top-K candidate scores instead of a text line.
- **Why:** Makes the adaptive retrieval part visually undeniable. The judge
  sees the agent considering and weighing candidates.
- **Pros:** Strong "this is genuinely doing multi-step retrieval" signal.
- **Cons:** Trace event needs to carry per-candidate scores; touches both
  `lib/agent/loop.ts` and the schema.
- **Context:** Current `tool_result` events return `result_summary` only.
  Adding `top_k_scores: { id, score }[]` to re-rank tool results unlocks this.
- **Depends on:** Re-rank tool emitting structured candidate scores.

## 4. Full unit coverage for MCP layer

- **What:** Replace the single smoke test (`scripts/smoke-mcp.ts`) with full unit
  coverage of `lib/mcp/format.ts`, the `ask_persona` tool handler in
  `bin/mcp-persona.ts`, and the error-mapping logic from /plan-eng-review A1.
- **Why:** The hackathon ships smoke-only because the codebase has no test
  framework set up yet. The MCP layer's error paths (timeout, error, exhausted,
  thrown) are the highest-risk surface and currently only verified by hand.
- **Pros:** Locks in the error-handling contract; catches regressions on the
  isError + markdown fallback path; foundation for testing the rest of the agent
  loop.
- **Cons:** Picking a test framework is itself a one-off decision (bun:test is
  the natural choice for a bun-standardized repo).
- **Context:** Coverage diagram in
  `~/.gstack/projects/desmondzee-gip/jerryjin-jerrydjin-digital-persona-eng-review-test-plan-20260502-145500.md`
  enumerates ~15 gaps. The smoke test covers only "binary launches and emits a
  shape-valid response." Each gap in the diagram is one or two unit tests.
- **Depends on:** Picking a test runner (bun:test recommended).

## 5. Failure-explanation panel

- **What:** Clicking a missed question shows a panel explaining the failure —
  which retrieved chunks were considered, which step's output diverged from
  the ground truth, and a one-line classifier ("retrieved nothing relevant" /
  "retrieved correct but re-ranked wrong" / "synthesized incorrect from
  correct context").
- **Why:** Highest-value demo addition. Turns a miss from a flaw into a
  feature ("the agent is honest about its work"). Also a strong "we built a
  real eval system" signal to judges.
- **Pros:** Differentiator. Makes 17/20 more compelling than 20/20 because
  the audience sees the work.
- **Cons:** Real implementation effort — needs ground-truth comparison
  logic, retrieval-vs-answer divergence detection.
- **Context:** Requires comparing `ground_truth` vs `answer`, plus
  inspecting retrieved chunks from atlas.search trace events. Could be a
  separate `/api/persona/explain/:questionId` endpoint.
- **Depends on:** Core dashboard shipped first.
