#!/usr/bin/env bash
# ============================================================
# Auto-Fix-Bug — Test Mode Launcher (DEBUG logging)
# ============================================================
# Usage:
#   bash start-test.sh          (Linux/macOS/Git Bash on Windows)
#   or double-click start-test.bat on Windows
#
# What this script does:
#   1. Sets LOG_LEVEL=DEBUG so every poll tick and webhook
#      reception is printed to the console with full detail
#      (trigger mention, issue number, author, match status)
#   2. Starts the dev server (nodemon with hot-reload)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export LOG_LEVEL=DEBUG
export NODE_ENV=development

echo "============================================================"
echo "  Auto-Fix-Bug — TEST MODE"
echo "  LOG_LEVEL = DEBUG"
echo "  NODE_ENV  = development"
echo "============================================================"
echo ""
echo "Every poll tick and every webhook receipt will be printed"
echo "to the console with full filter details."
echo ""
echo "Key fields to look for in the output:"
echo "  [Poller #N] Poll tick         — fetch count, repo, since cursor"
echo "  [Poller #N] Mention check     — trigger, matched, title/body/comment"
echo "  [Poller #N] Allowed user      — author, allowed list, result"
echo "  [Webhook #N] Received webhook — event, action, sender, repo"
echo "  [Webhook #N] Mention check    — same fields as poller"
echo "  [Webhook #N] Allowed user     — sender, allowed list, result"
echo ""
echo "Starting server..."
echo "============================================================"
echo ""

# Ensure node_modules exist
if [ ! -d "node_modules" ]; then
  echo "[start-test] node_modules not found, running npm install..."
  npm install
fi

# Use nodemon if available, otherwise plain node
if command -v npx &>/dev/null && npx --no-install nodemon --version &>/dev/null 2>&1; then
  exec npx nodemon src/index.js
else
  echo "[start-test] nodemon not found, using plain node (no hot-reload)."
  exec node src/index.js
fi
