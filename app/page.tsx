"use client"

import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import type { BenchmarkQuestion, TraceEvent } from "@/lib/schemas"

type Status = "idle" | "running" | "done" | "error" | "timeout"

type CardState = {
  question: BenchmarkQuestion
  events: TraceEvent[]
  answer: string
  status: Status
  total_ms?: number
  error_message?: string
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
}

function isMatch(answer: string, groundTruth: string): boolean {
  const a = normalize(answer)
  const g = normalize(groundTruth)
  if (!a || !g) return false
  return a.includes(g) || g.includes(a)
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0")
}

function formatSeconds(ms?: number): string {
  if (typeof ms !== "number") return ""
  return `${(ms / 1000).toFixed(1)}s`
}

export default function Page() {
  const [cards, setCards] = useState<CardState[]>([])
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [indexOpen, setIndexOpen] = useState(false)
  const cardsRef = useRef<CardState[]>([])
  cardsRef.current = cards

  useEffect(() => {
    fetch("/api/persona/questions")
      .then((r) => r.json())
      .then((qs: BenchmarkQuestion[]) => {
        setCards(
          qs.map((q) => ({
            question: q,
            events: [],
            answer: "",
            status: "idle",
          }))
        )
      })
  }, [])

  const runOne = useCallback(async (idx: number): Promise<void> => {
    const card = cardsRef.current[idx]
    if (!card) return
    setActiveIdx(idx)
    setCards((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], status: "running", events: [], answer: "", error_message: undefined }
      return next
    })

    try {
      const res = await fetch("/api/persona/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: card.question.question }),
      })
      if (!res.body) throw new Error("no response body")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const payload = JSON.parse(line.slice(6))
          if (payload.type === "final") {
            setCards((prev) => {
              const next = [...prev]
              next[idx] = {
                ...next[idx],
                answer: payload.result.answer ?? next[idx].answer,
                status: payload.result.status ?? "done",
                total_ms: payload.result.total_ms,
              }
              return next
            })
          } else {
            setCards((prev) => {
              const next = [...prev]
              const ev = payload as TraceEvent
              next[idx] = { ...next[idx], events: [...next[idx].events, ev] }
              if (ev.type === "answer") next[idx].answer = ev.text
              if (ev.type === "error") {
                next[idx].status = "error"
                next[idx].error_message = ev.message
              }
              return next
            })
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setCards((prev) => {
        const next = [...prev]
        next[idx] = { ...next[idx], status: "error", error_message: msg }
        return next
      })
    }
  }, [])

  const runAll = useCallback(async () => {
    setRunning(true)
    for (let i = 0; i < cardsRef.current.length; i++) {
      if (cardsRef.current[i].status === "running") continue
      await runOne(i)
    }
    setRunning(false)
  }, [runOne])

  const ranOnMount = useRef(false)
  useEffect(() => {
    if (cards.length > 0 && !ranOnMount.current) {
      ranOnMount.current = true
      runOne(0)
    }
  }, [cards.length, runOne])

  const completed = cards.filter((c) => c.status === "done" || c.status === "error" || c.status === "timeout")
  const correctCount = useMemo(
    () => completed.filter((c) => c.status === "done" && isMatch(c.answer, c.question.ground_truth)).length,
    [completed]
  )
  const doneCount = completed.length
  const total = cards.length
  const allDone = doneCount === total && total > 0

  const onSelect = useCallback(
    (idx: number) => {
      setActiveIdx(idx)
      setIndexOpen(false)
      const c = cardsRef.current[idx]
      if (c && c.status === "idle") void runOne(idx)
    },
    [runOne]
  )

  const onKeyDownIndex = useCallback(
    (e: React.KeyboardEvent) => {
      if (activeIdx === null) return
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIdx(Math.min(activeIdx + 1, cards.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIdx(Math.max(activeIdx - 1, 0))
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        const c = cardsRef.current[activeIdx]
        if (c && c.status !== "running") void runOne(activeIdx)
      }
    },
    [activeIdx, cards.length, runOne]
  )

  const activeCard = activeIdx !== null ? cards[activeIdx] : null

  return (
    <div className="root">
      <header className="top">
        <div className="brand">
          <span className="brand-name serif italic">Persona</span>
          <span className="brand-sub">agentic adaptive retrieval over your real memories</span>
        </div>
        <button
          className="run-all"
          onClick={runAll}
          disabled={running || cards.length === 0}
          aria-label="Run all questions sequentially"
        >
          <span>{running ? "running" : "Run all"}</span>
          <span className="arrow">→</span>
        </button>
      </header>

      <button
        className="index-toggle"
        onClick={() => setIndexOpen((v) => !v)}
        aria-expanded={indexOpen}
        aria-controls="index"
      >
        Index of questions {indexOpen ? "▴" : "▾"}
      </button>

      <div className="split">
        <aside
          id="index"
          className={`index ${indexOpen ? "open" : ""}`}
          role="listbox"
          aria-label="Benchmark index"
          tabIndex={0}
          onKeyDown={onKeyDownIndex}
        >
          <div className="index-meta">
            <span className="serif italic">
              {total === 0
                ? "loading the benchmark…"
                : allDone
                  ? `${correctCount} of ${total} matched.`
                  : doneCount === 0
                    ? `${total} questions in the benchmark.`
                    : `${correctCount} of ${doneCount} matched so far.`}
            </span>
          </div>
          <ol className="entries">
            {cards.map((c, i) => (
              <IndexEntry
                key={c.question.id}
                card={c}
                index={i}
                selected={activeIdx === i}
                onClick={() => onSelect(i)}
              />
            ))}
          </ol>
        </aside>

        <main className="document" role="status" aria-live="polite" aria-atomic="false">
          {activeCard ? (
            <Document card={activeCard} onRetry={() => activeIdx !== null && runOne(activeIdx)} />
          ) : (
            <ColdStart onStart={() => runOne(0)} />
          )}
        </main>
      </div>

      <style jsx>{`
        .root {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }
        .top {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          padding: 28px 56px 0;
          gap: 24px;
        }
        .brand {
          display: flex;
          align-items: baseline;
          gap: 14px;
          min-width: 0;
        }
        .brand-name {
          font-size: 28px;
          font-weight: 500;
          color: var(--ink);
        }
        .brand-sub {
          color: var(--mute);
          font-size: 13px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .run-all {
          display: inline-flex;
          align-items: baseline;
          gap: 8px;
          color: var(--ink);
          font-size: 14px;
          padding: 4px 0;
          border-bottom: 1px solid var(--ink);
          transition: color 120ms ease, border-color 120ms ease;
        }
        .run-all:hover {
          color: var(--accent);
          border-color: var(--accent);
        }
        .run-all .arrow {
          font-size: 16px;
          line-height: 1;
        }
        .run-all:disabled { color: var(--mute); border-color: var(--rule); }
        .index-toggle {
          display: none;
          padding: 14px 24px;
          border-bottom: 1px solid var(--rule);
          color: var(--ink-2);
          font-size: 13px;
        }
        .split {
          display: grid;
          grid-template-columns: 360px 1fr;
          flex: 1;
          min-height: 0;
          padding: 40px 56px 64px;
          gap: 56px;
        }
        .index {
          position: relative;
          padding-right: 24px;
        }
        .index-meta {
          margin-bottom: 24px;
          color: var(--ink-2);
          font-size: 14px;
          padding-left: 36px;
        }
        .entries {
          list-style: none;
          padding: 0;
          margin: 0;
          counter-reset: q;
        }
        .document {
          min-width: 0;
          max-width: 720px;
        }
        @media (max-width: 1099px) {
          .top { padding: 24px 32px 0; }
          .split { grid-template-columns: 280px 1fr; padding: 32px 32px 56px; gap: 40px; }
          .index { padding-right: 16px; }
        }
        @media (max-width: 720px) {
          .top { padding: 18px 18px 0; flex-direction: column; align-items: flex-start; gap: 6px; }
          .brand { gap: 8px; }
          .brand-name { font-size: 24px; }
          .brand-sub { font-size: 12px; }
          .run-all { margin-top: 4px; }
          .index-toggle { display: block; margin-top: 12px; }
          .split { grid-template-columns: 1fr; padding: 24px 18px 48px; gap: 24px; }
          .index {
            display: ${indexOpen ? "block" : "none"};
            padding-right: 0;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--rule);
          }
          .index-meta { padding-left: 0; }
          .document { max-width: 100%; }
        }
      `}</style>
    </div>
  )
}

