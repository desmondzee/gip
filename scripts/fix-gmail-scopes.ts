import { Composio, AuthConfigTypes } from "@composio/core"

const apiKey = process.env.COMPOSIO_API_KEY
const userId = process.env.COMPOSIO_USER_ID
if (!apiKey || !userId) throw new Error("missing composio env")

const client = new Composio({ apiKey })

const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]

const CB_DEFAULT = "http://localhost:3000"

function asAny<T>(x: T): any {
  return x as any
}

async function main() {
  console.log(`Composio Gmail scope repair for user: ${userId}\n`)

  // 1. Show current Gmail auth configs
  console.log("== existing Gmail auth configs ==")
  const cfgList: any = await client.authConfigs.list({ toolkit: "gmail" })
  for (const c of cfgList.items ?? []) {
    const scopes = c.config?.scopes ?? c.scopes ?? c.fields?.scopes ?? "?"
    const managed = c.isComposioManaged ?? c.is_composio_managed ?? "?"
    console.log(`  [${c.id}] managed=${managed} scopes=${JSON.stringify(scopes).slice(0, 200)}`)
  }

  // 2. List Gmail connections for this user
  console.log("\n== current Gmail connections ==")
  const connList: any = await client.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: ["gmail"],
  })
  const conns = connList.items ?? []
  for (const c of conns) {
    console.log(`  [${c.id}] status=${c.status} authConfig=${c.authConfig?.id}`)
  }

  // 3. Delete every Gmail connection (so we can re-OAuth)
  for (const c of conns) {
    try {
      await asAny(client.connectedAccounts).delete(c.id)
      console.log(`  deleted ${c.id}`)
    } catch (err) {
      console.log(`  delete ${c.id} failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // 4. Create a new auth config with explicit readonly scope
  console.log("\n== creating new auth config with gmail.readonly ==")
  const created: any = await asAny(client.authConfigs).create("gmail", {
    type: AuthConfigTypes.COMPOSIO_MANAGED,
    scopes: REQUIRED_SCOPES,
  })
  console.log(`  created auth config: ${created.id}`)

  // 5. Generate a fresh OAuth link
  console.log("\n== generating connect link ==")
  const link: any = await asAny(client.connectedAccounts).link(userId, created.id, {
    callbackUrl: CB_DEFAULT,
  })
  console.log(`  redirectUrl: ${link.redirectUrl}`)
  console.log("\nOpen the redirectUrl in a browser, complete OAuth (grant ALL scopes including 'Read your email'),")
  console.log("then re-run: bun scripts/ingest.ts gmail_msgs")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
