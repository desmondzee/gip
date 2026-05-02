import { Composio } from "@composio/core"

const apiKey = process.env.COMPOSIO_API_KEY
const userId = process.env.COMPOSIO_USER_ID
if (!apiKey || !userId) throw new Error("missing composio env")
const client = new Composio({ apiKey })

function asAny<T>(x: T): any {
  return x as any
}

async function main() {
  console.log("=== ALL Gmail auth configs ===")
  const cfgs: any = await client.authConfigs.list({ toolkit: "gmail" })
  for (const c of cfgs.items ?? []) {
    console.log(`\n[${c.id}]`)
    console.log(JSON.stringify(c, null, 2))
  }

  console.log("\n=== Latest Gmail connection (any status) ===")
  const conns: any = await client.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: ["gmail"],
  })
  const items = conns.items ?? []
  for (const c of items) {
    console.log(`\n[${c.id}] status=${c.status}`)
    console.log(JSON.stringify(c, null, 2).slice(0, 3000))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
