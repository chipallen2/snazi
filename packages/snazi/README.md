# snazi — message gate CLI (iMessage today)

> "No messages for you."

The **local gate**. An on-demand CLI that reads your messages through pluggable
**channel adapters** so an AI agent can be told *who* messaged without being able
to read *what* they said — unless the sender is on the server's approved list.
iMessage is the first channel; the architecture is built for more (Gmail,
Outlook, …). The CLI itself runs on macOS, Windows, and Linux (Node 18+); each
channel works wherever its adapter does (iMessage is macOS-only).

The base CLI runs **on demand** — no launchd job, no background process. The
agent invokes it when needed. It stores nothing locally and the server stores no
message content. Message text is read live from the channel's local store (for
iMessage, `~/Library/Messages/chat.db`) and printed only when the gate opens.

**Optional serve mode** (`snazi serve` or `snazi serve --install-daemon`) runs a
long-lived HTTP gate for remote agents over a private tailnet. See **Serve mode**
below.

## How the gate works

```
agent wants to know what's new
        │
        ▼
  snazi list-new            ──►  reveals WHO + status + label (approved/denied/unknown)
        │                         (never the message text)
        │  unknown sender? agent asks you: "approve +1555…?"
        │  you approve in the dashboard, or by tapping a /decide link
        ▼
  snazi read <sender>       ──►  CLI asks server: is this sender approved?
                                   ├─ approved → prints message text
                                   └─ otherwise → "No messages for you."
```

The approval decision lives entirely on the server (Supabase-backed,
per-account list). The CLI only *checks* it with a **read-only token** — it
cannot approve a sender or reveal content for a non-approved one.

## Install

macOS, Windows, or Linux (Node 18+):

```bash
npm install -g @chipallen2/snazi
snazi init          # writes ~/.snazi/config.json (deployment URL + READ token)
snazi doctor        # checks Node, config, connectivity, and channel access
```

> The npm package is **scoped** (`@chipallen2/snazi`) but the command you run is
> just `snazi`. (The bare name `snazi` was too close to an existing npm package
> to publish unscoped.)

`snazi init` asks for two things: your **deployment URL** (default
`https://snazi.dev`) and your **account READ token** (sign up at `/signup`, then
copy it from the `/account` page). There is **no admin key** — approvals happen
in the dashboard or via a signed `/decide` link. For agents/CI, skip the prompts:

```bash
snazi init --api-url https://snazi.dev --token <READ_TOKEN> --yes
```

**macOS only — Full Disk Access.** To read iMessage, grant Full Disk Access to
your terminal (or the `node` binary) in System Settings → Privacy & Security →
Full Disk Access. `snazi doctor` flags it if missing.

### From source (contributors)

```bash
git clone https://github.com/chipallen2/snazi.git
cd snazi/packages/snazi
./install.sh        # npm install + build, links `snazi` onto your PATH
                    # Windows (no bash): npm install && npm run build && npm link
snazi init && snazi doctor
```

## Commands

| Command | What it does |
| --- | --- |
| `snazi init [--api-url <url>] [--token <tok>] [--channel <id>]` | Create or update `~/.snazi/config.json`. |
| `snazi doctor` | Diagnose Node, config, connectivity, and channel access. |
| `snazi list-new [--channel <id>] [--since <min>] [--fresh]` | Distinct inbound senders, counts, timestamps, approval status, display label, and local Contacts `contact_name`. **No text.** Default window 60 min. |
| `snazi read <sender> [--channel <id>] [--since <min>] [--fresh]` | Message text for one sender — **only if approved**. Otherwise errors with `No messages for you.` |
| `snazi send <recipient> --text <message> [--channel <id>]` | Send a message. **Never gated** — you can always send to anyone. |
| `snazi check <sender> --channel <id> [--fresh]` | One sender's approval status, display label, and local Contacts `contact_name` (`approved`/`denied`/`unknown`). |
| `snazi channels list` | Configured channels plus adapter availability on this machine. |
| `snazi channels add <channel>` | Add a channel (e.g. `snazi channels add imessage`). |
| `snazi cache clear` | Drop cached approval statuses (force fresh checks after a revocation). |
| `snazi status` | Config path, apiUrl, masked read token, channels, server reachability. |
| `snazi serve [--bind <ip>] [--port <n>]` | Start the read-only HTTP gate (see **Serve mode** below). |
| `snazi serve --install-daemon [--bind <ip>] [--port <n>]` | Install the launchd LaunchAgent for serve mode (macOS only). |
| `snazi remote-status` | Probe a remote serve's `/health` (`remoteUrl`). |
| `snazi remote-list-new [--channel <id>] [--since <min>]` | WHO messaged on the remote host + status + label. |
| `snazi remote-check <sender> --channel <id>` | One sender's status and label, via remote serve. |
| `snazi remote-read <sender> [--channel <id>] [--since <min>]` | Message text via remote serve — only if approved. |
| `snazi remote-send <recipient> --text <message> [--channel <id>]` | Send a message via remote serve — never gated. |
| `snazi remote-resolve [<name>] --channel <id>` | Resolve a name → sender address(es). Empty name = full address book. |
| `snazi remote-label <sender> --name <name> --channel <id>` | Set a sender's display label (UPDATE-only; cannot open the gate). |