function IndexEntry({
  card,
  index,
  selected,
  onClick,
}: {
  card: CardState
  index: number
  selected: boolean
  onClick: () => void
}) {
  const correct = card.status === "done" && isMatch(card.answer, card.question.ground_truth)
  const num = pad2(index + 1)

  let trail: { text: string; tone: "match" | "differs" | "running" | "idle" | "error" } = {
    text: "—",
    tone: "idle",
  }
  if (card.status === "running") trail = { text: "thinking…", tone: "running" }
  else if (card.status === "done") {
    trail = correct
      ? { text: `matched · ${formatSeconds(card.total_ms)}`, tone: "match" }
      : { text: `differs · ${formatSeconds(card.total_ms)}`, tone: "differs" }
  } else if (card.status === "error" || card.status === "timeout")
    trail = { text: card.status === "timeout" ? "timed out" : "error", tone: "error" }

  return (
    <li className={`entry ${selected ? "selected" : ""} ${card.status}`}>
      <button onClick={onClick} role="option" aria-selected={selected} className="entry-btn">
        <span className={`num serif lnum ${selected ? "active" : ""}`}>{num}</span>
        <span className="text">
          <span className="q">{card.question.question}</span>
          <span className={`trail serif italic tnum ${trail.tone}`}>— {trail.text}</span>
        </span>
      </button>
      <style jsx>{`
        .entry {
          margin-bottom: 14px;
          position: relative;
        }
        .entry-btn {
          display: grid;
          grid-template-columns: 28px 1fr;
          gap: 8px;
          align-items: baseline;
          width: 100%;
          padding: 0;
          color: var(--ink);
          line-height: 1.4;
        }
        .num {
          font-size: 14px;
          color: var(--mute);
          text-align: right;
          font-weight: 400;
          padding-top: 1px;
        }
        .num.active {
          color: var(--accent);
          font-weight: 500;
        }
        .text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .q {
          color: var(--ink);
          font-size: 14px;
          line-height: 1.4;
          transition: color 120ms ease;
        }
        .entry.selected .q { color: var(--ink); }
        .entry-btn:hover .q { color: var(--accent); }
        .trail {
          font-size: 12px;
          color: var(--mute);
          letter-spacing: 0.005em;
        }
        .trail.match { color: var(--match); }
        .trail.differs { color: var(--differs); }
        .trail.running { color: var(--live); }
        .trail.error { color: var(--differs); }
        @media (max-width: 720px) {
          .entry { margin-bottom: 16px; }
        }
      `}</style>
    </li>
  )
}

