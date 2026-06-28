# Soup Nazi AI — snazi

> No messages for you.

**Live at [snazi.dev](https://snazi.dev)** — a hosted allow list (Supabase). Your messages never go there.

---

## What is this?

**Soup Nazi AI (snazi)** is a safety layer for AI agents that read your messages (iMessage, Gmail, Outlook, and more).

The problem: if an agent can read every incoming message, a stranger can prompt-inject it — hide instructions in a text and trick the agent into doing something bad.

The fix: **snazi decides who the agent is allowed to read.** The agent can always see *who* messaged. It only sees *what* they said if you have approved that sender.

**[snazi.dev](https://snazi.dev) is only the allow list** — who you approved or denied. Your agent does **not** send messages through snazi.dev. It calls the **`snazi` CLI**, which reads your mail/iMessage locally and asks snazi.dev *"is this sender approved?"* before returning any text.

- **No message relay.** snazi.dev is a database + dashboard, not a messaging API.
- **Private by default.** Message content stays on the machine running the CLI; the server never sees it.
- **Multi-tenant.** Each account has its own list and read token. Use [snazi.dev](https://snazi.dev) or self-host the same list server.

---

## How it works

Two pieces:

| Piece | What it does |
| --- | --- |
| **Server** ([snazi.dev](https://snazi.dev)) | Your approve/deny list + dashboard |
| **CLI** (`snazi`) | What your agent calls — list, read, send. Reads messages locally; checks the list before revealing text. |

```
  Your AI agent
       │
       │  snazi list-new / read / send   (agent → CLI, not snazi.dev)
       ▼
  ┌─────────────────────────────────────┐
  │  snazi CLI                          │
  │  reads chat.db / Gmail / Outlook    │
  └──────────────┬──────────────────────┘
                 │
                 │  "is +1555… approved?"
                 ▼
  ┌─────────────────────────────────────┐
  │  snazi.dev — allow list only        │
  └─────────────────────────────────────┘
```

**Typical flow**

1. Agent runs `snazi list-new` → sees new senders + status — never the message body.
2. Unknown sender? Agent mints a one-tap approve link and texts it to you.
3. You tap **Allow** on that link. (Backup: approve in the [snazi.dev](https://snazi.dev) dashboard.)
4. Agent runs `snazi read <sender>` → CLI checks the list → text returned if approved.

Sending is never gated — `snazi send` always works. snazi.dev is not in that path.

The two machines (recommended): the CLI runs on your **messages machine** (the one with your messages), and your AI runs on a separate **agent machine** that calls it over the network. This keeps your message credentials away from the agent — see [Get started](#get-started) and [Messages machine vs agent machine](#messages-vs-agent-advanced) below.

---

## Get started

This is the **recommended two-machine setup**: the CLI runs on your **messages machine** (the one with your messages), and your AI runs on a separate **agent machine** that calls it over a private [Tailscale](https://tailscale.com) tailnet. It keeps your message credentials away from the agent.

**Before you start:** install [Tailscale](https://tailscale.com/download) on **both** the messages machine and the agent machine, signed into the same tailnet, so they can reach each other over a private `100.x.y.z` IP.

> Prefer a different topology? See [Other setups](#other-setups-advanced) in Advanced for the trade-offs (single sandboxed machine, public server, etc.).

### 1. Create an account (allow list only)

Go to **[snazi.dev/signup](https://snazi.dev/signup)** to get a hosted allow list. Create an account, open **Account**, and copy your **READ token**.

### 2. Set up the messages machine

On the machine that has your messages (iMessage Mac, or the box where Gmail/Outlook creds live):

```bash
npm install -g @chipallen2/snazi
snazi init          # deployment URL + READ token → ~/.snazi/config.json
snazi start         # background HTTP gate on your tailnet; mints a connect token
```

`snazi start` prints a **connect token** once (it's this machine's `serveToken`) — copy it; you'll paste it into the agent machine in step 3.

On macOS, grant **Full Disk Access** to the `node` binary `snazi start` prints (System Settings → Privacy & Security → Full Disk Access → "+", then add that binary). This also enables optional Contacts name lookups. On Windows/Linux there's no Full Disk Access step — those run Gmail/Outlook over HTTPS (iMessage is macOS-only).

Something not working? Run `snazi doctor` to check Node, config, connectivity, and channel access (it flags missing Full Disk Access too).

### 3. Set up the agent machine

On the machine where your AI agent runs — it gets **no OAuth creds and no message access**, just a pointer to the messages machine:

```bash
npm install -g @chipallen2/snazi
snazi init-agent    # paste the connect token from step 2 + your READ token from step 1
```

`snazi init-agent` writes `~/.snazi/config.json` for you and pings the messages machine so you know it's reachable. It asks for three things:

- **Messages machine URL** — `http://<messages-machine-tailscale-ip>:8787` (run `snazi status` on the messages machine to see its IP/port).
- **Connect token** — the one `snazi start` printed in step 2.
- **READ token** — your account READ token from step 1.

### 4. Give your AI agent the skill

snazi ships an agent **skill** — [`packages/snazi/SKILL.md`](https://github.com/chipallen2/snazi/blob/main/packages/snazi/SKILL.md) — that teaches your agent both the commands **and** the safety rules (never read unapproved senders, treat message text as untrusted, send a one-tap approve link for unknowns, decisions don't cross channels, …).

Install it the way your agent loads skills/instructions — e.g. drop it in your agent's skills folder, add it as a tool, or paste it into the system prompt. Then just ask, in plain language:

> "Check who's messaged me in the last 2 hours. Summarize anything from approved senders, and for anyone unknown, text me a one-tap approve link."

The agent runs the gated commands for you (`snazi remote-list-new`, `remote-read`, `remote-send`, …) and only sees message text for approved senders. When it hits an unknown sender, it mints a one-tap approve link and texts it to you — tap **Allow** and you're done. (Backup: approve senders in the [snazi.dev](https://snazi.dev) dashboard.)

Want to sanity-check the connection yourself first? From the agent machine:

```bash
snazi remote-list-new --channel imessage                # WHO messaged (no text)
snazi remote-read "+15551234567" --channel imessage     # text only if approved
```

---

## Channels

A **channel** is one message source your agent can use (for example: iMessage, Gmail, Outlook).

- Channels are independent: each one has its own allow/deny list.
- Credentials stay local on the **messages machine**.
- You target a channel by id with `--channel <id>`.
- You can have multiple channels of the same type - each with different names

### Add a channel (messages machine)

General shape:

```bash
snazi channels add <channel-id> --type <imessage|gmail|outlook> --name "<label>" [auth flags]
```

Pick a stable `<channel-id>` you will also use from the agent machine (for example `imessage`, `gmail-work`, `outlook-personal`).

#### iMessage (built into mac)

iMessage is built into a mac. No oath needed.

1. On macOS, grant your terminal app **Full Disk Access** (so snazi can read Messages data).
2. Add the iMessage channel:

```bash
snazi channels add imessage --type imessage --name "iMessage"
```

3. Ask your agent to use it. Then approve the contacts access on your messages machine.

#### Gmail

Use n8n's OAuth walkthrough to get `client id`, `client secret`, and `refresh token`:
[n8n Gmail OAuth guide](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service#custom-oauth2)

Then paste those values into:

```bash
snazi channels add gmail-work --type gmail --name "Gmail Work" \
  --client-id <client-id> \
  --client-secret <client-secret> \
  --refresh-token <refresh-token>
```

#### Outlook / Microsoft 365

Use n8n's OAuth walkthrough:
[n8n Outlook OAuth guide](https://docs.n8n.io/integrations/builtin/credentials/microsoft)

Then paste your values into:

```bash
snazi channels add outlook-work --type outlook --name "Outlook Work" \
  --client-id <client-id> \
  --client-secret <client-secret> \
  --refresh-token <refresh-token> \
  --tenant <tenant-id> \
  --user you@company.com
```

For single-tenant Microsoft apps, include both `--tenant` and `--user`.

### Use that channel from the agent machine

After adding a channel, use its id with remote commands:

```bash
snazi remote-list-new --channel gmail-work
snazi remote-read "<sender>" --channel gmail-work
```

Verify local setup on the messages machine:

```bash
snazi channels list
snazi doctor
```

For deeper snazi-specific email notes (scopes, Outlook tenant details), see [`packages/snazi/README.md#channels--email-setup`](packages/snazi/README.md#channels--email-setup).

---

## Repository layout

```
packages/
  web/      Allow-list DB + dashboard  →  snazi.dev (Vercel + Supabase)
  snazi/    The snazi CLI              →  messages machine (snazi start); agent machine (snazi init-agent + remote-*)
```

---

## Self-host the server (optional)

Prefer to run your own allow-list server instead of [snazi.dev](https://snazi.dev)? The service is `packages/web` (Next.js + Supabase). Skip this entirely if you use the hosted [snazi.dev](https://snazi.dev).

1. Create a [Supabase](https://supabase.com) project.
2. Run migrations in `packages/web/supabase/migrations/` in order: `001`, `003`, `004`, `005`. (`002` is an optional performance index — see its file header.)
3. Deploy `packages/web` to [Vercel](https://vercel.com) with:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `SOUP_NAZI_AUTH_SECRET` — generate with `openssl rand -hex 32`
4. Sign up on your deployment, copy your READ token, and point snazi at your URL: `snazi init --api-url https://your-deployment`.

---

## Advanced

<details>
<summary><strong>Non-interactive setup (scripts / CI)</strong></summary>

Skip the prompts. On the **messages machine** (and install the background gate in one shot):

```bash
snazi init --api-url https://snazi.dev --token <READ_TOKEN> --serve --yes
```

On the **agent machine**:

```bash
snazi init-agent --url http://100.x.y.z:8787 --token <connect-token> --read-token <read-token> --yes
```

</details>

<details>
<summary><strong>Tokens: connect token vs READ token</strong></summary>

<a id="tokens"></a>

Two different tokens flow into the agent machine during setup:

- **Connect token** (`serveToken`) — minted by `snazi start` on the messages machine. It's the password for the agent machine to reach that machine's HTTP gate over the tailnet. Keep it between your two machines.
- **READ token** (`apiKey`) — your per-account token from [snazi.dev](https://snazi.dev) → **Account**. It lets the agent check the allow list and mint one-tap `/decide` approve links. It's **read-only**: it can check the list and mint links, but it can't read message content or approve/deny, so it's safe on the agent and can't bypass the gate. Without it the agent still reads approved messages, but you'd approve new senders by hand in the dashboard.

</details>

<details>
<summary><strong>Messages machine vs agent machine</strong></summary>

<a id="messages-vs-agent-advanced"></a>

For a real AI agent, **don't run the agent on the same machine as the CLI** unless the agent is properly sandboxed. An agent with filesystem access can read `~/.snazi/config.json`, OAuth tokens, or `chat.db` and bypass snazi entirely.

**Recommended layout:**

| Machine | Where | Holds | Set up with |
| --- | --- | --- | --- |
| **Messages machine** | Mac with iMessage, or box with Gmail/Outlook creds | Messages, OAuth creds, READ token | `snazi init` + `snazi start` |
| **Agent machine** | Where your AI runs | `remoteUrl` + `remoteToken` + read-only READ token | `snazi init-agent` |
| **snazi.dev** | Hosted | Allow list only | sign up |

```
  Agent machine                           Messages machine
  ┌─────────────────────┐   tailnet HTTP  ┌──────────────────────────────┐
  │ remote-list-new     │ ──────────────► │ snazi start / snazi serve     │
  │ remote-read         │   connect token │ reads messages locally        │
  │ remote-send         │                 │ checks snazi.dev allow list   │
  └─────────────────────┘                 └──────────────────────────────┘
```

Keep **channel credentials** (OAuth tokens, `chat.db` access) on the messages machine only — those are what would let the agent bypass the gate. The agent machine gets the **connect token** (`serveToken`) minted by `snazi start` and your **READ token** so it can mint one-tap approve links. The READ token is read-only — it can check the list and mint links, but it can't read message content or approve/deny, so it's safe to put on the agent.

**Same machine?** `snazi list-new` / `snazi read` (no `remote-` prefix) are fine for manual testing on the messages machine. For an AI agent on that same box, treat it as unsafe unless sandboxed.

See [Get started](#get-started) for setup steps and [`packages/snazi/README.md#serve-mode--least-privilege-http-gate-over-a-tailnet`](packages/snazi/README.md#serve-mode--least-privilege-http-gate-over-a-tailnet) for the full HTTP/security model.

</details>

<details>
<summary><strong>Other setups</strong></summary>

<a id="other-setups-advanced"></a>

The two-machine + Tailscale layout in [Get started](#get-started) is the recommended one. Other topologies work too, with different trade-offs:

- **Two machines, no Tailscale.** Any network path where the agent can reach the messages machine's `serveToken`-protected HTTP gate works (LAN, a different VPN/WireGuard, an SSH tunnel). Tailscale is just the easiest private option; the gate refuses to bind a public `0.0.0.0` by default.
- **Messages machine on a public/cloud server.** Run it on a VPS reachable over HTTPS (e.g. front it with `tailscale serve` or your own TLS reverse proxy). Only works for HTTPS channels (Gmail/Outlook) — iMessage needs a Mac. Secure it carefully; the `serveToken` is the only thing standing between the internet and your messages.
- **Single machine, sandboxed agent.** Run both the CLI and the agent on one box **only if** the agent is sandboxed so it can't read `~/.snazi/config.json`, channel credentials, or raw message stores (`chat.db`, etc.). Without that isolation the agent can bypass the gate — see [Messages machine vs agent machine](#messages-vs-agent-advanced).
- **Single machine, manual use.** For your own testing (no untrusted agent), just run `snazi list-new` / `snazi read` locally — same gate, no serve mode needed.

</details>

<details>
<summary><strong>Adding a new channel type (contributors)</strong></summary>

Built-in types today: `imessage`, `gmail`, `outlook`. To add another (e.g. Slack, Signal):

1. **Server:** insert a row into `sna_channel_types` (the global type registry).
2. **CLI:** implement a `ChannelAdapter` in `packages/snazi/src/channels/` and register it in `src/channels/index.ts`.

The allow-list API and gate are already channel-agnostic — a new adapter plugs into the same `list-new` / `read` / `send` flow.

</details>

<details>
<summary><strong>Serve mode — HTTP endpoints &amp; security</strong></summary>

`snazi start` on the messages machine exposes gated read/send over HTTP on your Tailscale tailnet. The agent machine (set up with `snazi init-agent`) uses `remote-*` with `remoteUrl` + `remoteToken`.

```bash
snazi start      # messages machine
snazi stop
snazi restart
```

Full endpoint list, FDA notes, and config keys: [`packages/snazi/README.md#serve-mode--least-privilege-http-gate-over-a-tailnet`](packages/snazi/README.md#serve-mode--least-privilege-http-gate-over-a-tailnet).

</details>

<details>
<summary><strong>Server API</strong></summary>

Authenticated with your per-user READ token (`x-api-key` or `Bearer`). The read token can **check** the list and mint decide links — it cannot approve or deny.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/senders/check?channel=<id>&address=<addr>` | `{ status: "approved" \| "denied" \| "unknown" }` |
| `GET /api/senders?channel=<id>` | Full list for that channel |
| `PATCH /api/senders/label` | Set display label (UPDATE-only; cannot change status) |
| `GET /api/decide-link?channel&sender&label` | Signed, expiring `/decide` link for one-tap approval |

Approvals happen via a signed `/decide` link (the usual path — your agent mints one with the read token, you tap **Allow**) or in the dashboard (session cookie) — never through the read token alone.

</details>

<details>
<summary><strong>Data model (Supabase)</strong></summary>

All tables use the `sna_` prefix. **No message tables exist.**

| Table | Purpose |
| --- | --- |
| `sna_users` | Accounts, password hashes, per-user READ tokens |
| `sna_channel_types` | Global registry of channel types (seeded) |
| `sna_channels` | Per-user channel instances (name + type + slug) |
| `sna_senders` | Approve/deny list, scoped to owner + channel instance |

Tenant isolation is enforced in `packages/web/src/lib/data.ts` — every query requires an `owner_id`.

</details>

<details>
<summary><strong>Install from source</strong></summary>

```bash
git clone https://github.com/chipallen2/snazi.git
cd snazi/packages/snazi
./install.sh
snazi init && snazi doctor
```

Windows (no bash): `npm install && npm run build && npm link`

</details>

<details>
<summary><strong>CI &amp; releases</strong></summary>

- **`ci.yml`** — build and test on every push/PR to `main`. Does not publish.
- **`release.yml`** — runs on `v*` tags; publishes `@chipallen2/snazi` to npm via Trusted Publishing (OIDC).

Cut a release from `packages/snazi`:

```bash
npm run release:patch   # or release:minor / release:major
```

That bumps the version, tags, pushes, and triggers publish. First-time npm setup requires one manual `npm publish --access public`, then configure Trusted Publisher on npmjs.com for workflow `release.yml`.

</details>
