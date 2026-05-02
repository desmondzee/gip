import { Composio, AuthConfigTypes } from "@composio/core"
import type { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Maps ingest source names to Composio toolkit slugs
const TOOLKIT_MAP: Record<string, string> = {
  gmail_msgs: "gmail",
  calendar_events: "googlecalendar",
  slack_msgs: "slack",
}

let _composio: Composio | null = null

function getComposio(): { client: Composio; userId: string } {
  const apiKey = process.env.COMPOSIO_API_KEY
  const userId = process.env.COMPOSIO_USER_ID
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in .env")
  if (!userId) throw new Error("COMPOSIO_USER_ID is not set in .env")
  if (!_composio) _composio = new Composio({ apiKey })
  return { client: _composio, userId }
}

/**
 * GET /api/connect?source=gmail_msgs
 *
 * Returns:
 *   { status: "connected", source, toolkit }
 *   { status: "not_connected", source, toolkit, redirectUrl }
 */
export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams.get("source")
  if (!source || !TOOLKIT_MAP[source]) {
    return Response.json({ error: `unknown source: ${source}` }, { status: 400 })
  }

  const toolkit = TOOLKIT_MAP[source]
  const { client, userId } = getComposio()
  const callbackUrl = req.nextUrl.origin

  try {
    // 1. Check for an active connection
    const connections = await client.connectedAccounts.list({
      userIds: [userId],
      toolkitSlugs: [toolkit],
      statuses: ["ACTIVE"],
    })

    if ((connections.items?.length ?? 0) > 0) {
      return Response.json({ status: "connected", source, toolkit })
    }

    // 2. Find an existing auth config for the toolkit (prefer Composio-managed)
    const authConfigsRes = await client.authConfigs.list({ toolkit })
    let authConfigId = authConfigsRes.items?.[0]?.id

    // 3. If none exists, create a Composio-managed one automatically
    if (!authConfigId) {
      const created = await client.authConfigs.create(toolkit, {
        type: AuthConfigTypes.COMPOSIO_MANAGED,
      })
      authConfigId = created.id
    }

    // 4. Generate an OAuth connect link for this user
    const connectionRequest = await client.connectedAccounts.link(userId, authConfigId, {
      callbackUrl,
    })

    return Response.json({
      status: "not_connected",
      source,
      toolkit,
      redirectUrl: connectionRequest.redirectUrl,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500 })
  }
}
