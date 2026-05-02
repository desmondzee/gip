import Anthropic from "@anthropic-ai/sdk"
import type { QuestionCategory } from "../schemas"

const CLASSIFIER_MODEL = process.env.ANTHROPIC_CLASSIFIER_MODEL ?? "claude-haiku-4-5"

let _client: Anthropic | null = null
function client(): Anthropic {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set")
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

const VALID_CATEGORIES: readonly QuestionCategory[] = [
  "recall",
  "preference",
  "opinion",
  "decision",
  "voice",
  "prediction",
]

export interface Classification {
  category: QuestionCategory
  reasoning: string
}

export async function classifyQuestion(question: string): Promise<Classification> {
  const prompt = `Classify this question into ONE of these categories:
  - recall: asking about a specific past event or fact ("what did I think of X?", "who was at Y?")
  - preference: asking about a stable like/dislike ("what's my favorite X?", "do I prefer A or B?")
  - opinion: asking what the person thinks about a topic ("what do I think about X?")
  - decision: asking what to do ("should I do X?", "is now a good time to Y?")
  - voice: asking the persona to respond in their voice to something ("respond as me to X")
  - prediction: asking what the persona would say in a hypothetical ("what would I have said in X?")

Reply with ONLY a JSON object on a single line: {"category": "...", "reasoning": "<one short sentence on why>"}.

Question: ${question}`

  try {
    const res = await client().messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    })
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return fallback("no JSON in response")
    const parsed = JSON.parse(match[0]) as { category?: string; reasoning?: string }
    if (
      !parsed.category ||
      !VALID_CATEGORIES.includes(parsed.category as QuestionCategory)
    ) {
      return fallback(`invalid category: ${parsed.category}`)
    }
    return {
      category: parsed.category as QuestionCategory,
      reasoning: (parsed.reasoning ?? "").trim(),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fallback(`classifier error: ${msg}`)
  }
}

function fallback(why: string): Classification {
  return { category: "recall", reasoning: `(fallback: ${why})` }
}
