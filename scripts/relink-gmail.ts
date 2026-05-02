import { Composio } from "@composio/core"

const apiKey = process.env.COMPOSIO_API_KEY
const userId = process.env.COMPOSIO_USER_ID
if (!apiKey || !userId) throw new Error("missing composio env")
const client = new Composio({ apiKey })

function asAny<T>(x: T): any {
  return x as any
}

async function main() {
  const conns: any = await client.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: ["gmail"],
  })
  const items = conns.items ?? []
  console.log(`existing gmail connections: ${items.length}`)
  for (const c of items) {
    console.log(`  [${c.id}] status=${c.status}`)
    if (c.status !== "ACTIVE") {
      try {
        await asAny(client.connectedAccounts).delete(c.id)
        console.log(`    deleted ${c.id}`)
      } catch (err) {
        console.log(`    delete failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  const cfgs: any = await client.authConfigs.list({ toolkit: "gmail" })
  const cfg = cfgs.items?.[0]
  if (!cfg) {
    console.log("no gmail auth config — run scripts/fix-gmail-scopes.ts first")
    return
  }
  console.log(`using auth config: ${cfg.id}`)

  const link: any = await asAny(client.connectedAccounts).link(userId, cfg.id, {
    callbackUrl: "http://localhost:3000",
  })

  console.log("\n=== new OAuth link ===")
  console.log(link.redirectUrl)
  console.log("\nOpen in browser, complete the full flow, wait for the success page,")
  console.log("then run: bun scripts/debug-composio.ts accounts  (look for 'gmail ACTIVE')")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
