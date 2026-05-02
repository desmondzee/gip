import { Composio } from "@composio/core"

const apiKey = process.env.COMPOSIO_API_KEY
const userId = process.env.COMPOSIO_USER_ID
if (!apiKey || !userId) throw new Error("missing composio env")

const client = new Composio({ apiKey })

const sourceArg = process.argv[2] ?? "gmail"

async function gmail() {
  console.log(`\n=== GMAIL_FETCH_EMAILS for ${userId} ===`)
  const result: any = await client.tools.execute("GMAIL_FETCH_EMAILS", {
    userId,
    arguments: { max_results: 5 },
    dangerouslySkipVersionCheck: true,
  })
  console.log("top-level keys:", Object.keys(result ?? {}))
  console.log(JSON.stringify(result, null, 2).slice(0, 4000))
}

async function calendar() {
  console.log(`\n=== GOOGLECALENDAR_EVENTS_LIST for ${userId} ===`)
  const result: any = await client.tools.execute("GOOGLECALENDAR_EVENTS_LIST", {
    userId,
    arguments: { calendar_id: "primary", max_results: 5 },
    dangerouslySkipVersionCheck: true,
  })
  console.log("top-level keys:", Object.keys(result ?? {}))
  console.log(JSON.stringify(result, null, 2).slice(0, 4000))
}

async function slack() {
  console.log(`\n=== SLACK_LIST_CONVERSATIONS for ${userId} ===`)
  const result: any = await client.tools.execute("SLACK_LIST_CONVERSATIONS", {
    userId,
    arguments: { limit: 5 },
    dangerouslySkipVersionCheck: true,
  })
  console.log("top-level keys:", Object.keys(result ?? {}))
  console.log(JSON.stringify(result, null, 2).slice(0, 4000))
}

async function listConnected() {
  console.log(`\n=== connected accounts for ${userId} ===`)
  try {
    const accounts: any = await (client as any).connectedAccounts.list({ userIds: [userId] })
    const items = accounts?.items ?? []
    console.log(`${items.length} accounts:`)
    for (const it of items) {
      const slug = it.toolkit?.slug ?? "?"
      console.log(`  [${it.id}] ${slug.padEnd(20)} ${it.status}`)
    }
  } catch (e) {
    console.log("error listing accounts:", e instanceof Error ? e.message : e)
  }
}

if (sourceArg === "all") {
  await listConnected()
  await gmail()
  await calendar()
  await slack()
} else if (sourceArg === "accounts") {
  await listConnected()
} else if (sourceArg === "gmail") {
  await gmail()
} else if (sourceArg === "calendar") {
  await calendar()
} else if (sourceArg === "slack") {
  await slack()
} else {
  console.log("usage: bun scripts/debug-composio.ts [accounts|gmail|calendar|slack|all]")
}