function ColdStart({ onStart }: { onStart: () => void }) {
  return (
    <article className="cold fade-up">
      <h1 className="serif">
        An agent that answers <em>as you</em>.
      </h1>
      <p>
        Twenty questions. For each one, the agent runs adaptive retrieval over your real memories — classifying
        the query, rewriting it, searching Atlas Vector, re-ranking, and synthesizing an answer in your voice.
        Every step shows.
      </p>
      <button className="start serif italic" onClick={onStart}>
        Begin with the first question →
      </button>
      <style jsx>{`
        .cold {
          padding: 24px 0;
          display: flex;
          flex-direction: column;
          gap: 22px;
          max-width: 560px;
        }
        h1 {
          color: var(--ink);
          font-size: 44px;
          font-weight: 400;
          line-height: 1.12;
          letter-spacing: -0.018em;
        }
        h1 em { font-style: italic; color: var(--accent); }
        p {
          color: var(--ink-2);
          font-size: 17px;
          line-height: 1.6;
        }
        .start {
          align-self: flex-start;
          margin-top: 6px;
          font-size: 16px;
          color: var(--accent);
          padding: 4px 0;
          border-bottom: 1px solid var(--accent);
        }
        .start:hover { color: #a1462e; border-color: #a1462e; }
      `}</style>
    </article>
  )
}

