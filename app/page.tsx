"use client"

import { useEffect, useState, useCallback } from "react"
import type { BenchmarkQuestion, TraceEvent } from "@/lib/schemas"

type CardState = {
  question: BenchmarkQuestion
  events: TraceEvent[]
  answer: string
  status: "idle" | "running" | "done" | "error" | "timeout"
  total_ms?: number
  expanded: boolean
}

export default function Page() {
  const [cards, setCards] = useState<CardState[]>([])
  const [running, setRunning] = useState(false)

  useEffect(() => {
    fetch("/api/persona/questions")
      .then((r) => r.json())
      .then((qs: BenchmarkQuestion[]) => {
        setCards(qs.map((q) => ({ question: q, events: [], answer: "", status: "idle", expanded: false })))
      })
  }, [])

  const runOne = useCallback(async (idx: number, question: string) => {
    setCards((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], status: "running", events: [], answer: "" }
      return next
    })

    const res = await fetch("/api/persona/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    })

    if (!res.body) return

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
              answer: payload.result.answer,
              status: payload.result.status === "done" ? "done" : payload.result.status,
              total_ms: payload.result.total_ms,
            }
            return next
          })
        } else {
          setCards((prev) => {
            const next = [...prev]
            const ev = payload as TraceEvent
            next[idx] = { ...next[idx], events: [...next[idx].events, ev] }
            if (ev.type === "answer") {
              next[idx].answer = ev.text
            }
            return next
          })
        }
      }
    }
  }, [])

  const runAll = useCallback(async () => {
    setRunning(true)
    await Promise.all(cards.map((c, i) => runOne(i, c.question.question)))
    setRunning(false)
  }, [cards, runOne])

  const toggle = useCallback((idx: number) => {
    setCards((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], expanded: !next[idx].expanded }
      return next
    })
  }, [])

  return (
    <main style={{ padding: "32px", maxWidth: "1400px", margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 600 }}>persona</h1>
          <p style={{ color: "#888", marginTop: "4px" }}>
            agentic adaptive retrieval · {cards.length} questions ·{" "}
            {cards.filter((c) => c.status === "done").length} done
          </p>
        </div>
        <button onClick={runAll} disabled={running || cards.length === 0}>
          {running ? "running…" : "run all"}
        </button>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
          gap: "12px",
        }}
      >
        {cards.map((c, i) => (
          <Card key={c.question.id} state={c} onToggle={() => toggle(i)} onRun={() => runOne(i, c.question.question)} />
        ))}
      </div>
    </main>
  )
}

function Card({ state, onToggle, onRun }: { state: CardState; onToggle: () => void; onRun: () => void }) {
  const { question, events, answer, status, total_ms, expanded } = state
  const toolCalls = events.filter((e) => e.type === "tool_call").length

  return (
    <div
      style={{
        border: "1px solid #2c2c33",
        borderRadius: "6px",
        background: "#131318",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "#888", fontSize: "11px" }}>
          {question.id} · {question.category}
        </span>
        <span style={{ color: statusColor(status), fontSize: "11px" }}>
          {status}
          {total_ms ? ` · ${total_ms}ms` : ""}
          {toolCalls ? ` · ${toolCalls} calls` : ""}
        </span>
      </div>

      <div style={{ fontWeight: 500, color: "#e8e8ec" }}>{question.question}</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
        <Pane label="you" value={question.ground_truth} />
        <Pane label="agent" value={answer || (status === "running" ? "…" : "")} />
      </div>

      <div style={{ display: "flex", gap: "8px", justifyContent: "space-between" }}>
        <button onClick={onRun} disabled={status === "running"} style={{ fontSize: "11px", padding: "4px 10px" }}>
          {status === "running" ? "running" : "rerun"}
        </button>
        {events.length > 0 && (
          <button onClick={onToggle} style={{ fontSize: "11px", padding: "4px 10px" }}>
            {expanded ? "hide trace" : `show trace (${events.length})`}
          </button>
        )}
      </div>

      {expanded && events.length > 0 && (
        <div style={{ borderTop: "1px solid #2c2c33", paddingTop: "8px", fontSize: "11px", color: "#aaa" }}>
          {events.map((e, i) => (
            <div key={i} style={{ marginBottom: "4px" }}>
              <span style={{ color: eventColor(e.type) }}>{e.type}</span>
              {" · "}
              <span>{summarizeEvent(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Pane({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#0b0b0d", border: "1px solid #1f1f24", borderRadius: "4px", padding: "8px" }}>
      <div style={{ color: "#666", fontSize: "10px", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}
      </div>
      <div style={{ color: "#ddd", whiteSpace: "pre-wrap" }}>{value || "—"}</div>
    </div>
  )
}

function statusColor(status: CardState["status"]): string {
  switch (status) {
    case "done": return "#4ade80"
    case "running": return "#fbbf24"
    case "error":
    case "timeout": return "#f87171"
    default: return "#666"
  }
}

function eventColor(type: TraceEvent["type"]): string {
  switch (type) {
    case "tool_call": return "#fbbf24"
    case "tool_result": return "#60a5fa"
    case "answer": return "#4ade80"
    case "error": return "#f87171"
    default: return "#888"
  }
}

function summarizeEvent(e: TraceEvent): string {
  switch (e.type) {
    case "tool_call": return `${e.tool}(${JSON.stringify(e.args).slice(0, 100)})`
    case "tool_result": return `${e.tool} → ${e.result_summary} (${e.latency_ms}ms)`
    case "thinking": return e.text.slice(0, 150)
    case "answer": return e.text.slice(0, 150)
    case "classify": return `→ ${e.strategy}`
    case "error": return e.message
  }
}
