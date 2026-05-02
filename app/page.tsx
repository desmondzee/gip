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

const SOURCES = [
  "gmail_msgs",
  "calendar_events",
  "slack_msgs",
  "notion_docs",
  "github_activity",
  "gdrive_files",
  "gdocs_pages",
  "gsheets_sheets",
  "linkedin_profile",
  "youtube_activity",
  "discord_servers",
  "instagram_posts",
] as const
type IngestSource = (typeof SOURCES)[number]
type IngestStatus = "idle" | "running" | "done" | "error"
type ConnectStatus = "unknown" | "checking" | "connected" | "not_connected" | "error"

export default function Page() {
  const [cards, setCards] = useState<CardState[]>([])
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [indexOpen, setIndexOpen] = useState(false)
  const cardsRef = useRef<CardState[]>([])
  cardsRef.current = cards

  const [ingestStatus, setIngestStatus] = useState<Record<IngestSource, IngestStatus>>(
    () => Object.fromEntries(SOURCES.map((s) => [s, "idle"])) as Record<IngestSource, IngestStatus>
  )
  const [ingestMsg, setIngestMsg] = useState<Record<IngestSource, string>>(
    () => Object.fromEntries(SOURCES.map((s) => [s, ""])) as Record<IngestSource, string>
  )
  const [connectStatus, setConnectStatus] = useState<Record<IngestSource, ConnectStatus>>(
    () => Object.fromEntries(SOURCES.map((s) => [s, "unknown"])) as Record<IngestSource, ConnectStatus>
  )
  const [connectUrls, setConnectUrls] = useState<Record<IngestSource, string>>(
    () => Object.fromEntries(SOURCES.map((s) => [s, ""])) as Record<IngestSource, string>
  )
  // Bumped when an ingest changes memory. VectorField re-fetches the layout
  // when this changes so newly-ingested chunks show up in the scatter.
  const [layoutVersion, setLayoutVersion] = useState(0)

  const checkConnection = useCallback(async (source: IngestSource) => {
    setConnectStatus((p) => ({ ...p, [source]: "checking" }))
    try {
      const res = await fetch(`/api/connect?source=${source}`)
      const data = await res.json()
      if (!res.ok) {
        setConnectStatus((p) => ({ ...p, [source]: "error" }))
        return
      }
      if (data.status === "connected") {
        setConnectStatus((p) => ({ ...p, [source]: "connected" }))
      } else {
        setConnectStatus((p) => ({ ...p, [source]: "not_connected" }))
        setConnectUrls((p) => ({ ...p, [source]: data.redirectUrl ?? "" }))
      }
    } catch {
      setConnectStatus((p) => ({ ...p, [source]: "error" }))
    }
  }, [])

  useEffect(() => {
    SOURCES.forEach((s) => checkConnection(s))
  }, [checkConnection])

  const runIngest = useCallback(async (source: IngestSource) => {
    setIngestStatus((p) => ({ ...p, [source]: "running" }))
    setIngestMsg((p) => ({ ...p, [source]: "" }))
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? res.statusText)
      setIngestMsg((p) => ({ ...p, [source]: `+${data.inserted} new, ~${data.updated} updated` }))
      setIngestStatus((p) => ({ ...p, [source]: "done" }))
      if ((data.inserted ?? 0) > 0 || (data.updated ?? 0) > 0) {
        setLayoutVersion((v) => v + 1)
      }
      checkConnection(source)
    } catch (err) {
      setIngestMsg((p) => ({ ...p, [source]: err instanceof Error ? err.message : String(err) }))
      setIngestStatus((p) => ({ ...p, [source]: "error" }))
    }
  }, [checkConnection])

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

  const [customQ, setCustomQ] = useState("")
  const submitCustom = useCallback(() => {
    const text = customQ.trim()
    if (!text || running) return
    setCustomQ("")
    setCards((prev) => {
      const newIdx = prev.length
      const newCard: CardState = {
        question: {
          id: `custom-${Date.now()}`,
          category: "recall",
          question: text,
          ground_truth: "",
        },
        events: [],
        answer: "",
        status: "idle",
      }
      setTimeout(() => {
        setActiveIdx(newIdx)
        runOne(newIdx)
      }, 0)
      return [...prev, newCard]
    })
  }, [customQ, running, runOne])

  return (
    <div className="root">
      <header className="top">
        <div className="brand">
          <span className="brand-mark serif italic">Persona</span>
          <span className="brand-of serif">of</span>
          <span className="brand-who">WeiWei Yuzhong Luo</span>
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

      <section className="sources" aria-label="Memory sources">
        <span className="sources-label">Sources</span>
        <ul className="sources-list">
          {SOURCES.map((src) => {
            const cs = connectStatus[src]
            const isConnected = cs === "connected"
            const notConnected = cs === "not_connected"
            const connectUrl = connectUrls[src]
            const label = SOURCE_LABEL[src] ?? src.replace("_msgs", "").replace("_events", "")
            const stateClass =
              cs === "connected"
                ? "is-connected"
                : cs === "not_connected"
                  ? "is-disconnected"
                  : cs === "checking"
                    ? "is-checking"
                    : "is-unknown"
            const isRunning = ingestStatus[src] === "running"
            return (
              <li key={src} className={`source ${stateClass}`}>
                <span
                  className={`source-dot ${cs === "checking" ? "live-rail" : ""}`}
                  title={cs}
                  aria-hidden
                />
                {notConnected && connectUrl ? (
                  <a className="source-action source-action--connect" href={connectUrl} target="_blank" rel="noreferrer">
                    connect {label}
                  </a>
                ) : (
                  <button
                    className="source-action"
                    onClick={() => runIngest(src)}
                    disabled={isRunning || !isConnected}
                  >
                    {isRunning ? `${label}…` : label}
                  </button>
                )}
                {ingestMsg[src] && (
                  <span className={`source-msg ${ingestStatus[src] === "error" ? "source-msg--error" : ""}`}>
                    {ingestMsg[src]}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault()
          submitCustom()
        }}
      >
        <span className="ask-label serif italic">Ask about WeiWei</span>
        <input
          className="ask-input"
          type="text"
          placeholder="what do they think about X? what would they say if…?"
          value={customQ}
          onChange={(e) => setCustomQ(e.target.value)}
          disabled={running}
          aria-label="Ask the persona a question"
        />
        <button
          type="submit"
          className="ask-submit serif italic"
          disabled={running || customQ.trim().length === 0}
          aria-label="Submit question"
        >
          ask <span className="ask-arrow">→</span>
        </button>
      </form>

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
            <Document
              card={activeCard}
              onRetry={() => activeIdx !== null && runOne(activeIdx)}
              layoutVersion={layoutVersion}
            />
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
          padding: 32px 56px 24px;
          gap: 24px;
        }
        .brand {
          display: flex;
          align-items: baseline;
          gap: 10px;
          min-width: 0;
        }
        .brand-mark {
          font-size: 26px;
          font-weight: 500;
          color: var(--ink);
          letter-spacing: -0.012em;
        }
        .brand-of {
          color: var(--mute);
          font-size: 14px;
          font-style: italic;
        }
        .brand-who {
          color: var(--ink-2);
          font-size: 14px;
          font-weight: 500;
          letter-spacing: -0.005em;
        }
        .run-all {
          display: inline-flex;
          align-items: baseline;
          gap: 8px;
          color: var(--ink);
          font-size: 13px;
          padding: 4px 0;
          border-bottom: 1px solid var(--ink);
          transition: color 120ms ease, border-color 120ms ease;
        }
        .run-all:hover {
          color: var(--accent);
          border-color: var(--accent);
        }
        .run-all .arrow {
          font-size: 14px;
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

        /* Sources strip — quiet hairline-bounded row, neutral palette */
        .sources {
          display: flex;
          align-items: baseline;
          gap: 18px;
          flex-wrap: wrap;
          padding: 14px 56px;
          border-top: 1px solid var(--rule-soft);
        }
        .sources-label {
          color: var(--mute);
          font-size: 10px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          flex-shrink: 0;
        }
        .sources-list {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 18px;
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .source {
          display: inline-flex;
          align-items: baseline;
          gap: 7px;
          font-size: 12px;
        }
        .source-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          display: inline-block;
          background: var(--mute-2);
          flex-shrink: 0;
          transform: translateY(-1px);
        }
        .source.is-connected .source-dot { background: var(--ink-3); }
        .source.is-disconnected .source-dot { background: var(--accent); opacity: 0.65; }
        .source.is-checking .source-dot { background: var(--ink-3); }
        .source.is-unknown .source-dot { background: var(--mute-2); opacity: 0.6; }
        .source-action {
          font-size: 12px;
          color: var(--ink-2);
          padding: 2px 0;
          border-bottom: 1px solid transparent;
          transition: color 120ms ease, border-color 120ms ease;
        }
        .source-action:hover:not(:disabled) {
          color: var(--accent);
          border-bottom-color: var(--accent);
        }
        .source-action:disabled { color: var(--mute); cursor: default; }
        .source-action--connect {
          color: var(--accent);
          border-bottom: 1px solid var(--accent);
        }
        .source-action--connect:hover {
          color: #a1462e;
          border-bottom-color: #a1462e;
        }
        .source-msg {
          font-size: 11px;
          color: var(--ink-3);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.01em;
        }
        .source-msg--error { color: var(--differs); }

        /* Ask form — no card, hairline-bounded strip */
        .ask {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 16px 56px;
          margin: 0;
          border-top: 1px solid var(--rule-soft);
          border-bottom: 1px solid var(--rule-soft);
          transition: background-color 120ms ease;
        }
        .ask:focus-within { background-color: rgba(193, 88, 58, 0.025); }
        .ask-label {
          color: var(--ink-3);
          font-size: 13px;
          letter-spacing: 0.01em;
          flex-shrink: 0;
        }
        .ask-input {
          flex: 1;
          min-width: 0;
          border: none;
          background: transparent;
          color: var(--ink);
          font-size: 16px;
          font-family: var(--font-serif);
          outline: none;
          padding: 4px 0;
        }
        .ask-input::placeholder {
          color: var(--mute);
          font-style: italic;
        }
        .ask-input:disabled { opacity: 0.5; }
        .ask-submit {
          color: var(--accent);
          font-size: 14px;
          padding: 4px 0;
          border-bottom: 1px solid var(--accent);
          background: transparent;
          flex-shrink: 0;
          display: inline-flex;
          align-items: baseline;
          gap: 6px;
          transition: color 120ms ease, border-color 120ms ease;
        }
        .ask-submit:hover:not(:disabled) { color: #a1462e; border-color: #a1462e; }
        .ask-submit:disabled { color: var(--mute); border-color: var(--rule); cursor: not-allowed; }
        .ask-arrow { font-size: 16px; line-height: 1; }
        @media (max-width: 720px) {
          .sources { padding: 12px 18px; gap: 10px 14px; }
          .ask { padding: 14px 18px; gap: 10px; }
          .ask-label { display: none; }
          .ask-input { font-size: 15px; }
        }
        .split {
          display: grid;
          grid-template-columns: 360px 1fr;
          flex: 1;
          min-height: 0;
          padding: 48px 56px 64px;
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
          .top { padding: 22px 18px 14px; flex-direction: column; align-items: flex-start; gap: 8px; }
          .brand { gap: 8px; flex-wrap: wrap; }
          .brand-mark { font-size: 22px; }
          .brand-who { font-size: 13px; }
          .run-all { margin-top: 2px; }
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
  const isCustom = !card.question.ground_truth
  const correct = card.status === "done" && !isCustom && isMatch(card.answer, card.question.ground_truth)
  const num = pad2(index + 1)

  let trail: { text: string; tone: "match" | "differs" | "running" | "idle" | "error" } = {
    text: "—",
    tone: "idle",
  }
  if (card.status === "running") trail = { text: "thinking…", tone: "running" }
  else if (card.status === "done") {
    if (isCustom) {
      trail = { text: `answered · ${formatSeconds(card.total_ms)}`, tone: "match" }
    } else {
      trail = correct
        ? { text: `matched · ${formatSeconds(card.total_ms)}`, tone: "match" }
        : { text: `differs · ${formatSeconds(card.total_ms)}`, tone: "differs" }
    }
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
        An agent that answers <em>as WeiWei</em>.
      </h1>
      <p>
        Twenty questions, drawn from WeiWei&apos;s Gmail, Calendar, Slack, GitHub, Drive, Docs, Sheets, LinkedIn,
        YouTube, Discord, and Instagram. The agent classifies each query, rewrites it, searches Atlas Vector,
        re-ranks, and synthesizes an answer in WeiWei&apos;s voice. Every step shows.
      </p>
      <p className="cold-ask">
        Or just ask your own — the input is up top.
      </p>
      <button className="start" onClick={onStart}>
        Begin with the first question <span aria-hidden>→</span>
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
        .cold-ask {
          color: var(--mute);
          font-size: 14px;
          font-style: italic;
          margin-top: -8px;
        }
        .start {
          align-self: flex-start;
          margin-top: 8px;
          font-family: var(--font-sans);
          font-size: 14px;
          color: var(--accent);
          padding: 4px 0;
          border-bottom: 1px solid var(--accent);
          letter-spacing: 0.005em;
          transition: color 120ms ease, border-color 120ms ease;
        }
        .start:hover { color: #a1462e; border-color: #a1462e; }
      `}</style>
    </article>
  )
}

function Document({
  card,
  onRetry,
  layoutVersion,
}: {
  card: CardState
  onRetry: () => void
  layoutVersion: number
}) {
  const { question, events, answer, status, total_ms, error_message } = card
  const isCustom = !question.ground_truth
  const correct = status === "done" && !isCustom && isMatch(answer, question.ground_truth)

  return (
    <article className="doc fade-up" key={card.question.id}>
      <h1 className="serif">{question.question}</h1>

      {status === "error" ? (
        <section className="errsec">
          <p className="serif italic">The agent couldn&apos;t complete this question.</p>
          <p className="errmsg">{error_message ?? "unknown error"}</p>
          <button className="retry" onClick={onRetry}>Try again <span aria-hidden>→</span></button>
        </section>
      ) : (
        <>
          <ClassifyChip events={events} />
          <VectorField events={events} status={status} layoutVersion={layoutVersion} />
          <CandidateBars events={events} />
        </>
      )}

      {status !== "error" && (
        <section className="verdict">
          {status === "done" ? (
            isCustom ? (
              <span className="verdict-rule serif italic match">
                — answered{total_ms ? ` · ${formatSeconds(total_ms)}` : ""} —
              </span>
            ) : (
              <span className={`verdict-rule serif italic ${correct ? "match" : "differs"}`}>
                — {correct ? "matched" : "differs"}{total_ms ? ` · ${formatSeconds(total_ms)}` : ""} —
              </span>
            )
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
          {status === "done" && !isCustom && !correct && (
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
          font-family: var(--font-sans);
          font-size: 13px;
          letter-spacing: 0.005em;
          transition: color 120ms ease, border-color 120ms ease;
        }
        .retry:hover { color: #a1462e; border-color: #a1462e; }
        @media (max-width: 720px) {
          h1 { font-size: 30px; }
          .agent { font-size: 19px; }
        }
      `}</style>
    </article>
  )
}

// ─── Vector field — agent traversal of the embedding space ─────────────────

const SOURCE_LABEL: Record<string, string> = {
  gmail_msgs: "Gmail",
  calendar_events: "Calendar",
  slack_msgs: "Slack",
  notion_docs: "Notion",
  github_activity: "GitHub",
  gdrive_files: "Drive",
  gdocs_pages: "Docs",
  gsheets_sheets: "Sheets",
  linkedin_profile: "LinkedIn",
  youtube_activity: "YouTube",
  discord_servers: "Discord",
  instagram_posts: "Instagram",
  maps_history: "Maps",
  photos_meta: "Photos",
}

const MODE_LABEL: Record<string, string> = {
  hybrid: "Hybrid",
  vector: "Vector",
  text: "Text",
}

const SOURCE_COLOR: Record<string, string> = {
  gmail_msgs: "#c97e3a",
  calendar_events: "#5d7d5e",
  slack_msgs: "#7e5a8a",
  notion_docs: "#a08856",
  github_activity: "#5b5b5b",
  gdrive_files: "#3b6fb6",
  gdocs_pages: "#4574c4",
  gsheets_sheets: "#3a8a4f",
  linkedin_profile: "#0a66c2",
  youtube_activity: "#cc3c3c",
  discord_servers: "#5865f2",
  instagram_posts: "#e1306c",
  maps_history: "#a85842",
  photos_meta: "#b06a82",
}

interface VectorPoint {
  id: string
  source: string
  x: number
  y: number
  ts: string
  preview: string
}

interface VectorLayout {
  points: VectorPoint[]
  generated_at: string
  count_by_source: Record<string, number>
}

type Phase =
  | {
      kind: "search"
      ordinal: number
      tool_use_id: string
      collection: string
      query: string
      mode: string
      hit_ids: string[]
      ms: number
    }
  | {
      kind: "rerank"
      tool_use_id: string
      criterion: string
      hit_ids: string[]
      narrows: number | null
    }
  | {
      kind: "cross_reference"
      tool_use_id: string
      on: string
      hit_ids: string[]
      narrows: number | null
    }

type ParsedTrace = {
  classify?: { strategy: string }
  phases: Phase[]
  liveSearchOrdinal: number | null
  cited: string[]
  synthesizeCount: number
  hasAnswer: boolean
}

function parseVectorTrace(events: TraceEvent[], status: Status): ParsedTrace {
  const phases: Phase[] = []
  const callArgs = new Map<string, Record<string, unknown>>()
  let curSearch: number | null = null
  let cited: string[] = []
  let synthesizeCount = 0
  let hasAnswer = false
  let classify: ParsedTrace["classify"]

  let searchOrdinal = 0

  for (const e of events) {
    if (e.type === "classify") {
      classify = { strategy: e.strategy }
    } else if (e.type === "tool_call") {
      callArgs.set(e.tool_use_id, e.args)
    } else if (e.type === "tool_result") {
      const args = callArgs.get(e.tool_use_id) ?? {}
      if (e.tool === "search") {
        searchOrdinal++
        phases.push({
          kind: "search",
          ordinal: searchOrdinal,
          tool_use_id: e.tool_use_id,
          collection: (args.collection as string) ?? "unknown",
          query: (args.query as string) ?? "",
          mode: (args.mode as string) ?? "hybrid",
          hit_ids: e.hit_ids ?? [],
          ms: e.latency_ms,
        })
        curSearch = phases.length - 1
      } else if (e.tool === "rerank") {
        phases.push({
          kind: "rerank",
          tool_use_id: e.tool_use_id,
          criterion: (args.criterion as string) ?? "relevance",
          hit_ids: e.hit_ids ?? [],
          narrows: curSearch,
        })
      } else if (e.tool === "cross_reference") {
        phases.push({
          kind: "cross_reference",
          tool_use_id: e.tool_use_id,
          on: (args.on as string) ?? "topic",
          hit_ids: e.hit_ids ?? [],
          narrows: curSearch,
        })
      } else if (e.tool === "summarize_for_answer") {
        synthesizeCount++
      }
    } else if (e.type === "answer") {
      hasAnswer = true
      cited = e.citation_ids
    }
  }

  const isLive = status === "running"
  const liveSearchOrdinal =
    isLive && !hasAnswer
      ? phases.filter((p) => p.kind === "search").at(-1)?.ordinal ?? null
      : null

  return { classify, phases, liveSearchOrdinal, cited, synthesizeCount, hasAnswer }
}

function VectorField({
  events,
  status,
  layoutVersion = 0,
}: {
  events: TraceEvent[]
  status: Status
  layoutVersion?: number
}) {
  const [layout, setLayout] = useState<VectorLayout | null>(null)
  const [layoutErr, setLayoutErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLayoutErr(null)
    fetch(`/api/persona/layout${layoutVersion > 0 ? `?v=${layoutVersion}` : ""}`)
      .then((r) => {
        if (!r.ok) throw new Error(`layout ${r.status}`)
        return r.json()
      })
      .then((data: VectorLayout) => {
        if (alive) setLayout(data)
      })
      .catch((e) => {
        if (alive) setLayoutErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [layoutVersion])

  const parsed = useMemo(() => parseVectorTrace(events, status), [events, status])
  const idIndex = useMemo(() => {
    const m = new Map<string, VectorPoint>()
    if (layout) for (const p of layout.points) m.set(p.id, p)
    return m
  }, [layout])

  const VB_W = 900
  const VB_H = 480
  const PAD_X = 32
  const PAD_Y = 44
  const GUTTER_W = 360
  const SCATTER_END = VB_W - GUTTER_W
  const projX = useCallback(
    (x: number) => PAD_X + ((x + 1) / 2) * (SCATTER_END - PAD_X * 2),
    [PAD_X, SCATTER_END],
  )
  const projY = useCallback((y: number) => PAD_Y + ((y + 1) / 2) * (VB_H - 2 * PAD_Y), [])

  // Per-point activation level. Last wave's hits are brightest; cited highest.
  const activation = useMemo(() => {
    const m = new Map<string, { level: number; phase: number; isCited: boolean }>()
    const searches = parsed.phases.filter((p) => p.kind === "search") as Extract<Phase, { kind: "search" }>[]
    searches.forEach((s, i) => {
      const isLatest = i === searches.length - 1
      const baseLvl = isLatest ? 1 : 0.55
      const denom = Math.max(s.hit_ids.length - 1, 1)
      s.hit_ids.forEach((id, rank) => {
        // Top hit = baseLvl, lowest = 0.6 * baseLvl
        const rankFactor = 1 - (rank / denom) * 0.4
        const lvl = baseLvl * rankFactor
        const cur = m.get(id)
        if (!cur || lvl > cur.level) m.set(id, { level: lvl, phase: i, isCited: false })
      })
    })
    // Reranks/cross-refs: don't add new points, but boost surviving ones.
    for (const p of parsed.phases) {
      if (p.kind === "rerank" || p.kind === "cross_reference") {
        for (const id of p.hit_ids) {
          const cur = m.get(id)
          if (cur) m.set(id, { ...cur, level: Math.min(1, cur.level + 0.1) })
        }
      }
    }
    for (const id of parsed.cited) {
      const cur = m.get(id) ?? { level: 1, phase: searches.length - 1, isCited: false }
      m.set(id, { ...cur, level: 1, isCited: true })
    }
    return m
  }, [parsed])

  // Search-phase centroids for query whispers.
  const searchPhases = parsed.phases.filter((p) => p.kind === "search") as Extract<Phase, { kind: "search" }>[]
  const phaseCentroids = useMemo(() => {
    return searchPhases.map((p) => {
      const pts = p.hit_ids.map((id) => idIndex.get(id)).filter(Boolean) as VectorPoint[]
      if (pts.length === 0) return null
      let cx = 0
      let cy = 0
      for (const pt of pts) {
        cx += pt.x
        cy += pt.y
      }
      return { x: cx / pts.length, y: cy / pts.length, count: pts.length }
    })
  }, [searchPhases, idIndex])

  // Cross-reference edges: lines between matched ids.
  const crossEdges = useMemo(() => {
    const edges: Array<{ a: VectorPoint; b: VectorPoint }> = []
    for (const p of parsed.phases) {
      if (p.kind !== "cross_reference") continue
      const pts = p.hit_ids.map((id) => idIndex.get(id)).filter(Boolean) as VectorPoint[]
      // Connect each unique cross-source pair, dedup by id pair.
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i]!
          const b = pts[j]!
          if (a.source !== b.source) edges.push({ a, b })
        }
      }
    }
    return edges
  }, [parsed.phases, idIndex])

  if (!layout && !layoutErr) {
    return (
      <figure className="vfield">
        <div className="vfield-empty serif italic">building the index map…</div>
        <style jsx>{`
          .vfield { margin: 0; padding: 8px 0; }
          .vfield-empty {
            min-height: 280px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--mute);
            font-size: 14px;
          }
        `}</style>
      </figure>
    )
  }

  if (layoutErr) {
    return (
      <figure className="vfield">
        <div className="vfield-empty serif italic">
          couldn&apos;t load the index map — {layoutErr}
        </div>
        <style jsx>{`
          .vfield { margin: 0; padding: 8px 0; }
          .vfield-empty {
            min-height: 240px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--differs);
            font-size: 13px;
          }
        `}</style>
      </figure>
    )
  }

  const points = layout!.points
  const isLive = status === "running"

  return (
    <figure className="vfield">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="The agent activating vectors across the embedding space"
      >
        <defs>
          <radialGradient id="halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="white" stopOpacity="0.35" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <filter id="soft-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
        </defs>

        {/* Cross-reference chord lines, drawn underneath. */}
        {crossEdges.map((e, i) => (
          <line
            key={`xr-${i}`}
            x1={projX(e.a.x)}
            y1={projY(e.a.y)}
            x2={projX(e.b.x)}
            y2={projY(e.b.y)}
            stroke="var(--accent)"
            strokeOpacity="0.6"
            strokeWidth="1"
            className="fade-up"
          />
        ))}

        {/* The full vector field — every chunk in the index. */}
        {points.map((p) => {
          const a = activation.get(p.id)
          const lvl = a?.level ?? 0
          const color = SOURCE_COLOR[p.source] ?? "var(--mute)"
          const baseOpacity = 0.22
          const r = lvl > 0 ? 3.2 + lvl * 1.6 : 1.8
          const op = lvl > 0 ? Math.min(1, 0.7 + lvl * 0.3) : baseOpacity
          return (
            <g key={p.id}>
              {a?.isCited && (
                <circle
                  cx={projX(p.x)}
                  cy={projY(p.y)}
                  r={11}
                  fill="none"
                  stroke={color}
                  strokeWidth="1.2"
                  strokeOpacity="0.85"
                />
              )}
              {lvl > 0.5 && (
                <circle
                  cx={projX(p.x)}
                  cy={projY(p.y)}
                  r={r * 2}
                  fill={color}
                  opacity={0.32}
                  filter="url(#soft-glow)"
                  className={a?.isCited || isLive ? "vec-pulse" : ""}
                />
              )}
              <circle
                cx={projX(p.x)}
                cy={projY(p.y)}
                r={r}
                fill={color}
                opacity={op}
                stroke={lvl > 0 ? color : "none"}
                strokeWidth={lvl > 0 ? 0.6 : 0}
                strokeOpacity={lvl > 0 ? 0.9 : 0}
              >
                <title>{`${SOURCE_LABEL[p.source] ?? p.source} · ${p.preview}`}</title>
              </circle>
            </g>
          )
        })}

        {/* Right-side gutter: each search phase becomes a row with its query.
            A connector runs from the row's left edge to the phase centroid
            in the scatter. */}
        {(() => {
          const phasesWithCentroid = searchPhases
            .map((phase, i) => ({ phase, centroid: phaseCentroids[i] }))
            .filter((x) => x.centroid !== null)
          if (phasesWithCentroid.length === 0) return null

          const GUTTER_X = SCATTER_END + 18
          const ROW_H = Math.min(
            38,
            Math.max(28, (VB_H - PAD_Y * 2 - 8) / phasesWithCentroid.length),
          )
          const startY = PAD_Y + 8

          return phasesWithCentroid.map(({ phase, centroid }, k) => {
            const cx = projX(centroid!.x)
            const cy = projY(centroid!.y)
            const rowYTop = startY + k * ROW_H
            const rowYMid = rowYTop + 6
            const isLive_ = parsed.liveSearchOrdinal === phase.ordinal
            const q = phase.query
            const display = q.length > 46 ? q.slice(0, 45) + "…" : q
            const color = SOURCE_COLOR[phase.collection] ?? "var(--mute-2)"
            // Smoothly bend connector from the centroid up/down to the row.
            const path = `M ${cx} ${cy} C ${(cx + GUTTER_X) / 2} ${cy}, ${GUTTER_X - 30} ${rowYMid}, ${GUTTER_X - 6} ${rowYMid}`
            return (
              <g key={`q-${phase.tool_use_id}`} className="fade-up">
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeOpacity={isLive_ ? 0.95 : 0.55}
                  strokeWidth={isLive_ ? 1.2 : 0.9}
                />
                <circle cx={GUTTER_X - 4} cy={rowYMid} r={2.5} fill={color} />
                <text
                  x={GUTTER_X + 4}
                  y={rowYTop + 4}
                  className={`q-whisper ${isLive_ ? "live-rail" : ""}`}
                  fill={color}
                >
                  #{phase.ordinal} &ldquo;{display}&rdquo;
                </text>
                <text
                  x={GUTTER_X + 4}
                  y={rowYTop + 18}
                  className="q-meta"
                >
                  {SOURCE_LABEL[phase.collection] ?? phase.collection} · {phase.hit_ids.length} · {MODE_LABEL[phase.mode] ?? phase.mode}
                </text>
              </g>
            )
          })
        })()}

        {/* Source legend — wraps to additional rows when the labels don't fit
            in a single horizontal line. */}
        {(() => {
          const sources = Object.entries(layout!.count_by_source).filter(([, n]) => n > 0)
          const ROW_H = 18
          const gap = 14
          const startX = 12
          const maxX = VB_W - 12
          let cursorX = startX
          let row = 0
          return (
            <g>
              {sources.map(([src, n]) => {
                const label = `${SOURCE_LABEL[src] ?? src} · ${n}`
                const itemWidth = 8 + label.length * 6.2 + gap
                if (cursorX + itemWidth > maxX) {
                  cursorX = startX
                  row++
                }
                const x = cursorX
                const y = 16 + row * ROW_H
                cursorX += itemWidth
                return (
                  <g key={src}>
                    <circle cx={x} cy={y} r="3.5" fill={SOURCE_COLOR[src]} />
                    <text
                      x={x + 8}
                      y={y + 4}
                      className="src-label"
                      fill={SOURCE_COLOR[src]}
                    >
                      {label}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })()}

        {/* Status footer text — anchored under the scatter region. */}
        <g transform={`translate(${SCATTER_END / 2}, ${VB_H - 12})`}>
          <text textAnchor="middle" className="footer">
            {parsed.hasAnswer
              ? `${parsed.cited.length} cited · ${searchPhases.length} ${searchPhases.length === 1 ? "search" : "searches"}`
              : isLive
                ? searchPhases.length === 0
                  ? "the agent is choosing where to look…"
                  : `searching · ${searchPhases.length} so far`
                : "—"}
          </text>
        </g>
      </svg>

      <style jsx>{`
        .vfield {
          margin: 0 -180px 0 0;
          padding: 8px 0;
          width: calc(100% + 180px);
          max-width: calc(100% + 180px);
        }
        .vfield svg {
          width: 100%;
          height: auto;
          max-height: 520px;
          display: block;
          font-family: var(--font-sans);
        }
        @media (max-width: 1280px) {
          .vfield {
            margin-right: 0;
            width: 100%;
            max-width: 100%;
          }
        }
      `}</style>
      <style jsx global>{`
        .vfield .q-whisper {
          font-family: var(--font-serif);
          font-style: italic;
          font-size: 13px;
          font-weight: 500;
          letter-spacing: 0.005em;
        }
        .vfield .q-meta {
          font-family: var(--font-sans);
          font-size: 11px;
          fill: var(--ink-3);
          letter-spacing: 0.005em;
        }
        .vfield .src-label {
          font-family: var(--font-sans);
          font-size: 11px;
          letter-spacing: 0.005em;
        }
        .vfield .footer {
          font-family: var(--font-serif);
          font-style: italic;
          font-size: 13px;
          fill: var(--ink-3);
          letter-spacing: 0.01em;
        }
        @keyframes vec-pulse-anim {
          0%, 100% { opacity: 0.32; }
          50% { opacity: 0.6; }
        }
        .vfield .vec-pulse { animation: vec-pulse-anim 1.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .vfield .vec-pulse { animation: none; }
        }
      `}</style>
    </figure>
  )
}

// ─── Classify chip — surfaces R1's category prediction ─────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  recall: "Recall",
  preference: "Preference",
  opinion: "Opinion",
  decision: "Decision",
  voice: "Voice",
  prediction: "Prediction",
}

function ClassifyChip({ events }: { events: TraceEvent[] }) {
  const classify = events.find((e) => e.type === "classify") as
    | Extract<TraceEvent, { type: "classify" }>
    | undefined
  if (!classify) return null
  const label = CATEGORY_LABEL[classify.strategy] ?? classify.strategy
  return (
    <div className="classify fade-up">
      <span className="classify-key serif italic">classified as</span>
      <span className="classify-val">{label}</span>
      {classify.reasoning && (
        <span className="classify-why serif italic">— {classify.reasoning}</span>
      )}
      <style jsx>{`
        .classify {
          display: flex;
          align-items: baseline;
          gap: 8px;
          font-size: 12px;
          color: var(--ink-3);
          padding: 4px 0 0;
          flex-wrap: wrap;
        }
        .classify-key { color: var(--mute); font-size: 12px; }
        .classify-val {
          color: var(--accent);
          font-family: var(--font-serif);
          font-style: italic;
          font-weight: 500;
          font-size: 13px;
          letter-spacing: 0.005em;
        }
        .classify-why {
          color: var(--ink-3);
          font-size: 12px;
          flex: 1;
          min-width: 0;
        }
      `}</style>
    </div>
  )
}

// ─── Candidate bars — score-ranked top-K from latest hit-producing tool ────

function describeScore(
  ev: Extract<TraceEvent, { type: "tool_result" }>,
  args: Record<string, unknown> | undefined,
): string {
  if (ev.tool === "rerank") {
    const criterion = (args?.criterion as string) ?? "relevance"
    const hasQuery = typeof args?.query === "string" && (args.query as string).length > 0
    if (criterion === "relevance" && hasQuery) return "LLM 0–10"
    if (criterion === "recency") return "recency 0–1"
    if (criterion === "sentiment_negative") return "negativity"
    if (criterion === "sentiment_positive") return "positivity"
    if (criterion === "authorship_user") return "authored by you"
    return "rerank score"
  }
  if (ev.tool === "search") {
    const mode = (args?.mode as string) ?? "hybrid"
    if (mode === "vector") return "cosine"
    if (mode === "text") return "BM25"
    return "RRF 0–1"
  }
  if (ev.tool === "cross_reference") return "shared attribute"
  return "score"
}

function CandidateBars({ events }: { events: TraceEvent[] }) {
  const latest = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (
        e.type === "tool_result" &&
        e.candidates &&
        e.candidates.length > 0 &&
        e.tool !== "summarize_for_answer"
      ) {
        return e as Extract<TraceEvent, { type: "tool_result" }>
      }
    }
    return undefined
  }, [events])

  if (!latest || !latest.candidates) return null

  // Find the matching tool_call so we know the criterion (rerank) or mode (search).
  const callArgs = (() => {
    for (const e of events) {
      if (e.type === "tool_call" && e.tool_use_id === latest.tool_use_id) return e.args
    }
    return undefined
  })()

  // Sort by score descending so bar lengths and row order always agree.
  const cands = [...latest.candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)

  const maxScore = Math.max(...cands.map((c) => c.score), 1e-6)
  const scoreLabel = describeScore(latest, callArgs)

  return (
    <section className="cands fade-up">
      <div className="cands-head serif italic">
        — top candidates · <span className="cands-tool">{latest.tool}</span>
        {" · "}
        <span className="cands-meta">{scoreLabel}</span>
        {" "}
        <span className="cands-count">({cands.length})</span>
      </div>
      <ul className="cand-list">
        {cands.map((c, i) => {
          // Bar = score / max within this set. Tight clusters look tight,
          // wide spreads look wide — honest about the underlying signal.
          const pct = Math.max(4, Math.round((c.score / maxScore) * 100))
          const srcLabel = SOURCE_LABEL[c.source ?? ""] ?? c.source ?? "?"
          const isTop = i === 0
          return (
            <li key={c.id} className={`cand-row ${isTop ? "is-top" : ""}`}>
              <span className="cand-rank tnum">#{i + 1}</span>
              <span className="cand-src">{srcLabel}</span>
              <span className="cand-score tnum">{c.score.toFixed(2)}</span>
              <div className="cand-bar-wrap">
                <div className="cand-bar" style={{ width: `${pct}%` }} />
              </div>
              <span className="cand-preview" title={c.text_preview}>
                {c.text_preview}
              </span>
            </li>
          )
        })}
      </ul>
      <style jsx>{`
        .cands {
          padding: 8px 0 4px;
          margin-top: -8px;
        }
        .cands-head {
          font-family: var(--font-sans);
          font-size: 11px;
          color: var(--mute);
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 10px;
          font-style: normal;
        }
        .cands-tool {
          color: var(--ink-2);
          font-style: normal;
          font-family: var(--font-sans);
        }
        .cands-meta {
          color: var(--ink-3);
          font-family: var(--font-sans);
          font-size: 11px;
          letter-spacing: 0.04em;
        }
        .cands-count {
          color: var(--mute);
          font-style: normal;
        }
        .cand-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .cand-row {
          display: grid;
          grid-template-columns: 28px 70px 44px 90px 1fr;
          gap: 10px;
          align-items: center;
          font-size: 12px;
          line-height: 1.3;
        }
        .cand-rank {
          color: var(--mute);
          font-family: var(--font-sans);
          font-variant-numeric: tabular-nums;
          font-size: 11px;
          text-align: right;
          letter-spacing: 0.01em;
        }
        .cand-src {
          font-family: var(--font-sans);
          font-size: 12px;
          color: var(--ink-3);
          letter-spacing: 0.005em;
        }
        .cand-row.is-top .cand-src { color: var(--ink); }
        .cand-score {
          font-family: var(--font-sans);
          font-variant-numeric: tabular-nums;
          font-size: 12px;
          color: var(--ink-2);
          text-align: right;
        }
        .cand-bar-wrap {
          height: 4px;
          background: var(--rule-soft);
          border-radius: 0;
          overflow: hidden;
        }
        .cand-bar {
          height: 100%;
          background: var(--ink-3);
          opacity: 0.4;
          transition: width 240ms ease;
        }
        .cand-row.is-top .cand-bar {
          background: var(--accent);
          opacity: 0.7;
        }
        .cand-preview {
          color: var(--ink-3);
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        @media (max-width: 720px) {
          .cand-row {
            grid-template-columns: 24px 60px 40px 1fr;
          }
          .cand-preview { display: none; }
        }
      `}</style>
    </section>
  )
}