function Document({ card, onRetry }: { card: CardState; onRetry: () => void }) {
  const { question, events, answer, status, total_ms, error_message } = card
  const correct = status === "done" && isMatch(answer, question.ground_truth)

  return (
    <article className="doc fade-up" key={card.question.id}>
      <h1 className="serif">{question.question}</h1>

      {status === "error" ? (
        <section className="errsec">
          <p className="serif italic">The agent couldn&apos;t complete this question.</p>
          <p className="errmsg">{error_message ?? "unknown error"}</p>
          <button className="retry serif italic" onClick={onRetry}>Try again →</button>
        </section>
      ) : (
        <TraceMap events={events} status={status} />
      )}

      {status !== "error" && (
        <section className="verdict">
          {status === "done" ? (
            <span className={`verdict-rule serif italic ${correct ? "match" : "differs"}`}>
              — {correct ? "matched" : "differs"}{total_ms ? ` · ${formatSeconds(total_ms)}` : ""} —
            </span>
          ) : status === "running" ? (
            <span className="verdict-rule serif italic running">— still working —</span>
          ) : null}
        </section>
      )}

      {status !== "error" && (
        <section className="answer">
          <p className="agent serif">
            {answer || (status === "running" ? <span className="placeholder italic">composing…</span> : "—")}
          </p>
          {status === "done" && !correct && (
            <p className="truth">
              <span className="serif italic prefix">You remembered: </span>
              <span className="serif">{question.ground_truth}</span>
            </p>
          )}
        </section>
      )}

      <style jsx>{`
        .doc {
          display: flex;
          flex-direction: column;
          gap: 28px;
        }
        h1 {
          font-size: 40px;
          line-height: 1.15;
          font-weight: 400;
          letter-spacing: -0.02em;
          color: var(--ink);
          max-width: 18ch;
        }
        .verdict {
          display: flex;
          align-items: center;
          padding: 4px 0;
        }
        .verdict-rule {
          font-size: 13px;
          letter-spacing: 0.04em;
        }
        .verdict-rule.match { color: var(--match); }
        .verdict-rule.differs { color: var(--differs); }
        .verdict-rule.running { color: var(--live); }
        .answer {
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .agent {
          font-size: 22px;
          line-height: 1.5;
          color: var(--ink);
          letter-spacing: -0.005em;
        }
        .placeholder { color: var(--mute); font-size: 17px; }
        .truth {
          font-size: 17px;
          line-height: 1.55;
          color: var(--ink-3);
          padding-top: 14px;
          border-top: 1px solid var(--rule-soft);
        }
        .truth .prefix { color: var(--mute); font-size: 14px; margin-right: 4px; }
        .errsec {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 12px 0;
        }
        .errsec p { font-size: 17px; color: var(--differs); }
        .errmsg { color: var(--mute); font-size: 13px; word-break: break-word; }
        .retry {
          align-self: flex-start;
          color: var(--accent);
          padding: 2px 0;
          border-bottom: 1px solid var(--accent);
          font-size: 14px;
        }
        @media (max-width: 720px) {
          h1 { font-size: 30px; }
          .agent { font-size: 19px; }
        }
      `}</style>
    </article>
  )
}

// ─── Knowledge graph (TraceMap) ─────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  gmail_msgs: "gmail",
  calendar_events: "calendar",
  slack_msgs: "slack",
  notion_docs: "notion",
  github_activity: "github",
  maps_history: "maps",
  photos_meta: "photos",
}

const SOURCE_COLOR: Record<string, string> = {
  gmail_msgs: "#c97e3a",
  calendar_events: "#5d7d5e",
  slack_msgs: "#7e5a8a",
  notion_docs: "#a08856",
  github_activity: "#5b5b5b",
  maps_history: "#a85842",
  photos_meta: "#b06a82",
}

type BranchOp = {
  index: number
  kind: "rerank" | "rechunk" | "cross_reference"
  label: string
  detail: string
}

type Branch = {
  index: number
  collection: string
  query: string
  hitCount: number
  mode: string
  ms: number
  ops: BranchOp[]
}

type ParsedTrace = {
  classify?: { strategy: string; reasoning: string }
  branches: Branch[]
  synthesize?: { citations: number; ms: number; index: number }
  liveIndex: number
  hasAnyEvent: boolean
}

