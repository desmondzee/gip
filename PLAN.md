# persona — frontend design plan

Hackathon demo for a digital persona that answers questions as the user via
agentic adaptive retrieval (MongoDB Atlas Vector Search + Composio
integrations).

This plan is the output of `/plan-design-review` on `app/page.tsx`. The
existing scaffold is a debugging dashboard; this plan turns it into a product
surface for a hackathon judge demo.

## Visual reference

`~/.gstack/projects/desmondzee-gip/designs/persona-demo-20260502/wireframes.html`
captured three directions (A — Live Reasoning Theater, B — Split Board, C —
Scoreboard). The approved direction is a **B+A hybrid**: split-board structure
(real product surface, list on left), with the right pane behaving as the live
reasoning theater when a question is running.

## Layout

```
+--------------------------------------------------------------------+
| persona •      17/20 match · avg 1.4s · 4.2 calls       [Run All]  |   top bar
+-----------+--------------------------------------------------------+
|  Q1   ✓   |  Q12 · subjective_preference · running 1.4s            |
|  Q2   ✓   |  Which restaurant did I love most in Tokyo last month? |
|  Q3   ✗   |                                                        |
|  Q4   ✓   |  +12ms   classify     subjective · episodic            |
|  Q5   …   |  +48ms   rewrite      "Tokyo restaurant" loved date:[] |   theater
| (active)  |  +210ms  atlas.search k=12 · gmail/cal/notes           |
|  Q6   ✓   |  +820ms  re-rank      scoring sentiment + recency  ◐   |
|  ...      |  ──      synthesize   waiting                          |
|  LIST     |                                                        |
|  (38%)    |  YOU              | AGENT                              |
|           |  Den, Jingumae.   | …                                  |
|           |                                                        |
|           |  retrieved (top 2)                                     |
|           |  📍 cal 4/18 · dinner @ Den, Jingumae 7pm              |
|           |  📝 note 4/19 · Den last night was unreal — broth…     |
+-----------+--------------------------------------------------------+
```

Hierarchy: 1) brand + score, 2) active question + reasoning, 3) you-vs-agent,
4) retrieved snippets, 5) full question list as peripheral status.

## Behavior

