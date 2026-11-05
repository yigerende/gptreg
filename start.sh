#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

PORT="${GPT_RE_UI_PORT:-3210}"
BASE_URL="http://127.0.0.1:$PORT"
RUNTIME_DIR="$DIR/.gpt-re-state/v2/runtime"
mkdir -p "$RUNTIME_DIR"

# Check if already running
if curl -s "$BASE_URL/api/v1/health" | grep -q '"ok":true'; then
  echo "GPT-Register is already running at $BASE_URL"
  exit 0
fi

# Build web frontend if dist/index.html is missing
if [ ! -f "$DIR/web/dist/index.html" ]; then
  echo "Building web frontend..."
  npm run ui:build
fi

echo "Starting GPT-Register console at $BASE_URL ..."
node src/ui-server/index.js