All output is JSON. Approval status is cached on disk for a short TTL (default 5
min; set `checkCacheTtlMs` in config or `SNAZI_CHECK_CACHE_TTL_MS`). Pass
`--fresh` on read/check/list-new to bypass the cache, or run `snazi cache clear`
right after you revoke someone.

### Examples

```bash
snazi list-new --since 180
# [
#   { "sender": "+15551234567", "message_count": 3,
#     "latest_at": "2026-06-23T22:10:04.000Z", "status": "unknown",
#     "label": null, "contact_name": "Jenny Tutone" }
# ]

snazi read "+15551234567"
# { "error": "Sender not approved. No messages for you.", "status": "unknown" }

# Approve in the dashboard, or mint a one-tap /decide link with your read token:
curl -s -H "x-api-key: $READ_TOKEN" \
  "https://snazi.dev/api/decide-link?channel=imessage&sender=%2B15551234567&label=Mom"
# { "url": "https://snazi.dev/decide?owner=…&channel=imessage&sender=%2B15551234567&exp=…&sig=…", … }
# Tap Allow on that link, then:

snazi read "+15551234567"
# { "sender": "+15551234567", "status": "approved", "since_minutes": 60,
#   "messages": [ { "date": "...", "text": "hey are we still on for lunch?" } ] }

snazi send "+15551234567" --text "On my way!"
# { "ok": true, "channel": "imessage", "recipient": "+15551234567" }
```

## Serve mode — least-privilege HTTP gate over a tailnet

Sometimes the agent that wants to triage messages runs on a *different* machine
than the one signed into iMessage. SSH would work, but SSH grants a **full shell** —
far more than "let me read approved messages." `snazi serve` exposes **only** the
gated, read-only operations over HTTP so a remote trusted agent gets least
privilege.

```
  Agent host (remote client)                     Serve host (iMessage Mac)
  ┌────────────────────┐   Tailscale tailnet   ┌──────────────────────┐
  │ snazi remote-read   │ ───── HTTP ─────────► │ snazi serve           │
  │   (bearer token)    │   100.x:8787          │  /health  (no auth)   │
  └────────────────────┘                       │  /list-new  (bearer)  │
                                                │  /check     (bearer)  │
                                                │  /read      (bearer)  │
                                                │  /resolve   (bearer)  │
                                                │  POST /label (bearer) │
                                                │  POST /send  (bearer) │
                                                │     │                 │
                                                │     ▼ same gate (api)  │
                                                │  approved? → text      │
                                                │  else     → "No        │
                                                │             messages   │
                                                │             for you."  │
                                                └──────────────────────┘
```

### Endpoints (all JSON)

| Method + path | Auth | Returns |
| --- | --- | --- |
| `GET /health` | none | `{ ok: true, version }` — connectivity probe only, no data. |
| `GET /list-new?channel=imessage&since=<min>` | bearer | `{ channel, since_minutes, senders: [{ sender, message_count, latest_at, status, label, contact_name }] }`. On check failure: `status` is `unknown` and an `error` field describes the failure. **Never message text.** |
| `GET /check?sender=<addr>&channel=imessage` | bearer | `{ channel, sender, status, label, contact_name }`. On check failure: HTTP 502 with `{ error }`. |
| `GET /read?sender=<addr>&channel=imessage&since=<min>` | bearer | `{ sender, channel, status, since_minutes, contact_name, messages }` **only if approved**; otherwise `403 { error: "Sender not approved. No messages for you.", status }`. On check failure: HTTP 502 with `{ error }`. |
| `POST /send` body `{ recipient, channel, text }` | bearer | Send an outbound message. **Never gated** — you can always send to anyone. Returns `{ ok: true, channel, recipient }` on success. |
| `GET /resolve?name=<q>&channel=imessage` | bearer | `{ channel, query, matches: [{ sender_address, label, status, contact_name }] }`. Empty/omitted `name` returns every labelled sender. **Never message text.** |
| `POST /label` body `{ sender, channel, name }` | bearer | Set a sender's display label via an UPDATE-only web endpoint. **Cannot create a row or change `status`**, so it cannot open the gate. 404 if the sender is not on the list yet. |

