import { GoogleGenerativeAI, TaskType } from "@google/generative-ai"

const apiKey = process.env.GEMINI_API_KEY
const modelName = process.env.GEMINI_EMBED_MODEL ?? "text-embedding-004"

let _model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null

function model() {
  if (_model) return _model
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set")
  const genai = new GoogleGenerativeAI(apiKey)
  _model = genai.getGenerativeModel({ model: modelName })
  return _model
}

export const EMBED_DIM = 768

export async function embed(
  text: string,
  taskType: TaskType = TaskType.RETRIEVAL_DOCUMENT,
): Promise<number[]> {
  const m = model()
  const res = await m.embedContent({
    content: { parts: [{ text }], role: "user" },
    taskType,
  })
  return res.embedding.values
}

export async function embedQuery(text: string): Promise<number[]> {
  return embed(text, TaskType.RETRIEVAL_QUERY)
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (const t of texts) {
    out.push(await embed(t))
  }
  return out
}
