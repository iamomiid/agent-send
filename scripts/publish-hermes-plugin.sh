#!/usr/bin/env bash
# Mirror connectors/hermes/agent-send into its own repo, so Hermes can run
# `hermes plugins install <owner>/agent-send-hermes`. Usage: scripts/publish-hermes-plugin.sh [owner/repo]
set -euo pipefail
REPO="${1:-iamomiid/agent-send-hermes}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/connectors/hermes/agent-send"
VERSION="$(sed -n 's/^version: *//p' "$SRC/plugin.yaml")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --public --description "Hermes plugin for agent-send: connects a Hermes profile to your agent-send hub" >/dev/null
fi
# gh clone honours the user's git protocol (ssh or https); an empty new repo clones fine.
gh repo clone "$REPO" "$WORK/repo" -- --quiet 2>/dev/null
git -C "$WORK/repo" symbolic-ref HEAD refs/heads/main

cd "$WORK/repo"
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
rsync -a --exclude __pycache__ --exclude '*.pyc' "$SRC/" ./
cp "$ROOT/LICENSE" ./LICENSE
cp "$ROOT/connectors/hermes/README.md" ./README.md
printf '__pycache__/\n*.pyc\n' > .gitignore

git add -A
if git diff --cached --quiet; then
  echo "Nothing to publish; $REPO already matches v$VERSION."
  exit 0
fi
git commit --quiet -m "agent-send Hermes plugin v$VERSION"
git push --quiet -u origin main
echo "Published v$VERSION to https://github.com/$REPO ($(git rev-parse HEAD))"
