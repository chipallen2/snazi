# Soup Nazi AI - snazi

> No messages for you.

**Live at [snazi.dev](https://snazi.dev)** — sign up free, or self-host (see [Setup](#setup)).

A communication **gating layer** for AI agents. It prevents prompt injection
from strangers by controlling whether an agent can see message *content* —
based purely on an approved/denied list of senders.

The agent can always learn **who** sent a message. It can only read **what**
they said if the sender is approved.

It is **multi-tenant**: anyone can sign up, and each account has its own
private approve/deny list and its own read token. Run your own deployment, or
use a shared one.

## Two parts (and nothing else)

### Part A — Server (`packages/web`): the LIST manager
A Next.js 14 + Tailwind app on Vercel, backed by Supabase. It does exactly one
thing: manage a per-account approve/deny list of senders per channel.

- **It stores no messages. There is no inbox table. No content ever touches the
  server.** This is the whole point.
- **Accounts:** sign up at `/signup` (email + password). Every query is scoped
  to the logged-in owner, so one account never sees another's list. Each account
  gets a per-user **READ token** (shown on the `/account` page) for the CLI.
- API (authenticated by the per-user read token via `x-api-key` / `Bearer`,
  scoped to that account):
  - `GET /api/senders/check?channel=imessage&address=<addr>` →
    `{ status: "approved" | "denied" | "unknown" }`
  - `GET /api/senders?channel=imessage` → that account's full list
  - `PATCH /api/senders/label` → set a sender's display label (UPDATE-only;
    can never create a row or change status)
  - `GET /api/decide-link?channel&sender&label` → a **signed, expiring**
    `/decide` link bound to your account
  - There is **no mutate API**: the read token can never approve/deny. Approvals
    happen in the dashboard (session) or via a signed `/decide` link.
- Dashboard: `/` (manage your senders), `/account` (your read token). Gated by
  an HMAC-signed session cookie via `/login` + middleware.
- Session cookies and `/decide` links are HMAC-signed with
  `SOUP_NAZI_AUTH_SECRET`; a decide link's signature covers its owner, so it can
  only ever modify the account that minted it.