function parseTrace(events: TraceEvent[]): ParsedTrace {
  const out: ParsedTrace = { branches: [], liveIndex: events.length - 1, hasAnyEvent: events.length > 0 }
  const callsByUseId = new Map<string, { tool: string; args: Record<string, unknown>; index: number }>()
  let cur: number | null = null

  events.forEach((e, idx) => {
    if (e.type === "classify") {
      out.classify = { strategy: e.strategy, reasoning: e.reasoning }
    } else if (e.type === "tool_call") {
      callsByUseId.set(e.tool_use_id, { tool: e.tool, args: e.args, index: idx })
    } else if (e.type === "tool_result") {
      const call = callsByUseId.get(e.tool_use_id)
      if (e.tool === "search") {
        const m = e.result_summary.match(/^(\d+) hits/)
        const hitCount = m ? parseInt(m[1] ?? "0", 10) : 0
        const collection = (call?.args?.collection as string) ?? "default"
        const mode = (call?.args?.mode as string) ?? "hybrid"
        const query = (call?.args?.query as string) ?? ""
        out.branches.push({ index: idx, collection, query, hitCount, mode, ms: e.latency_ms, ops: [] })
        cur = out.branches.length - 1
      } else if (e.tool === "rerank") {
        const m = e.result_summary.match(/Reranked (\d+) items by (\w+)/)
        if (cur !== null) {
          out.branches[cur].ops.push({
            index: idx,
            kind: "rerank",
            label: `↻ ${m?.[2] ?? "rerank"}`,
            detail: `${m?.[1] ?? "?"} kept`,
          })
        }
      } else if (e.tool === "rechunk") {
        const m = e.result_summary.match(/into (\d+) (\w+) chunks/)
        if (cur !== null) {
          out.branches[cur].ops.push({
            index: idx,
            kind: "rechunk",
            label: `↘ ${m?.[2] ?? "chunk"}`,
            detail: `${m?.[1] ?? "?"} parts`,
          })
        }
      } else if (e.tool === "cross_reference") {
        const m = e.result_summary.match(/(\d+) cross-ref matches on (\w+)/)
        if (cur !== null) {
          out.branches[cur].ops.push({
            index: idx,
            kind: "cross_reference",
            label: `⇄ on ${m?.[2] ?? "?"}`,
            detail: `${m?.[1] ?? "0"} match`,
          })
        }
      } else if (e.tool === "summarize_for_answer") {
        const m = e.result_summary.match(/\((\d+) citations\)/)
        out.synthesize = { citations: parseInt(m?.[1] ?? "0", 10), ms: e.latency_ms, index: idx }
      }
    }
  })
  return out
}

function dotPositions(count: number): Array<[number, number]> {
  // arrange up to 10 dots inside a ~30-radius bubble
  const positions: Array<[number, number]> = []
  if (count <= 0) return positions
  positions.push([0, 0])
  if (count >= 2) positions.push([14, 0])
  if (count >= 3) positions.push([-14, 0])
  if (count >= 4) positions.push([0, 14])
  if (count >= 5) positions.push([0, -14])
  if (count >= 6) positions.push([10, 10])
  if (count >= 7) positions.push([-10, 10])
  if (count >= 8) positions.push([10, -10])
  if (count >= 9) positions.push([-10, -10])
  if (count >= 10) positions.push([18, 9])
  return positions.slice(0, Math.min(count, 10))
}

