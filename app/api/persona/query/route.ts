import { runAgent } from "@/lib/agent/loop"
import { clearMemoryCache } from "@/lib/agent/tools"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const body = (await req.json()) as { question: string; user_name?: string }
  const { question, user_name } = body

  if (!question) {
    return new Response("missing question", { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        clearMemoryCache()
        const result = await runAgent(question, {
          userName: user_name,
          onEvent: (e) => send(e),
        })
        send({ type: "final", result })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        send({ type: "error", message: msg, t: 0 })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