### Part B — gate CLI (`packages/snazi`): the LOCAL gate
A plain on-demand CLI (TypeScript → `dist/`) that runs on any OS (install from
source today; see [Setup](#setup)). The agent runs it on demand. It reads
messages through pluggable **channel adapters**; the iMessage adapter reads
`~/Library/Messages/chat.db` (read-only) on macOS.

- `snazi init` / `snazi doctor` → set up config and diagnose it (no JSON editing).
- `snazi list-new` → reveals **who** messaged + approval status. Never text.
- `snazi read <sender>` → checks the server first; prints text **only if
  approved**, otherwise "No messages for you."
- `snazi send <recipient> --text <message>` → sends an iMessage. **Never
  gated** — you can always send to anyone.
- `snazi check <sender> --channel <id>` → one sender's status.
- `snazi channels list|add` → manage channels + see adapter availability here.
- `snazi status` → config + platform + connectivity.

The CLI is **read-only**: there is no `approve`/`deny`. Approvals happen in the
dashboard or via a signed `/decide` link.

See [`packages/snazi/README.md`](packages/snazi/README.md).

#### Serve mode — least-privilege HTTP gate over a tailnet (opt-in)
When the agent runs on a *different* Mac than the one with iMessage, SSH would
hand it a full shell. Instead, `snazi serve` exposes **only** the read-only
gated operations over HTTP, reachable only on a private Tailscale tailnet:

- `GET /health` (no auth) · `GET /list-new` · `GET /check` · `GET /read` ·
  `GET /resolve` · `POST /label` · `POST /send` — bearer-token protected except
  `/health`. `/read` is read-only gated; `/send` is never gated (you can always
  send to anyone). `/label` is UPDATE-only (display names, cannot change
  approval status).
- **No `approve`/`deny` over HTTP** (approvals stay dashboard/`/decide`-only).
- Binds the **tailnet 100.x IP** (or `127.0.0.1` with `tailscale serve`),
  **never `0.0.0.0`**. Bearer token (`serveToken`) compared in constant time and
  never logged. `/read` enforces the **same approved-list gate** as the CLI.
- Run it in the background with one command: **`snazi start`** (and `snazi stop`
  / `snazi restart`). It installs the right OS service for you — launchd on
  macOS, a systemd `--user` unit on Linux, a hidden Scheduled Task on Windows —
  auto-starts it at login, mints a `serveToken` if you don't have one, and
  checks `/health`. No `launchctl`/`systemctl`/`schtasks` to memorize. On macOS
  the node binary still needs **Full Disk Access** to read `chat.db`.
- Remote agent uses `snazi remote-list-new` / `remote-read` / `remote-check` /
  `remote-resolve` / `remote-label` / `remote-send` (config: `remoteUrl`,
  `remoteToken`) or plain `curl`.

See [`packages/snazi/README.md`](packages/snazi/README.md#serve-mode--least-privilege-http-gate-over-a-tailnet)
for the full security model, config keys, and FDA setup.

The base CLI still runs **on demand**; serve mode is off by default and
entirely opt-in. Neither side stores message content.

## The approval flow

1. Agent: `snazi list-new` → sees `+1555… (unknown)`.
2. Agent asks you (or sends a one-tap `/decide` link via
   `GET /api/decide-link`): "New messages from +1555…, approve?"
3. You approve in the dashboard (or by tapping **Allow** on the `/decide` link).
4. Agent: `snazi read +1555…` → now the gate opens and text is returned.

Unknown/denied senders stay opaque. A malicious stranger can't inject content
into the agent because the agent never sees their words. **Sending is never
gated** — the agent can always reply or notify you via `snazi send`.

## Layout

```
packages/
  web/      Next.js list-manager (API + dashboard)  → Vercel
  snazi/    On-demand gate CLI (pluggable channels) → your computer (any OS)
```

## Data model (Supabase, `sna_` prefixed)

- `sna_users` — accounts: email, password hash, per-user read token. **No
  message data.**
- `sna_channel_types` — global registry of channel **types** (`imessage`,
  `gmail`, `outlook` seeded). Shared reference data, not per-user.
- `sna_channels` — per-user channel **instances**: a named "channel" (e.g.
  "Work"), with a `type` and a per-owner `slug`. **Many instances may share a
  type** (a Personal *and* a Work Gmail). Scoped to `owner_id`. Stores only
  name + type — **never credentials** (those live on the CLI machine).
- `sna_senders` — the approve/deny list, **scoped to `owner_id`** and to a
  channel instance (`channel_id` = that instance's slug). `status` ∈
  {`approved`,`denied`}; absent = `unknown`. **No message tables exist.**

Tenant isolation is enforced in the app layer: every sender query goes through
`packages/web/src/lib/data.ts`, which requires an `owner_id`.

## Setup

**Server (`packages/web`)**

1. Create a Supabase project.
2. Run the SQL in `packages/web/supabase/migrations/` in order: `001`, `003`,
   `004`, and `005` are required (`004` introduces named, per-user channel
   instances; `005` drops a legacy channel-id constraint so per-channel
   approvals work). `002` is an optional performance index (see the file
   header); skip it unless you want faster name resolution at scale.
3. Deploy `packages/web` to Vercel with these env vars (see `.env.example`):
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SOUP_NAZI_AUTH_SECRET`
   (`openssl rand -hex 32`).
4. Open the deployment, sign up at `/signup`, and copy your read token from
   `/account`.

**CLI (`packages/snazi`)** — macOS, Windows, or Linux (Node 18+):

```bash
npm install -g @chipallen2/snazi   # scoped package; the command is just `snazi`
snazi init      # writes ~/.snazi/config.json (deployment URL + your READ token)
snazi doctor    # verifies Node, config, connectivity, and channel access
```

`snazi init` also offers to set up the always-on background gate (serve mode) for
remote agents — or run it any time with **`snazi start`** (and `snazi stop` /
`snazi restart`), which installs the right OS service for you. Most single-machine
users can skip it.

Prefer source? `git clone https://github.com/chipallen2/snazi.git && cd snazi/packages/snazi && ./install.sh`.

On macOS, grant Full Disk Access so the CLI can read
`~/Library/Messages/chat.db` (System Settings → Privacy & Security → Full Disk
Access). `snazi doctor` flags it if missing. The CLI runs on any OS, but a given
channel only works where its adapter does (iMessage is macOS-only); a non-Mac
host can still drive a Mac's `snazi serve` over a tailnet via the `remote-*`
commands.

## Channels: types vs. instances

- A channel **type** (`imessage`, `gmail`, `outlook`) defines the adapter +
  transport. Types are global, seeded in `sna_channel_types`.
- A channel **instance** is a *named* connection of a type that a user creates
  (dashboard → **Channels**), e.g. "Personal" and "Work" Gmail. Each instance
  has its own approve/deny list. Credentials for an instance live **only on the
  CLI machine** (`~/.snazi/config.json`), never on the server.

To use a new channel instance, create it in the dashboard (name + type), then
configure the matching id + credentials locally with `snazi channels add` (see
[`packages/snazi/README.md`](packages/snazi/README.md#channels--email-setup)).

### Adding a new channel TYPE (for contributors)

1. **Server:** add a row to `sna_channel_types` (the global registry). The list
   API, the gate, and `/decide` links are already channel-agnostic.
2. **Local adapter:** add a `ChannelAdapter` under
   `packages/snazi/src/channels/` (implement `availability`,
   `listInboundSenders`, `readMessagesFrom`, and optionally `sendMessage`) and
   register it in `src/channels/index.ts`. Adapters receive a `ChannelContext`
   carrying the instance's local credentials. Every CLI/serve command then works
   for it automatically, on whatever OS the adapter supports.

The gate (`GET /api/senders/check`) is enforced before any content is revealed,
regardless of channel.

## CI & releases

GitHub Actions handles build, test, and publishing (see `.github/workflows/`):

- **`ci.yml`** runs on every push/PR to `main` — builds and tests `snazi`
  (Node 18 + 20) and `web`. A normal commit to `main` **never** publishes.
- **`release.yml`** runs only when a `v*` tag is pushed — it re-tests, verifies
  the tag matches `package.json`, runs `npm publish --provenance`, and cuts a
  GitHub Release. Auth is **npm Trusted Publishing (OIDC)** — no stored token.

Cutting a release (from `packages/snazi`, on a clean `main`):

```bash
cd packages/snazi
npm run release:patch   # 0.1.0 -> 0.1.1  (or release:minor / release:major)
```

That bumps the version, commits, creates the `vX.Y.Z` tag, and pushes both — the
tag push triggers `release.yml`, which publishes to npm. No manual `npm publish`.

**One-time setup (Trusted Publishing).** npm cannot publish a brand-new package
over OIDC, so:

1. Publish the first version manually (from a clean `main`, logged in to npm):
   ```bash
   cd packages/snazi && npm publish --access public
   ```
2. On npmjs.com → the package → **Settings → Trusted Publisher**, add a GitHub
   Actions publisher: org/user `chipallen2`, repository `snazi`, workflow
   filename `release.yml`.

After that, every `npm run release:*` publishes automatically via OIDC — no
`NPM_TOKEN` secret to create, store, or rotate.
