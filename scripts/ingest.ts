import { Composio } from "@composio/core"
import { memoriesOf, closeDb, type SourceName } from "../lib/db"
import { embed } from "../lib/embeddings"
import type { Memory } from "../lib/schemas"
import { sanitizeText } from "../lib/util/sanitize"

// ---------------------------------------------------------------------------
// Composio client (lazy singleton)
// ---------------------------------------------------------------------------

let _composio: Composio | null = null

function getComposio(): { client: Composio; userId: string } {
  const apiKey = process.env.COMPOSIO_API_KEY
  const userId = process.env.COMPOSIO_USER_ID
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in .env")
  if (!userId) throw new Error("COMPOSIO_USER_ID is not set in .env")
  if (!_composio) _composio = new Composio({ apiKey })
  return { client: _composio, userId }
}

export interface RawItem {
  external_id: string
  ts: Date
  text: string
  metadata: Record<string, unknown>
}

export async function ingest(source: SourceName, items: RawItem[]): Promise<{ inserted: number; updated: number }> {
  if (items.length === 0) return { inserted: 0, updated: 0 }
  const col = await memoriesOf(source)

  const ops = []
  for (const item of items) {
    const cleanText = sanitizeText(item.text)
    const embedding = await embed(cleanText)
    const doc: Memory = {
      source,
      external_id: item.external_id,
      ts: item.ts,
      text: cleanText,
      embedding,
      metadata: item.metadata,
      ingested_at: new Date(),
    }
    ops.push({
      updateOne: {
        filter: { external_id: item.external_id },
        update: { $set: doc },
        upsert: true,
      },
    })
  }

  const res = await col.bulkWrite(ops, { ordered: false })
  return {
    inserted: res.upsertedCount ?? 0,
    updated: res.modifiedCount ?? 0,
  }
}

export async function ingestGmailViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  const cutoffSec = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000)
  const PAGE_SIZE = 25
  const TARGET = 100
  const allMessages: any[] = []
  let pageToken: string | undefined = undefined

  while (allMessages.length < TARGET) {
    const args: Record<string, unknown> = {
      query: `after:${cutoffSec}`,
      max_results: PAGE_SIZE,
      include_spam_trash: false,
    }
    if (pageToken) args.page_token = pageToken

    const result: any = await client.tools.execute("GMAIL_FETCH_EMAILS", {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    })
    const batch: any[] = result?.data?.messages ?? result?.messages ?? []
    allMessages.push(...batch)
    pageToken = result?.data?.nextPageToken ?? result?.data?.next_page_token
    console.log(`  [gmail] fetched ${allMessages.length} (page+${batch.length}, nextToken=${pageToken ? "yes" : "no"})`)
    if (!pageToken || batch.length === 0) break
  }

  const messages: any[] = allMessages

  function header(msg: any, name: string): string | null {
    const headers = msg?.payload?.headers ?? []
    const h = headers.find((x: any) => String(x?.name).toLowerCase() === name.toLowerCase())
    return h?.value ?? null
  }

  return messages.map((msg: any) => {
    const id = msg.id ?? msg.messageId
    const tsRaw = msg.messageTimestamp ?? msg.internalDate ?? msg.date
    const ts = tsRaw
      ? typeof tsRaw === "number"
        ? new Date(tsRaw)
        : !isNaN(Number(tsRaw))
          ? new Date(Number(tsRaw))
          : new Date(tsRaw)
      : new Date()
    const subject = msg.subject ?? header(msg, "Subject") ?? ""
    const from = msg.from ?? header(msg, "From")
    const to = msg.to ?? header(msg, "To")
    const body = msg.messageText ?? msg.body ?? msg.snippet ?? ""
    const labels = msg.labelIds ?? msg.labels ?? []

    return {
      external_id: `gmail_${id}`,
      ts,
      text: [subject, body].filter(Boolean).join("\n\n").slice(0, 8000),
      metadata: {
        from,
        to,
        subject,
        labels,
        snippet: msg.snippet ?? null,
        thread_id: msg.threadId ?? null,
      },
    }
  })
}

