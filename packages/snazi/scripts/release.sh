#!/usr/bin/env bash
# Cut a release for @chipallen2/snazi.
#
# `npm version` only auto-commits/tags when run at the git ROOT; in this monorepo
# the package lives in packages/snazi, so we bump the file ourselves and then
# create the commit + tag at the repo root. Pushing the tag triggers
# .github/workflows/release.yml, which publishes to npm via Trusted Publishing.
#
# Usage: bash scripts/release.sh <patch|minor|major>
set -euo pipefail

BUMP="${1:-patch}"
case "$BUMP" in
  patch | minor | major) ;;
  *)
    echo "Usage: release.sh <patch|minor|major>" >&2
    exit 1
    ;;
esac

# Run from the package directory (this script lives in packages/snazi/scripts).
cd "$(dirname "$0")/.."
ROOT="$(git rev-parse --show-toplevel)"

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash changes before releasing." >&2
  git -C "$ROOT" status --short >&2
  exit 1
fi

# Bump the version in package.json (+ lockfile) without touching git.
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

git -C "$ROOT" add packages/snazi/package.json packages/snazi/package-lock.json
git -C "$ROOT" commit -m "release: $TAG"
git -C "$ROOT" tag -a "$TAG" -m "release: $TAG"
git -C "$ROOT" push --follow-tags

echo ""
echo "Pushed $TAG. GitHub Actions will publish $VERSION to npm via OIDC."
echo "Watch: gh run watch --workflow=release.yml"
