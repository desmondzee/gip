import type { ObjectId } from "mongodb"
import type { SourceName } from "./db"

export interface Memory {
  _id?: ObjectId
  source: SourceName
  external_id: string
  ts: Date
  text: string
  embedding?: number[]
  metadata: Record<string, unknown>
  ingested_at?: Date
}

export interface SearchHit {
  _id: string
  source: SourceName
  external_id: string
  ts: Date
  text: string
  metadata: Record<string, unknown>
  score: number
  match_kind: "vector" | "text" | "hybrid"
}

export interface CandidateScore {
  id: string
  score: number
  match_kind: "vector" | "text" | "hybrid"
  ts?: Date
  source?: SourceName
  text_preview?: string
}

export interface RetrievalTrace {
  question_id: string
  question_text: string
  category: QuestionCategory
  events: TraceEvent[]
  answer?: string
  citations?: SearchHit[]
  ground_truth?: string
  total_ms?: number
  status: "pending" | "running" | "done" | "error" | "timeout"
}

export type TraceEvent =
  | { type: "classify"; strategy: string; reasoning: string; t: number }
  | {
      type: "tool_call"
      tool_use_id: string
      tool: ToolName
      args: Record<string, unknown>
      t: number
    }
  | {
      type: "tool_result"
      tool_use_id: string
      tool: ToolName
      result_summary: string
      latency_ms: number
      t: number
      hit_ids?: string[]
      candidates?: CandidateScore[]
    }
  | { type: "thinking"; text: string; t: number }
  | { type: "answer"; text: string; citation_ids: string[]; t: number }
  | { type: "error"; message: string; t: number }

export type ToolName =
  | "search"
  | "rerank"
  | "rechunk"
  | "cross_reference"
  | "summarize_for_answer"

export type QuestionCategory =
  | "recall"
  | "preference"
  | "opinion"
  | "decision"
  | "voice"
  | "prediction"

export interface BenchmarkQuestion {
  id: string
  category: QuestionCategory
  question: string
  ground_truth: string
  notes?: string
}

export interface BenchmarkRun {
  _id?: ObjectId
  run_id: string
  started_at: Date
  finished_at?: Date
  memory_snapshot: "small" | "full"
  approach: "templates" | "agentic"
  results: RetrievalTrace[]
}
