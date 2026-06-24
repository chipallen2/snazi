# soup-nazi-agent

> No messages for you.

A communication **gating layer** for AI agents. It prevents prompt injection
from strangers by controlling whether an agent can see message *content* —
based purely on an approved/denied list of senders.

The agent can always learn **who** sent a message. It can only read **what**
they said if the sender is approved.

## Two parts (and nothing else)

### Part A — Server (`packages/web`): the LIST manager
A Next.js 14 + Tailwind app on Vercel, backed by Supabase. It does exactly one
thing: manage an approve/deny list of senders per channel.

- **It stores no messages. There is no inbox table. No content ever touches the
  server.** This is the whole point.
- API:
  - `GET /api/senders/check?channel=imessage&address=<addr>` →
    `{ status: "approved" | "denied" | "unknown" }` (read key)
  - `GET /api/senders?channel=imessage` → full list (read key)
  - `POST /api/senders` → upsert sender to approved/denied (admin key)
  - `DELETE /api/senders` → remove sender (admin key)
- Dashboard: `/` (manage senders), `/channels` (read-only channel registry).
- Auth: `x-api-key` header. `SOUP_NAZI_API_KEY` (read/check),
  `SOUP_NAZI_ADMIN_KEY` (mutate). The dashboard mutates via the protected API
  routes using server actions — the admin key never reaches the browser.

### Part B — Mac wrapper CLI (`packages/snazi`): the LOCAL gate
A plain on-demand CLI (TypeScript → `dist/`). **Not a daemon. No launchd.** The
agent runs it on demand on Chip's Mac, where it reads
`~/Library/Messages/chat.db` (read-only).

- `snazi list-new` → reveals **who** messaged + approval status. Never text.
- `snazi read <sender>` → checks the server first; prints text **only if
  approved**, otherwise "No messages for you."
- `snazi check <sender> --channel <id>` → one sender's status.
- `snazi approve|deny <sender> --channel <id>` → update the list (admin key).
- `snazi channels list|add` → manage configured channels.
- `snazi status` → config + connectivity.

See [`packages/snazi/README.md`](packages/snazi/README.md).

## The approval flow

1. Agent: `snazi list-new` → sees `+1555… (unknown)`.
2. Agent asks Chip: "New messages from +1555…, approve?"
3. Chip approves in the dashboard (or via `snazi approve +1555… --channel imessage`).
4. Agent: `snazi read +1555…` → now the gate opens and text is returned.

Unknown/denied senders stay opaque. A malicious stranger can't inject content
into the agent because the agent never sees their words.

## Layout

```
packages/
  web/      Next.js list-manager (API + dashboard)  → Vercel
  snazi/    On-demand Mac wrapper CLI               → Chip's Mac
```

## Data model (Supabase, `sna_` prefixed)

- `sna_channels` — channel registry (`imessage` seeded; extensible to gmail…).
- `sna_senders` — the approve/deny list. `status` ∈ {`approved`,`denied`};
  absent = `unknown`. **No message tables exist.**

## Setup

- Server: see `.env.example`, deploy `packages/web` to Vercel with the four env
  vars set.
- CLI: run `packages/snazi/install.sh`, fill `~/.snazi/config.json`,
  grant Full Disk Access.

## Extending to other channels

Add a row to `sna_channels` and write a new wrapper that calls
`GET /api/senders/check` before revealing content. The server list API is
channel-agnostic.
