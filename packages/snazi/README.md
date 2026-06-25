# snazi — iMessage wrapper CLI

> "No messages for you."

The **local gate**. An on-demand CLI that wraps the Mac Messages database so an
AI agent can be told *who* messaged without being able to read *what* they said —
unless the sender is on the server's approved list.

This is **not a daemon**. There is no launchd job, no background process. The
agent runs it on demand. It stores nothing locally and the server stores no
message content. Message text is read live from `~/Library/Messages/chat.db`
and printed only when the gate opens.

## How the gate works

```
agent wants to know what's new
        │
        ▼
  snazi list-new            ──►  reveals WHO + status (approved/denied/unknown)
        │                         (never the message text)
        │  unknown sender? agent asks Chip: "approve +1555…?"
        │  Chip approves: snazi approve +1555… --channel imessage
        ▼
  snazi read <sender>       ──►  CLI asks server: is this sender approved?
                                   ├─ approved → prints message text
                                   └─ otherwise → "No messages for you."
```

The approval decision lives entirely on the server (Supabase-backed list). The
CLI only *checks* it. It cannot reveal content for a non-approved sender.

## Install

```bash
./install.sh
```

This runs `npm install && npm run build`, creates `~/.snazi/config.json`
(template), and prints next steps. Then:

1. Edit `~/.snazi/config.json`:
   ```json
   {
     "apiUrl": "https://soup-nazi-agent.vercel.app",
     "apiKey": "<SOUP_NAZI_API_KEY>",
     "adminKey": "<SOUP_NAZI_ADMIN_KEY>",
     "channels": ["imessage"]
   }
   ```
2. Grant **Full Disk Access** to your terminal (System Settings → Privacy &
   Security → Full Disk Access) so it can read `chat.db`.
3. Optional: `npm link` to put `snazi` on your PATH.

## Commands

| Command | What it does |
| --- | --- |
| `snazi list-new [--channel <id>] [--since <min>]` | Distinct inbound senders, message counts, latest timestamp, and approval status. **No text.** Default window 60 min. |
| `snazi read <sender> [--channel <id>] [--since <min>]` | Message text for one sender — **only if approved**. Otherwise errors with `No messages for you.` |
| `snazi check <sender> --channel <id>` | Print one sender's approval status (`approved`/`denied`/`unknown`). |
| `snazi approve <sender> --channel <id> [--label <name>]` | Approve a sender. Requires the admin key. |
| `snazi deny <sender> --channel <id>` | Deny a sender. Requires the admin key. |
| `snazi channels list` | List configured channels from `~/.snazi/config.json`. |
| `snazi channels add <channel>` | Add a channel (e.g. `snazi channels add imessage`). |
| `snazi status` | Config path, apiUrl, masked keys, channels, server reachability. |
| `snazi serve [--bind <ip>] [--port <n>]` | Start the read-only HTTP gate (see **Serve mode** below). |
| `snazi serve --install-daemon [--bind <ip>] [--port <n>]` | Install the launchd LaunchAgent for serve mode. |
| `snazi remote-status` | Probe a remote serve's `/health` (`remoteUrl`). |
| `snazi remote-list-new [--channel <id>] [--since <min>]` | WHO messaged on the remote host + status. |
| `snazi remote-check <sender> --channel <id>` | One sender's status, via remote serve. |
| `snazi remote-read <sender> [--channel <id>] [--since <min>]` | Message text via remote serve — only if approved. |

All output is JSON.

### Examples

```bash
snazi list-new --since 180
# [
#   { "sender": "+15551234567", "message_count": 3,
#     "latest_at": "2026-06-23T22:10:04.000Z", "status": "unknown" }
# ]

snazi read "+15551234567"
# { "error": "Sender not approved. No messages for you.", "status": "unknown" }

snazi approve "+15551234567" --channel imessage --label "Mom"
# { "ok": true, "channel": "imessage", "sender": "+15551234567", "status": "approved", "label": "Mom" }

snazi read "+15551234567"
# { "sender": "+15551234567", "status": "approved", "since_minutes": 60,
#   "messages": [ { "date": "...", "text": "hey are we still on for lunch?" } ] }
```

## Serve mode — least-privilege HTTP gate over a tailnet

Sometimes the agent that wants to triage messages runs on a *different* Mac than
the one signed into iMessage. SSH would work, but SSH grants a **full shell** —
far more than "let me read approved messages." `snazi serve` exposes **only** the
gated, read-only operations over HTTP so a remote trusted agent gets least
privilege.

