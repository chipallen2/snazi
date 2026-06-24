# soup-nazi — iMessage wrapper CLI

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
  soup-nazi list-new        ──►  reveals WHO + status (approved/denied/unknown)
        │                         (never the message text)
        │  unknown sender? agent asks Chip: "approve +1555…?"
        │  Chip approves via the dashboard → server list updated
        ▼
  soup-nazi read <sender>   ──►  CLI asks server: is this sender approved?
                                   ├─ approved → prints message text
                                   └─ otherwise → "No messages for you."
```

The approval decision lives entirely on the server (Supabase-backed list). The
CLI only *checks* it. It cannot reveal content for a non-approved sender.

## Install

```bash
./install.sh
```

This runs `npm install && npm run build`, creates `~/.soup-nazi/config.json`
(template), and prints next steps. Then:

1. Edit `~/.soup-nazi/config.json`:
   ```json
   {
     "apiUrl": "https://your-deployment.vercel.app",
     "apiKey": "<SOUP_NAZI_API_KEY>"
   }
   ```
2. Grant **Full Disk Access** to your terminal (System Settings → Privacy &
   Security → Full Disk Access) so it can read `chat.db`.
3. Optional: `npm link` to put `soup-nazi` on your PATH.

## Commands

| Command | What it reveals |
| --- | --- |
| `soup-nazi list-new [--since <min>]` | Distinct inbound senders, message counts, latest timestamp, and approval status. **No text.** Default window 60 min. |
| `soup-nazi read <sender> [--since <min>]` | Message text for one sender — **only if approved**. Otherwise errors with `No messages for you.` |
| `soup-nazi status` | Config path, apiUrl, masked key, server reachability. |

All output is JSON.

### Examples

```bash
soup-nazi list-new --since 180
# [
#   { "sender": "+15551234567", "message_count": 3,
#     "latest_at": "2026-06-23T22:10:04.000Z", "status": "unknown" }
# ]

soup-nazi read "+15551234567"
# { "error": "Sender not approved. No messages for you.", "status": "unknown" }

# ...after Chip approves the sender in the dashboard...
soup-nazi read "+15551234567"
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