- **Cold start (page mount):** auto-run Q1 immediately so the theater is alive
  the moment a judge looks at the screen. If Q1 errors, theater falls back to
  a static one-liner explainer ("an AI agent that answers questions as you, by
  retrieving across your real memories").
- **Run All:** sequential, one question at a time. Total ~28 seconds for 20
  questions. Theater is always full, narrative stays coherent.
- **Theater target during a single Run:** auto-follow — when a new question
  starts, theater swaps to it. List rows for previously-completed questions
  retain their final state.
- **Click a list row:** if running, follows that Q; if completed, shows its
  final detail; if idle, runs it and switches theater to it.
- **Score badge:** ticks up live as `done` events arrive. Format: `N/20 match`
  (correct answers / completed answers).

## Interaction state matrix

```
  AREA          | COLD-START      | RUNNING (1)        | ALL DONE         | ERROR
  --------------|-----------------|--------------------|------------------|---------
  TOP BAR score | "—/20"          | "—/20 · 1 live"    | "17/20 match"    | "—/20 ⚠"
  LEFT LIST row | dot=idle, ms=—  | dot=warn pulse     | dot=ok or bad    | dot=red ⚠
  THEATER       | Q1 auto-running | live trace stream  | last-Q detail    | error explainer + retry
  YOU/AGENT     | YOU shown ↓     | YOU shown, AGENT … | both populated   | "couldn't reach Atlas / LLM"
  Snippets      | hidden          | populate as ranked | top 2 retrieved  | hidden
```

The "running" theater shows trace events stream-rendered as they arrive on the
SSE channel from `/api/persona/query`: `classify`, `tool_call`, `tool_result`,
`thinking` (truncated 150 chars), `answer` (final).

## Design tokens (lock to `app/globals.css`)

```
:root {
  /* surface */
  --bg: #0b0b0d;
  --panel: #131318;
  --panel-2: #1f1f24;
  --line: #2c2c33;

  /* ink */
  --ink: #e8e8ec;
  --mute: #888;

  /* status */
  --ok: #4ade80;
  --warn: #fbbf24;
  --bad: #f87171;
  --info: #60a5fa;

  /* accent — used only for: brand dot, "live" pill, focus ring */
  --accent: #d4f56a;

  /* type */
  --font-display: "Geist Sans", -apple-system, system-ui, sans-serif;
  --font-mono:    ui-monospace, "SF Mono", Menlo, monospace;
}
```

Sizes: 12 caption / 13 body / 15 q-text / 18 q-detail / 22 brand / 56 score-num.
Spacing: 4 / 8 / 12 / 16 / 24 / 32. Radius: 3 chip / 4 pane-button / 6 theater /
8 top-card. Mono is for code/traces/timings/score-number; display is for brand,
question text, section headers.

Geist Sans loads via `next/font/google` in `app/layout.tsx`.

## Responsive

```
  VIEWPORT          | LIST                  | THEATER         | SCORE BAR
  ------------------|-----------------------|-----------------|--------------
  ≥1100px (laptop)  | 38% left rail         | right pane      | full top
  720–1099px        | 32% left rail         | right pane      | full
  <720px (mobile)   | top drawer (slide-    | full viewport   | sticky top
                    | down on tap)          | theater is page | (no avg/calls)
```

## Accessibility

- Focus ring: `outline: 2px solid var(--accent)` with `outline-offset: 2px` on
  every interactive element. Visible on keyboard nav.
- Left list: `role="listbox"`, each row `role="option"` with `aria-selected`.
  Arrow keys move selection; Enter/Space runs that question.
- Theater: `<div role="status" aria-live="polite">` wraps the trace list so
  screen readers announce updates. Trace events themselves have `aria-hidden`;
  only the final answer is announced.
- Touch targets ≥44px on mobile.
- `@media (prefers-reduced-motion: reduce)`: disable the in-flight pulse
  animation, replace with a static warn-colored dot.
- Contrast verified: `--mute` (#888 on #0b0b0d) = 5.0:1, AA pass.

## Approved Mockups

| Screen / Section | Mockup Path | Direction | Notes |
|------------------|-------------|-----------|-------|
| persona dashboard (full) | `~/.gstack/projects/desmondzee-gip/designs/persona-demo-20260502/wireframes.html` | B+A hybrid (split board structure with theater right-pane) | Wireframe sketch, not rendered mockup. Implementer builds from this + the layout above. |

## NOT in scope

- Authentication / multi-user (hackathon: single persona, no login)
- Editing memories from the UI (read-only over Atlas)
- Filtering questions by category in the list (everything visible)
- Aggregate analytics dashboard (per-category accuracy bar, latency histogram) — post-judging
- A "/explain" panel that traces *why* the agent missed a question — post-judging
- Light mode

## What already exists

- `app/page.tsx` — current grid-of-cards page; will be rewritten to the split-board layout
- `app/globals.css` — minimal reset + dark base; will gain CSS variables and Geist
- `app/layout.tsx` — barebones; will load Geist via `next/font/google`
- `app/api/persona/query/route.ts` — SSE-streaming agent endpoint (TraceEvent shape)
- `app/api/persona/questions/route.ts` — returns `BenchmarkQuestion[]`
- `lib/schemas.ts` — `TraceEvent` and `BenchmarkQuestion` types — drive the theater rendering
- The existing status-color vocabulary (ok=green, warn=amber, bad=red, info=blue) is preserved

## Unresolved decisions (deferred during this review)

| Decision | Default if not addressed |
|----------|--------------------------|
| Logotype vs text wordmark for brand | Text wordmark only |
| Score badge tick-up animation | Snap update; can add later |
| Re-rank step visualization (chart vs text) | Plain text trace |
| Trace event filtering toggle | Show all events; verbose by design |

## Completion summary

```
+====================================================================+
|         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
+====================================================================+
| System Audit         | No DESIGN.md, no PLAN.md (this file is new) |
| Step 0               | initial 3/10, focus: full 7-pass            |
| Pass 1  (Info Arch)  | 4/10 → 8/10                                 |
| Pass 2  (States)     | 3/10 → 8/10                                 |
| Pass 3  (Journey)    | 2/10 → 9/10                                 |
| Pass 4  (AI Slop)    | 7/10 → 9/10  (Geist Sans paired w/ mono)    |
| Pass 5  (Design Sys) | 3/10 → 8/10  (tokens locked in globals.css) |
| Pass 6  (Responsive) | 1/10 → 8/10                                 |
| Pass 7  (Decisions)  | 1 resolved (sequential Run All), 4 deferred |
+--------------------------------------------------------------------+
| NOT in scope         | written (6 items)                           |
| What already exists  | written                                     |
| TODOS.md updates     | proposed below                              |
| Approved Mockups     | 1 wireframe (3 variants → B+A hybrid chosen)|
| Decisions made       | 7 added to plan                             |
| Decisions deferred   | 4 (table above)                             |
| Overall design score | 3/10 → 8/10                                 |
+====================================================================+
```

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | not run |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | score 3/10 → 8/10, 7 decisions made, 4 deferred to TODOS.md |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not applicable (judge-facing demo) |

**UNRESOLVED:** 4 (deferred to TODOS.md, none blocking)
**VERDICT:** DESIGN CLEARED — eng review required before implementation