export async function ingestCalendarViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  // Past 12 months + next 3 months
  const timeMin = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
  const timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()

  const result: any = await client.tools.execute("GOOGLECALENDAR_EVENTS_LIST", {
    userId,
    arguments: {
      calendar_id: "primary",
      time_min: timeMin,
      time_max: timeMax,
      max_results: 500,
      single_events: true,
      order_by: "startTime",
    },
    dangerouslySkipVersionCheck: true,
  })

  const events: any[] = result?.data?.items ?? result?.items ?? []

  return events.map((evt: any) => ({
    external_id: `gcal_${evt.id}`,
    ts: new Date(evt.start?.dateTime ?? evt.start?.date ?? Date.now()),
    text: [evt.summary, evt.description].filter(Boolean).join("\n\n"),
    metadata: {
      summary: evt.summary ?? null,
      location: evt.location ?? null,
      attendees: (evt.attendees ?? []).map((a: any) => a.email),
      organizer: evt.organizer?.email ?? null,
      end: evt.end?.dateTime ?? evt.end?.date ?? null,
      status: evt.status ?? null,
      html_link: evt.htmlLink ?? null,
    },
  }))
}

export async function ingestSlackViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  // Step 1: list all joined channels
  const channelRes: any = await client.tools.execute("SLACK_LIST_CONVERSATIONS", {
    userId,
    arguments: {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    },
    dangerouslySkipVersionCheck: true,
  })

  const channels: any[] = channelRes?.data?.channels ?? channelRes?.channels ?? []

  // Step 2: fetch recent message history per channel (last 90 days)
  const oldestSec = String((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000)
  const items: RawItem[] = []

  for (const channel of channels) {
    try {
      const histRes: any = await client.tools.execute("SLACK_FETCH_CONVERSATION_HISTORY", {
        userId,
        arguments: {
          channel: channel.id,
          oldest: oldestSec,
          limit: 200,
        },
        dangerouslySkipVersionCheck: true,
      })

      const messages: any[] = histRes?.data?.messages ?? histRes?.messages ?? []

      for (const msg of messages) {
        if (!msg.text) continue
        items.push({
          external_id: `slack_${channel.id}_${msg.ts}`,
          ts: new Date(Number(msg.ts) * 1000),
          text: msg.text,
          metadata: {
            channel_id: channel.id,
            channel_name: channel.name ?? null,
            user: msg.user ?? null,
            thread_ts: msg.thread_ts ?? null,
          },
        })
      }
    } catch (err) {
      // A channel may be inaccessible (e.g., archived mid-run, missing scopes)
      console.warn(`[slack] skipped channel ${channel.name ?? channel.id}: ${err}`)
    }
  }

  return items
}

export async function ingestNotionViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  // Step 1: enumerate all accessible pages with pagination.
  const allResults: any[] = []
  let startCursor: string | undefined
  for (let page = 0; page < 5 && allResults.length < 200; page++) {
    const args: Record<string, unknown> = { query: "", page_size: 100 }
    if (startCursor) args.start_cursor = startCursor
    const searchRes: any = await client.tools.execute("NOTION_SEARCH_NOTION_PAGE", {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    })
    const data = searchRes?.data ?? searchRes
    const batch: any[] = data?.results ?? []
    allResults.push(...batch)
    if (!data?.has_more || !data?.next_cursor) break
    startCursor = data.next_cursor
  }
  const results = allResults

  console.log(`  [notion] found ${results.length} pages`)
  const items: RawItem[] = []

  for (const page of results) {
    if (page.object !== "page") continue
    const pageId = page.id
    if (!pageId) continue

    let body = ""
    try {
      const md: any = await client.tools.execute("NOTION_GET_PAGE_MARKDOWN", {
        userId,
        arguments: { page_id: pageId },
        dangerouslySkipVersionCheck: true,
      })
      body = md?.data?.markdown ?? md?.data?.content ?? md?.markdown ?? ""
    } catch (err) {
      console.warn(`  [notion] couldn't fetch markdown for ${pageId}: ${err}`)
    }

    const titleProp = page.properties
      ? Object.values(page.properties).find((p: any) => p?.type === "title")
      : null
    const titleText: string =
      ((titleProp as any)?.title ?? [])
        .map((t: any) => t?.plain_text ?? "")
        .join("") || "(untitled)"

    const ts = new Date(page.last_edited_time ?? page.created_time ?? Date.now())

    items.push({
      external_id: `notion_${pageId}`,
      ts,
      text: [titleText, body].filter(Boolean).join("\n\n").slice(0, 8000),
      metadata: {
        title: titleText,
        url: page.url ?? null,
        created_time: page.created_time ?? null,
        last_edited_time: page.last_edited_time ?? null,
        archived: page.archived ?? false,
        parent: page.parent ?? null,
      },
    })
  }

  return items
}

