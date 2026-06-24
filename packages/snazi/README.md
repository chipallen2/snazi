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

## Why this design

- **No prompt-injection surface from strangers.** The agent never sees content
  from unknown senders, so a malicious text can't smuggle instructions to it.
- **No message storage anywhere.** Cheap and private. The server is a list, not
  an inbox.
- **Extensible.** The same server list API works for other channels (e.g.
  Gmail) — just add a channel and a new wrapper that calls `/api/senders/check`.
