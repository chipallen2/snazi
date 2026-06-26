#!/usr/bin/env bash
#
# snazi — source installer (macOS & Linux).
#
# Most users should just run:  npm install -g @chipallen2/snazi && snazi init
# This script is the FROM-SOURCE path for contributors: it installs deps, builds
# dist/, and links `snazi` onto your PATH. It does NOT write config — run
# `snazi init` for that (cross-platform, no hand-edited JSON).
#
# Windows users (no bash): run `npm install && npm run build && npm link` in this
# folder, then `snazi init`. This bash script is *nix-only.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Installing dependencies (may compile better-sqlite3 for iMessage)..."
npm install

echo "==> Building TypeScript -> dist/..."
npm run build

# Try to put `snazi` on PATH so the next steps can use it by name.
SNAZI="node \"$SCRIPT_DIR/dist/cli.js\""
if npm link >/dev/null 2>&1; then
  echo "    Linked 'snazi' onto your PATH (npm link)."
  SNAZI="snazi"
else
  echo "    Skipped 'npm link' (no permission?). Invoke via: node $SCRIPT_DIR/dist/cli.js"
fi

cat <<EOF

==> Done. Next steps:

  1. Create an account on your deployment's dashboard (/signup) and copy your
     READ token from the Account page.

  2. Configure the CLI (writes ~/.snazi/config.json — no manual JSON):
       $SNAZI init

  3. Verify everything (Node, config, connectivity, channel access):
       $SNAZI doctor

  4. macOS only — grant Full Disk Access so iMessage can be read:
       System Settings > Privacy & Security > Full Disk Access
       -> add your terminal (Terminal.app / iTerm) and/or the node binary.

  5. Try it (all read-only):
       $SNAZI list-new --since 120

Approvals are READ-ONLY here: approve/deny a sender in the dashboard or via a
signed /decide link. The server stores no messages — only an approve/deny list.
Serve mode (a least-privilege HTTP gate for a remote agent over a tailnet) is
opt-in and macOS-only for the launchd daemon; see README.md.
EOF