export async function ingestGithubViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()
  const items: RawItem[] = []

  // 1. Profile
  try {
    const meRes: any = await client.tools.execute("GITHUB_GET_THE_AUTHENTICATED_USER", {
      userId,
      arguments: {},
      dangerouslySkipVersionCheck: true,
    })
    const u = meRes?.data ?? {}
    if (u?.login) {
      items.push({
        external_id: `gh_profile_${u.login}`,
        ts: new Date(u.updated_at ?? Date.now()),
        text: [
          `GitHub profile: ${u.login}`,
          u.name ?? "",
          u.bio ?? "",
          u.company ? `at ${u.company}` : "",
          u.location ? `in ${u.location}` : "",
          u.blog ? `blog: ${u.blog}` : "",
          `${u.public_repos ?? 0} public repos · ${u.followers ?? 0} followers · ${u.following ?? 0} following`,
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: {
          kind: "profile",
          login: u.login,
          name: u.name ?? null,
          bio: u.bio ?? null,
          company: u.company ?? null,
          location: u.location ?? null,
          html_url: u.html_url ?? null,
          public_repos: u.public_repos ?? null,
          followers: u.followers ?? null,
        },
      })
    }
  } catch (err) {
    console.warn(`  [github] profile failed: ${err}`)
  }

  // 2. Owned repos
  try {
    const reposRes: any = await client.tools.execute("GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", {
      userId,
      arguments: { per_page: 100 },
      dangerouslySkipVersionCheck: true,
    })
    const repos: any[] = reposRes?.data?.repositories ?? reposRes?.data?.items ?? []
    console.log(`  [github] ${repos.length} owned repos`)
    for (const r of repos) {
      items.push({
        external_id: `gh_repo_${r.id}`,
        ts: new Date(r.pushed_at ?? r.updated_at ?? r.created_at ?? Date.now()),
        text: [
          `GitHub repo (owned/contrib): ${r.full_name}`,
          r.description ?? "",
          r.language ? `Language: ${r.language}` : "",
          `Stars: ${r.stargazers_count ?? 0} · Forks: ${r.forks_count ?? 0}`,
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: {
          kind: "owned_repo",
          full_name: r.full_name,
          name: r.name,
          description: r.description ?? null,
          language: r.language ?? null,
          html_url: r.html_url ?? null,
          private: r.private ?? null,
          fork: r.fork ?? null,
          stargazers_count: r.stargazers_count ?? null,
          pushed_at: r.pushed_at ?? null,
        },
      })
    }
  } catch (err) {
    console.warn(`  [github] owned repos failed: ${err}`)
  }

  // 3. Starred repos
  try {
    const starredRes: any = await client.tools.execute(
      "GITHUB_LIST_REPOSITORIES_STARRED_BY_THE_AUTHENTICATED_USER",
      {
        userId,
        arguments: { per_page: 100 },
        dangerouslySkipVersionCheck: true,
      },
    )
    const starred: any[] = starredRes?.data?.repositories ?? starredRes?.data?.items ?? []
    console.log(`  [github] ${starred.length} starred repos`)
    for (const r of starred) {
      items.push({
        external_id: `gh_star_${r.id}`,
        ts: new Date(r.pushed_at ?? r.updated_at ?? r.created_at ?? Date.now()),
        text: [
          `GitHub repo (starred): ${r.full_name}`,
          r.description ?? "",
          r.language ? `Language: ${r.language}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: {
          kind: "starred_repo",
          full_name: r.full_name,
          description: r.description ?? null,
          language: r.language ?? null,
          html_url: r.html_url ?? null,
          stargazers_count: r.stargazers_count ?? null,
        },
      })
    }
  } catch (err) {
    console.warn(`  [github] starred failed: ${err}`)
  }

  return items
}

export async function ingestGoogleDriveViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  const allFiles: any[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 5 && allFiles.length < 500; page++) {
    const args: Record<string, unknown> = { page_size: 100 }
    if (pageToken) args.page_token = pageToken
    const res: any = await client.tools.execute("GOOGLEDRIVE_LIST_FILES", {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    })
    const data = res?.data ?? res
    const batch: any[] = data?.files ?? data?.items ?? []
    allFiles.push(...batch)
    pageToken = data?.nextPageToken ?? data?.next_page_token
    console.log(`  [gdrive] +${batch.length} (total ${allFiles.length})`)
    if (!pageToken || batch.length === 0) break
  }

  return allFiles.map((f: any) => ({
    external_id: `gdrive_${f.id}`,
    ts: new Date(f.modifiedTime ?? f.createdTime ?? Date.now()),
    text: [f.name, f.description, f.mimeType].filter(Boolean).join(" — ").slice(0, 4000),
    metadata: {
      name: f.name ?? null,
      mimeType: f.mimeType ?? null,
      webViewLink: f.webViewLink ?? null,
      owners: (f.owners ?? []).map((o: any) => o.emailAddress ?? o.displayName).filter(Boolean),
      parents: f.parents ?? [],
      modifiedTime: f.modifiedTime ?? null,
      createdTime: f.createdTime ?? null,
      shared: f.shared ?? null,
      starred: f.starred ?? null,
    },
  }))
}

export async function ingestGoogleDocsViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  const docs: any[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 5 && docs.length < 200; page++) {
    const args: Record<string, unknown> = { query: "", page_size: 100 }
    if (pageToken) args.page_token = pageToken
    const searchRes: any = await client.tools.execute("GOOGLEDOCS_SEARCH_DOCUMENTS", {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    })
    const data = searchRes?.data ?? searchRes
    const batch: any[] = data?.files ?? data?.documents ?? data?.results ?? []
    docs.push(...batch)
    pageToken = data?.nextPageToken ?? data?.next_page_token
    if (!pageToken || batch.length === 0) break
  }
  console.log(`  [gdocs] found ${docs.length} docs`)

  const items: RawItem[] = []
  for (const doc of docs) {
    const id = doc.id ?? doc.documentId ?? doc.fileId
    if (!id) continue
    let body = ""
    try {
      const txt: any = await client.tools.execute("GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", {
        userId,
        arguments: { document_id: id },
        dangerouslySkipVersionCheck: true,
      })
      body = txt?.data?.plaintext ?? txt?.data?.text ?? txt?.plaintext ?? ""
    } catch (err) {
      console.warn(`  [gdocs] couldn't fetch plaintext for ${id}: ${err}`)
    }

    const title = doc.name ?? doc.title ?? "(untitled)"
    const ts = new Date(doc.modifiedTime ?? doc.createdTime ?? Date.now())

    items.push({
      external_id: `gdocs_${id}`,
      ts,
      text: [title, body].filter(Boolean).join("\n\n").slice(0, 8000),
      metadata: {
        title,
        webViewLink: doc.webViewLink ?? null,
        modifiedTime: doc.modifiedTime ?? null,
        createdTime: doc.createdTime ?? null,
      },
    })
  }
  return items
}

export async function ingestGoogleSheetsViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  const sheets: any[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 5 && sheets.length < 200; page++) {
    const args: Record<string, unknown> = { query: "", page_size: 100 }
    if (pageToken) args.page_token = pageToken
    const res: any = await client.tools.execute("GOOGLESHEETS_SEARCH_SPREADSHEETS", {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    })
    const data = res?.data ?? res
    const batch: any[] = data?.files ?? data?.spreadsheets ?? data?.results ?? []
    sheets.push(...batch)
    pageToken = data?.nextPageToken ?? data?.next_page_token
    if (!pageToken || batch.length === 0) break
  }
  console.log(`  [gsheets] ${sheets.length} sheets`)

  return sheets.map((s: any) => ({
    external_id: `gsheets_${s.id ?? s.spreadsheetId}`,
    ts: new Date(s.modifiedTime ?? s.createdTime ?? Date.now()),
    text: [s.name ?? s.title, s.description].filter(Boolean).join(" — ").slice(0, 4000),
    metadata: {
      name: s.name ?? s.title ?? null,
      webViewLink: s.webViewLink ?? null,
      modifiedTime: s.modifiedTime ?? null,
      createdTime: s.createdTime ?? null,
      owners: (s.owners ?? []).map((o: any) => o.emailAddress ?? o.displayName).filter(Boolean),
    },
  }))
}

export async function ingestLinkedinViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  const me: any = await client.tools.execute("LINKEDIN_GET_MY_INFO", {
    userId,
    arguments: {},
    dangerouslySkipVersionCheck: true,
  })
  const data = me?.data ?? me
  const profile = data?.profile ?? data?.response_data ?? data ?? {}
  const id = profile.sub ?? profile.id ?? profile.email ?? "self"
  console.log(`  [linkedin] profile id=${id}`)

  const fields = [
    profile.name,
    profile.given_name,
    profile.family_name,
    profile.email,
    profile.locale?.country,
    profile.headline,
    profile.summary,
  ]
    .filter(Boolean)
    .join(" · ")

  return [
    {
      external_id: `linkedin_profile_${id}`,
      ts: new Date(),
      text: `LinkedIn profile: ${fields}`.slice(0, 4000),
      metadata: {
        name: profile.name ?? null,
        email: profile.email ?? null,
        locale: profile.locale ?? null,
        picture: profile.picture ?? null,
        headline: profile.headline ?? null,
        sub: profile.sub ?? null,
      },
    },
  ]
}

export async function ingestYoutubeViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  const items: RawItem[] = []

  try {
    const subs: any = await client.tools.execute("YOUTUBE_LIST_USER_SUBSCRIPTIONS", {
      userId,
      arguments: { mine: true, max_results: 50 },
      dangerouslySkipVersionCheck: true,
    })
    const subItems: any[] = subs?.data?.items ?? subs?.items ?? []
    console.log(`  [youtube] ${subItems.length} subscriptions`)
    for (const s of subItems) {
      const sid = s.id?.channelId ?? s.id ?? s.snippet?.resourceId?.channelId
      const channelTitle = s.snippet?.title ?? "(unknown channel)"
      const description = s.snippet?.description ?? ""
      const ts = new Date(s.snippet?.publishedAt ?? Date.now())
      items.push({
        external_id: `yt_sub_${sid}`,
        ts,
        text: `Subscribed to YouTube channel: ${channelTitle}\n\n${description}`.slice(0, 4000),
        metadata: {
          kind: "subscription",
          channelId: s.snippet?.resourceId?.channelId ?? null,
          channelTitle,
          publishedAt: s.snippet?.publishedAt ?? null,
        },
      })
    }
  } catch (err) {
    console.warn(`  [youtube] subscriptions failed: ${err}`)
  }

  try {
    const playlists: any = await client.tools.execute("YOUTUBE_LIST_USER_PLAYLISTS", {
      userId,
      arguments: { mine: true, max_results: 50 },
      dangerouslySkipVersionCheck: true,
    })
    const plItems: any[] = playlists?.data?.items ?? playlists?.items ?? []
    console.log(`  [youtube] ${plItems.length} playlists`)
    for (const p of plItems) {
      const pid = p.id ?? p.snippet?.id
      const title = p.snippet?.title ?? "(unnamed playlist)"
      const description = p.snippet?.description ?? ""
      const ts = new Date(p.snippet?.publishedAt ?? Date.now())
      items.push({
        external_id: `yt_pl_${pid}`,
        ts,
        text: `YouTube playlist: ${title}\n\n${description}`.slice(0, 4000),
        metadata: {
          kind: "playlist",
          playlistId: pid,
          title,
          itemCount: p.contentDetails?.itemCount ?? null,
          publishedAt: p.snippet?.publishedAt ?? null,
        },
      })
    }
  } catch (err) {
    console.warn(`  [youtube] playlists failed: ${err}`)
  }

  return items
}

export async function ingestDiscordViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()

  const items: RawItem[] = []

  try {
    const guilds: any = await client.tools.execute("DISCORD_LIST_MY_GUILDS", {
      userId,
      arguments: {},
      dangerouslySkipVersionCheck: true,
    })
    const data = guilds?.data ?? guilds
    const list: any[] = Array.isArray(data) ? data : data?.guilds ?? data?.items ?? []
    console.log(`  [discord] ${list.length} guilds`)
    for (const g of list) {
      const id = g.id
      if (!id) continue
      items.push({
        external_id: `discord_guild_${id}`,
        ts: new Date(),
        text: `Discord server: ${g.name ?? "(unnamed)"}${g.description ? `\n\n${g.description}` : ""}`.slice(
          0,
          4000,
        ),
        metadata: {
          kind: "guild",
          id,
          name: g.name ?? null,
          owner: g.owner ?? null,
          permissions: g.permissions ?? null,
          features: g.features ?? [],
        },
      })
    }
  } catch (err) {
    console.warn(`  [discord] guilds failed: ${err}`)
  }

  try {
    const me: any = await client.tools.execute("DISCORD_GET_MY_USER", {
      userId,
      arguments: {},
      dangerouslySkipVersionCheck: true,
    })
    const u = me?.data ?? me
    if (u?.id) {
      items.push({
        external_id: `discord_self_${u.id}`,
        ts: new Date(),
        text: `Discord identity: ${u.username ?? u.global_name ?? ""} (${u.id})`,
        metadata: {
          kind: "self",
          id: u.id,
          username: u.username ?? null,
          global_name: u.global_name ?? null,
          locale: u.locale ?? null,
          email: u.email ?? null,
        },
      })
    }
  } catch (err) {
    console.warn(`  [discord] self failed: ${err}`)
  }

  return items
}