There is **no `approve`/`deny` over HTTP**. Approvals stay dashboard/`/decide`-only.
`POST /label` is the only write — label metadata only. Unknown path → `404`. Bad
params → `400`. Unsupported methods → `405`.

### `contact_name` — local macOS Contacts enrichment (display only)

`/list-new`, `/check`, `/resolve` (and the `200` body of `/read`) include a
`contact_name` for each sender: the matching name from the serve host's **local
macOS Contacts** (AddressBook), looked up by phone/email. It is attached for
**every** sender **regardless of approval status**, so you can see *who* an
`unknown`/`denied` caller is without reading their messages.

- **Display-only, never a gate.** `contact_name` **never** affects `status`,
  approval, or the read gate. Reading is still allowed **solely** when
  `status === 'approved'` — a known contact name does **not** open the gate.
- **Separate from `label`.** `label` = the name you set on your snazi.dev
  account (privileged). `contact_name` = read locally from macOS Contacts. Both
  fields are kept separate in the JSON; `null` when there's no match.
- **Untrusted text.** A contact name is stripped of control characters and
  length-capped (≤64) before it's ever returned — it can't carry a
  terminal/log-injection payload.
- **Degrades silently.** If Contacts is unreadable (no permission, non-macOS,
  native module missing), `contact_name` is simply `null` and nothing breaks.

**Contacts access on the serve host.** Reading the AddressBook DB needs the node
binary to have **Contacts** access (or **Full Disk Access**, which already
covers the AddressBook database). Full Disk Access is the simplest option since
you already grant it for iMessage; without it `contact_name` just stays `null`.

### Security model

- **Tailnet-only.** Default bind is this host's Tailscale IP (`100.64.0.0/10`) if
  present, else `127.0.0.1`. It **never** binds `0.0.0.0` — `--bind 0.0.0.0` is
  refused. For loopback bind, front it with `tailscale serve` to reach it on the
  tailnet over HTTPS.
- **Bearer token required** on every endpoint except `/health`. The token is
  `serveToken` in config; comparison is constant-time (SHA-256 + `timingSafeEqual`)
  and the token is never logged.
- **Read-only surface.** No shell, no arbitrary file reads, no path traversal —
  only the same channel adapters the CLI uses. Params are validated
  (`channel`/`sender` charset-checked, `since` clamped to ≤ 7 days).
- **Same gate for reading.** `/read` calls the server list API (`api.ts`) *before*
  touching any text — identical to `snazi read`. The gate is the product; it is
  not bypassed. **Sending is never gated** — `/send` and `snazi send` work for
  any recipient.
- **No storage.** Content is read live from `chat.db` and returned in the
  response only. Nothing is persisted on either side.

### Config keys

Add to `~/.snazi/config.json` on the **serve host**:

```json
{
  "serveToken": "<openssl rand -hex 32>",
  "serveBind": "100.64.0.10",   // optional; default = tailnet IP else 127.0.0.1
  "servePort": 8787              // optional; default 8787
}
```

And on the **agent host** (remote client):

```json
{
  "remoteUrl": "http://100.64.0.10:8787",
  "remoteToken": "<same value as serveToken on the serve host>"
}
```

### Run it

```bash
# Foreground (binds tailnet 100.x if present, else 127.0.0.1):
snazi serve

# Explicit bind/port:
snazi serve --bind 100.64.0.10 --port 8787
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
snazi remote-send  "+15551234567" --text "On my way!"
snazi remote-resolve "Dan" --channel imessage
snazi remote-label "+15551234567" --name "Dan" --channel imessage
```

…or plain `curl` (bearer token in the header, never logged server-side):

```bash
TOKEN=...   # the serveToken
BASE=http://100.64.0.10:8787

curl -s "$BASE/health"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/list-new?channel=imessage&since=120"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/check?sender=%2B15551234567&channel=imessage"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/read?sender=%2B15551234567&channel=imessage"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/resolve?name=Dan&channel=imessage"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sender":"+15551234567","channel":"imessage","name":"Dan"}' "$BASE/label"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"recipient":"+15551234567","channel":"imessage","text":"On my way!"}' "$BASE/send"
# Unknown/denied sender on /read → 403 { "error": "Sender not approved. No messages for you.", ... }
```

## Why this design

- **No prompt-injection surface from strangers.** The agent never sees content
  from unknown senders, so a malicious text can't smuggle instructions to it.
- **No message storage anywhere.** Cheap and private. The server is a list, not
  an inbox.
- **Extensible.** The same server list API works for other channels (e.g.
  Gmail) — just add a channel and a new wrapper that calls `/api/senders/check`.
