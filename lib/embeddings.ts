const apiKey = process.env.GEMINI_API_KEY
const modelName = process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001"

export const EMBED_DIM = Number(process.env.GEMINI_EMBED_DIM ?? "768")

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta"

interface EmbedResponse {
  embedding: { values: number[] }
}

interface BatchEmbedResponse {
  embeddings: { values: number[] }[]
}

export type TaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"

export async function embed(text: string, taskType: TaskType = "RETRIEVAL_DOCUMENT"): Promise<number[]> {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set")
  const url = `${ENDPOINT}/models/${modelName}:embedContent?key=${apiKey}`
  const body = {
    model: `models/${modelName}`,
    content: { parts: [{ text }] },
    taskType,
    outputDimensionality: EMBED_DIM,
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Gemini embed failed: ${res.status} ${res.statusText}: ${text}`)
  }
  const json = (await res.json()) as EmbedResponse
  return json.embedding.values
}

export async function embedQuery(text: string): Promise<number[]> {
  return embed(text, "RETRIEVAL_QUERY")
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set")
  if (texts.length === 0) return []
  const url = `${ENDPOINT}/models/${modelName}:batchEmbedContents?key=${apiKey}`
  const body = {
    requests: texts.map((text) => ({
      model: `models/${modelName}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: EMBED_DIM,
    })),
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini batch embed failed: ${res.status} ${res.statusText}: ${errText}`)
  }
  const json = (await res.json()) as BatchEmbedResponse
  return json.embeddings.map((e) => e.values)
}