export async function ingestInstagramViaComposio(): Promise<RawItem[]> {
  const { client, userId } = getComposio()
  const items: RawItem[] = []

  let username: string | null = null
  try {
    const info: any = await client.tools.execute("INSTAGRAM_GET_USER_INFO", {
      userId,
      arguments: {},
      dangerouslySkipVersionCheck: true,
    })
    const p = info?.data ?? {}
    if (p?.id) {
      username = p.username ?? null
      items.push({
        external_id: `ig_profile_${p.id}`,
        ts: new Date(),
        text: [
          `Instagram profile: @${p.username ?? "?"}`,
          p.biography ?? "",
          `${p.media_count ?? 0} posts · ${p.followers_count ?? 0} followers · ${p.follows_count ?? 0} following`,
          p.account_type ? `account_type: ${p.account_type}` : "",
          p.website ? `website: ${p.website}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: {
          kind: "profile",
          id: p.id,
          username: p.username ?? null,
          biography: p.biography ?? null,
          account_type: p.account_type ?? null,
          followers_count: p.followers_count ?? null,
          follows_count: p.follows_count ?? null,
          media_count: p.media_count ?? null,
          profile_picture_url: p.profile_picture_url ?? null,
          website: p.website ?? null,
        },
      })
    }
  } catch (err) {
    console.warn(`  [instagram] profile failed: ${err}`)
  }

  let after: string | undefined
  for (let page = 0; page < 5; page++) {
    try {
      const args: Record<string, unknown> = { limit: 50 }
      if (after) args.after = after
      const res: any = await client.tools.execute("INSTAGRAM_GET_USER_MEDIA", {
        userId,
        arguments: args,
        dangerouslySkipVersionCheck: true,
      })
      const data = res?.data ?? {}
      const batch: any[] = data?.data ?? []
      console.log(`  [instagram] page+${batch.length} (total ${items.length - 1 + batch.length})`)
      for (const m of batch) {
        const id = m.id
        if (!id) continue
        const ts = m.timestamp ? new Date(m.timestamp) : new Date()
        const caption = m.caption ?? ""
        items.push({
          external_id: `ig_media_${id}`,
          ts,
          text: [
            `Instagram ${m.media_type ?? "post"}${m.media_product_type ? ` (${m.media_product_type})` : ""}${username ? ` by @${username}` : ""}`,
            caption,
            `${m.like_count ?? 0} likes · ${m.comments_count ?? 0} comments`,
          ]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 8000),
          metadata: {
            kind: "media",
            id,
            shortcode: m.shortcode ?? null,
            permalink: m.permalink ?? null,
            media_type: m.media_type ?? null,
            media_product_type: m.media_product_type ?? null,
            like_count: m.like_count ?? null,
            comments_count: m.comments_count ?? null,
            timestamp: m.timestamp ?? null,
            owner_id: m.owner?.id ?? null,
            username: m.username ?? username,
          },
        })
      }
      after = data?.paging?.cursors?.after
      if (!after || batch.length === 0) break
    } catch (err) {
      console.warn(`  [instagram] media page failed: ${err}`)
      break
    }
  }

  return items
}

const FETCHERS: Record<SourceName, () => Promise<RawItem[]>> = {
  gmail_msgs: ingestGmailViaComposio,
  calendar_events: ingestCalendarViaComposio,
  slack_msgs: ingestSlackViaComposio,
  notion_docs: ingestNotionViaComposio,
  github_activity: ingestGithubViaComposio,
  gdrive_files: ingestGoogleDriveViaComposio,
  gdocs_pages: ingestGoogleDocsViaComposio,
  gsheets_sheets: ingestGoogleSheetsViaComposio,
  linkedin_profile: ingestLinkedinViaComposio,
  youtube_activity: ingestYoutubeViaComposio,
  discord_servers: ingestDiscordViaComposio,
  instagram_posts: ingestInstagramViaComposio,
  maps_history: async () => [],
  photos_meta: async () => [],
}

export function getFetcher(source: SourceName): () => Promise<RawItem[]> {
  return FETCHERS[source]
}

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error("Usage: bun scripts/ingest.ts <source|all>")
    console.error(`Sources: ${Object.keys(FETCHERS).join(", ")}`)
    process.exit(1)
  }

  const wired = (Object.keys(FETCHERS) as SourceName[]).filter(
    (s) => s !== "maps_history" && s !== "photos_meta",
  )

  const sources: SourceName[] =
    arg === "all"
      ? wired
      : Object.keys(FETCHERS).includes(arg)
        ? [arg as SourceName]
        : []

  if (sources.length === 0) {
    console.error(`Source ${arg} not yet wired.`)
    process.exit(1)
  }

  for (const source of sources) {
    console.log(`\n[${source}] fetching…`)
    try {
      const items = await FETCHERS[source]()
      const res = await ingest(source, items)
      console.log(`[${source}] ingested: ${res.inserted} new, ${res.updated} updated (from ${items.length} items)`)
    } catch (err) {
      console.error(`[${source}] failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  await closeDb()
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
