# persona

A digital-persona MCP server. Ask any question — `ask_persona` answers as the
persona owner would, grounded in their real digital memories (Gmail, Calendar,
Notion, GitHub, Maps, Drive). Built for the MongoDB Atlas hackathon.

Two surfaces:

- **MCP server** (`bin/mcp-persona.ts`) — exposes one tool, `ask_persona`, over
  stdio. Drop into Claude Desktop, Cursor, or any MCP client.
- **Next.js demo app** (`app/`) — a 20-question scoreboard showing the agent
  loop reasoning live. The hackathon judge surface.

Under the hood: an agent loop (Claude tool-use) over MongoDB Atlas Vector
Search, with optional voicing through Gemini or a Together AI LoRA adapter so
the answer comes back in the persona's actual voice.

## Requirements

- [Bun](https://bun.sh) (the MCP and scripts run under `bun`, not Node)
- A MongoDB Atlas cluster with Vector Search enabled (free tier works)
- An Anthropic API key
- A Gemini API key (used for embeddings; optional voicer)
- A [Composio](https://composio.dev) account, only if you want to ingest your
  own data from Gmail / Calendar / Notion / GitHub / Maps / Drive

## Quick start (against fake data)

This path skips Composio entirely — fastest way to see the MCP work.

```bash
bun install
cp .env.example .env
# fill in MONGODB_URI, ANTHROPIC_API_KEY, GEMINI_API_KEY at minimum

bun run ensure-indexes   # creates Atlas Vector Search indexes
bun run seed             # loads data/questions.fake.json into Mongo
bun run mcp              # starts the MCP server on stdio
```

To run the demo UI instead:

```bash
bun run dev              # http://localhost:3000
```

## Wiring into Claude Desktop

Copy `claude_desktop_config.example.json` into
`~/Library/Application Support/Claude/claude_desktop_config.json` (merge with
existing entries if present), fill in **absolute** paths for both `bun` and
`bin/mcp-persona.ts`, set the env vars, and restart Claude Desktop.

Both paths must be absolute — Claude Desktop spawns the MCP with a sandboxed
environment, no shell, no `.env` autoload, no inherited `PATH`.

## Ingesting your own data

If you want a persona of yourself (rather than the fake demo data), set the
Composio vars in `.env`:

```bash
COMPOSIO_API_KEY=...
COMPOSIO_USER_ID=...
PERSONA_USER_NAME=Jane
PERSONA_USER_EMAIL=jane@example.com
PERSONA_USER_EMAILS=jane@example.com,jane+work@example.com
PERSONA_NOTION_USER_ID=...
PERSONA_GITHUB_LOGIN=...
```

Connect each integration once (`/connect` in the demo UI handles the OAuth
dance), then:

```bash
bun run ingest
```

The ingest pipeline pulls items from each connected source, sanitizes them,
embeds them with Gemini, and writes them into Mongo with provenance.

## Optional: voice layer

By default, `summarize_for_answer` returns Claude's draft as the final answer.
Set `PERSONA_VOICER` to route the draft through a separate model that rewrites
it with retrieved voice exemplars:

- `PERSONA_VOICER=gemini` — in-context voicing via Gemini (cheap)
- `PERSONA_VOICER=together` — learned-weights voicing via a fine-tuned LoRA on
  Together AI. Train one with `bun run train-lora` after ingesting your own
  data.

The MCP eager-validates the configured voicer at startup and fails loudly if
it can't reach the model — better than a silent fallback at demo time.

## Layout

```
app/                Next.js demo app (scoreboard + reasoning theater)
bin/mcp-persona.ts  MCP entry point (stdio)
lib/agent/          agent loop, tools, prompts
lib/voice/          voicer clients (Gemini, Together) + answer formatter
lib/db.ts           Mongo client + collection helpers
scripts/ingest.ts   Composio → embed → Mongo ingestion
scripts/seed-fake.ts seeds data/questions.fake.json data into Mongo
scripts/train-lora.ts builds a voice-corpus JSONL and uploads to Together
data/               example + fake question banks for the demo
```

## License

MIT — see `LICENSE`.