```
  Remote agent (Mac B)                         iMessage Mac (Mac A)
  ┌────────────────────┐   Tailscale tailnet   ┌──────────────────────┐
  │ snazi remote-read   │ ───── HTTP ─────────► │ snazi serve           │
  │   (bearer token)    │   100.x:8787          │  /health  (no auth)   │
  └────────────────────┘                       │  /list-new  (bearer)  │
                                                │  /check     (bearer)  │
                                                │  /read      (bearer)  │
                                                │     │                 │
                                                │     ▼ same gate (api)  │
                                                │  approved? → text      │
                                                │  else     → "No        │
                                                │             messages   │
                                                │             for you."  │
                                                └──────────────────────┘
```

### Endpoints (all JSON, read-only)

| Method + path | Auth | Returns |
| --- | --- | --- |
| `GET /health` | none | `{ ok: true, version }` — connectivity probe only, no data. |
| `GET /list-new?channel=imessage&since=<min>` | bearer | `{ channel, since_minutes, senders: [{ sender, message_count, latest_at, status }] }`. **Never message text.** |
| `GET /check?sender=<addr>&channel=imessage` | bearer | `{ channel, sender, status }`. |
| `GET /read?sender=<addr>&channel=imessage&since=<min>` | bearer | `{ sender, channel, status, since_minutes, messages }` **only if approved**; otherwise `403 { error: "Sender not approved. No messages for you.", status }`. |

There is **no `approve`/`deny` over HTTP**. Mutations stay CLI/dashboard-only.
Non-`GET` → `405`. Unknown path → `404`. Bad params → `400`.

### Security model

- **Tailnet-only.** Default bind is this host's Tailscale IP (`100.64.0.0/10`) if
  present, else `127.0.0.1`. It **never** binds `0.0.0.0` — `--bind 0.0.0.0` is
  refused. For loopback bind, front it with `tailscale serve` to reach it on the
  tailnet over HTTPS.
- **Bearer token required** on every endpoint except `/health`. The token is
  `serveToken` in config; comparison is constant-time (SHA-256 + `timingSafeEqual`)
  and the token is never logged.
- **Read-only surface.** No shell, no arbitrary file reads, no path traversal —
  only the same `chatdb.ts` queries the CLI uses. Params are validated
  (`channel`/`sender` charset-checked, `since` clamped to ≤ 7 days).
- **Same gate.** `/read` calls the server list API (`api.ts`) *before* touching
  any text — identical to `snazi read`. The gate is the product; it is not
  bypassed.
- **No storage.** Content is read live from `chat.db` and returned in the
  response only. Nothing is persisted on either side.

### Config keys

Add to `~/.snazi/config.json` on the **serve** host:

```json
{
  "serveToken": "<openssl rand -hex 32>",
  "serveBind": "100.84.4.92",   // optional; default = tailnet IP else 127.0.0.1
  "servePort": 8787              // optional; default 8787
}
```

And on the **remote client** host (Mac B):

```json
{
  "remoteUrl": "http://100.84.4.92:8787",
  "remoteToken": "<same value as serveToken on Mac A>"
}
```

### Run it

```bash
# Foreground (binds tailnet 100.x if present, else 127.0.0.1):
snazi serve

# Explicit bind/port:
snazi serve --bind 100.84.4.92 --port 8787
```

### Run as a launchd service

```bash
snazi serve --install-daemon            # writes ~/Library/LaunchAgents/com.soup-nazi.snazi-serve.plist
launchctl load -w ~/Library/LaunchAgents/com.soup-nazi.snazi-serve.plist   # start (RunAtLoad + KeepAlive)
launchctl unload -w ~/Library/LaunchAgents/com.soup-nazi.snazi-serve.plist # stop
```

**Full Disk Access (required).** A launchd LaunchAgent runs in a context that
cannot read `~/Library/Messages/chat.db` unless the **node binary** has Full
Disk Access. `--install-daemon` prints the exact node path; add **that binary**
(not just Terminal) in **System Settings → Privacy & Security → Full Disk
Access**, then reload the agent. Without FDA, `/list-new` and `/read` return an
FDA error — the gate still holds; you just get no data.

### Calling it

From the remote agent, either use the thin client subcommands:

```bash
snazi remote-status
snazi remote-list-new --since 120
snazi remote-check "+15551234567" --channel imessage
snazi remote-read  "+15551234567"
```

…or plain `curl` (bearer token in the header, never logged server-side):

```bash
TOKEN=...   # the serveToken
BASE=http://100.84.4.92:8787

curl -s "$BASE/health"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/list-new?channel=imessage&since=120"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/check?sender=%2B15551234567&channel=imessage"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/read?sender=%2B15551234567&channel=imessage"
# Unknown/denied sender → 403 { "error": "Sender not approved. No messages for you.", ... }
```

## Why this design

- **No prompt-injection surface from strangers.** The agent never sees content
  from unknown senders, so a malicious text can't smuggle instructions to it.
- **No message storage anywhere.** Cheap and private. The server is a list, not
  an inbox.
- **Extensible.** The same server list API works for other channels (e.g.
  Gmail) — just add a channel and a new wrapper that calls `/api/senders/check`.