function TraceMap({ events, status }: { events: TraceEvent[]; status: Status }) {
  const parsed = useMemo(() => parseTrace(events), [events])
  const VB_W = 800
  const VB_H = 360
  const QX = 60
  const SX = 320
  const AX = 720
  const QY = VB_H / 2
  const isLive = status === "running"

  const branchY = (i: number, n: number): number => {
    if (n <= 1) return QY
    const top = 70
    const bottom = VB_H - 70
    return top + (bottom - top) * (i / (n - 1))
  }

  const hasSynth = !!parsed.synthesize
  const lastBranchIdx = parsed.branches.length - 1
  const liveBranch =
    isLive && !hasSynth && parsed.branches.length > 0 ? lastBranchIdx : -1

  return (
    <figure className="map">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Map of the agent's reasoning across memory sources"
      >
        {/* Question node */}
        <g>
          <circle cx={QX} cy={QY} r="6" fill="var(--ink)" />
          <text x={QX} y={QY + 24} textAnchor="middle" className="lbl">
            question
          </text>
          {parsed.classify && (
            <text x={QX} y={QY + 40} textAnchor="middle" className="lbl-italic">
              as {parsed.classify.strategy}
            </text>
          )}
        </g>

        {/* Empty state */}
        {!parsed.hasAnyEvent && isLive && (
          <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" className="lbl-italic-lg">
            the agent is exploring…
          </text>
        )}

        {/* Branches */}
        {parsed.branches.map((b, i) => {
          const sy = branchY(i, parsed.branches.length)
          const color = SOURCE_COLOR[b.collection] ?? "var(--mute)"
          const live = i === liveBranch
          const sxEdge = SX - 32
          const axEdge = SX + 32
          // Question to source curve
          const c1x = QX + (sxEdge - QX) * 0.55
          const pathQS = `M ${QX + 6} ${QY} C ${c1x} ${QY}, ${sxEdge - 50} ${sy}, ${sxEdge} ${sy}`
          // Source to answer curve
          const c2x = axEdge + (AX - axEdge) * 0.45
          const pathSA = `M ${axEdge} ${sy} C ${c2x} ${sy}, ${AX - 50} ${QY}, ${AX - 6} ${QY}`

          return (
            <g key={b.index} className="fade-up">
              <path
                d={pathQS}
                fill="none"
                stroke={live ? "var(--accent)" : "var(--rule)"}
                strokeWidth={live ? 1.4 : 1}
                strokeLinecap="round"
              />
              <path
                d={pathSA}
                fill="none"
                stroke={hasSynth ? color : "var(--rule)"}
                strokeWidth={hasSynth ? 1.2 : 1}
                strokeLinecap="round"
                strokeOpacity={hasSynth ? 0.6 : 0.4}
              />

              {/* Source bubble */}
              <circle
                cx={SX}
                cy={sy}
                r="32"
                fill="var(--bg)"
                stroke={live ? "var(--accent)" : color}
                strokeWidth={live ? 1.6 : 1}
                strokeOpacity={live ? 1 : 0.7}
                className={live ? "live-rail" : ""}
              />
              {dotPositions(b.hitCount).map(([dx, dy], di) => (
                <circle key={di} cx={SX + dx} cy={sy + dy} r="2.5" fill={color} />
              ))}
              {b.hitCount > 10 && (
                <text x={SX + 22} y={sy + 4} className="lbl-tiny" fill={color}>
                  +{b.hitCount - 10}
                </text>
              )}

              {/* Source label */}
              <text x={SX} y={sy + 50} textAnchor="middle" className="lbl" fill={color}>
                {SOURCE_LABEL[b.collection] ?? b.collection} · {b.hitCount}
              </text>

              {/* Query whisper */}
              {b.query && (
                <text x={SX} y={sy - 46} textAnchor="middle" className="lbl-italic">
                  &ldquo;{b.query.length > 36 ? b.query.slice(0, 35) + "…" : b.query}&rdquo;
                </text>
              )}

              {/* Ops along right curve */}
              {b.ops.map((op, oi) => (
                <g key={oi} transform={`translate(${SX + 80}, ${sy - 10 + oi * 16})`}>
                  <text className="lbl" fill={hasSynth ? color : "var(--ink-3)"}>
                    {op.label}
                  </text>
                  <text y={12} className="lbl-tiny">
                    {op.detail}
                  </text>
                </g>
              ))}
            </g>
          )
        })}

        {/* Answer node */}
        <g>
          <circle
            cx={AX}
            cy={QY}
            r={hasSynth ? 8 : 5}
            fill={hasSynth ? "var(--accent)" : "transparent"}
            stroke="var(--ink)"
            strokeWidth={hasSynth ? 0 : 1}
            strokeDasharray={hasSynth ? "0" : "2 3"}
          />
          <text x={AX} y={QY + 26} textAnchor="middle" className="lbl">
            answer
          </text>
          {parsed.synthesize && (
            <text x={AX} y={QY + 42} textAnchor="middle" className="lbl-italic">
              {parsed.synthesize.citations} cited
            </text>
          )}
        </g>
      </svg>

      <style jsx>{`
        .map {
          margin: 0;
          padding: 8px 0;
          width: 100%;
        }
        .map svg {
          width: 100%;
          height: auto;
          max-height: 420px;
          display: block;
          font-family: var(--font-sans);
        }
      `}</style>
      <style jsx global>{`
        .map .lbl {
          font-family: var(--font-sans);
          font-size: 11px;
          fill: var(--ink-3);
          letter-spacing: 0.01em;
        }
        .map .lbl-italic {
          font-family: var(--font-serif);
          font-style: italic;
          font-size: 12px;
          fill: var(--mute);
        }
        .map .lbl-italic-lg {
          font-family: var(--font-serif);
          font-style: italic;
          font-size: 16px;
          fill: var(--mute);
        }
        .map .lbl-tiny {
          font-family: var(--font-sans);
          font-size: 10px;
          fill: var(--mute-2);
          letter-spacing: 0.02em;
        }
      `}</style>
    </figure>
  )
}
