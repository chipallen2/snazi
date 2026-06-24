#!/usr/bin/env bash
#
# snazi iMessage CLI installer (on-demand, NO daemon, NO launchd).
# Builds the CLI and scaffolds ~/.snazi/config.json.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.snazi"
CONFIG_PATH="$CONFIG_DIR/config.json"

echo "==> Installing dependencies (this compiles better-sqlite3)…"
cd "$SCRIPT_DIR"
npm install

echo "==> Building TypeScript -> dist/…"
npm run build

echo "==> Ensuring config dir at $CONFIG_DIR…"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [ ! -f "$CONFIG_PATH" ]; then
  cat > "$CONFIG_PATH" <<'JSON'
{
  "apiUrl": "https://soup-nazi-agent.vercel.app",
  "apiKey": "REPLACE_WITH_SOUP_NAZI_API_KEY",
  "adminKey": "REPLACE_WITH_SOUP_NAZI_ADMIN_KEY",
  "channels": ["imessage"]
}
JSON
  chmod 600 "$CONFIG_PATH"
  echo "    Wrote template config. EDIT IT with your real apiUrl + apiKey + adminKey."
else
  echo "    Config already exists — leaving it untouched."
fi

cat <<EOF

==> Done.

NEXT STEPS
  1. Edit $CONFIG_PATH
       - apiUrl   : your Vercel deployment URL (https://soup-nazi-agent.vercel.app)
       - apiKey   : the SOUP_NAZI_API_KEY (read/check key)
       - adminKey : the SOUP_NAZI_ADMIN_KEY (needed for approve/deny)

  2. Grant Full Disk Access so the CLI can read ~/Library/Messages/chat.db:
       System Settings > Privacy & Security > Full Disk Access
       -> add your Terminal app (Terminal.app / iTerm) and/or the node binary.

  3. (optional) Make 'snazi' available on PATH:
       cd "$SCRIPT_DIR" && npm link

  4. Try it:
       node "$SCRIPT_DIR/dist/cli.js" status
       node "$SCRIPT_DIR/dist/cli.js" list-new --since 120
       node "$SCRIPT_DIR/dist/cli.js" check "+15551234567" --channel imessage
       node "$SCRIPT_DIR/dist/cli.js" approve "+15551234567" --channel imessage --label "Mom"
       node "$SCRIPT_DIR/dist/cli.js" read "+15551234567"

This CLI runs ON DEMAND only. It is not a background service.
It stores nothing. The server stores no messages — only an approve/deny list.
EOF
