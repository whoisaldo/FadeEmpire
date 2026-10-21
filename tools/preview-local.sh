#!/usr/bin/env bash
# preview-local.sh — the site against the local barber-app stack, served the
# way GitHub Pages serves it (tools/serve-pages.py: 404.html for missing paths,
# so /<barber-slug> links work), reachable over the tailnet.
#
#   tools/preview-local.sh            copy, point config.js at the local stack, serve
#
# The copy goes to $PREVIEW_DIR (default: site-preview next to this checkout),
# hard-linked to this checkout so it costs no disk; only scripts/config.js is
# a file of its own, with SUPABASE_URL and the anon key of the local stack
# (tools/local-stack.sh). The repository itself is never edited.
#
#   PORT            default 8021; the script stops if something already listens there
#   PREVIEW_HOST    the address in the API URL and the printed link
#                   (default: this machine's Tailscale IPv4, else 127.0.0.1)
#   LOCAL_API_URL   default http://$PREVIEW_HOST:56321
#   LOCAL_ANON_KEY  default the local stack's anon key (Supabase's public demo key)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${PREVIEW_DIR:-$(dirname "$ROOT")/site-preview}"
PORT="${PORT:-8021}"
HOST_IP="${PREVIEW_HOST:-$(tailscale ip -4 2>/dev/null | head -n 1 || true)}"
HOST_IP="${HOST_IP:-127.0.0.1}"
API="${LOCAL_API_URL:-http://$HOST_IP:56321}"
KEY="${LOCAL_ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0}"
LOG="${TMPDIR:-/tmp}/fe-site-preview-$PORT.log"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  echo "Pick another with PORT=..., or stop that server first." >&2
  exit 1
fi

if ! curl -fsS -o /dev/null -m 5 "$API/rest/v1/" -H "apikey: $KEY"; then
  echo "warning: the local stack does not answer at $API (tools/local-stack.sh start); the site will use config.js's barbers" >&2
fi

# The site as deployed: no tooling, tests or database files, except the live-health script.
mkdir -p "$DEST"
rsync -a --delete --link-dest="$ROOT" \
  --exclude '.git' --exclude 'node_modules' --exclude 'supabase' --exclude 'tools' --exclude 'docs' \
  --include 'tests/' --include 'tests/ci/***' --exclude 'tests/*' \
  "$ROOT/" "$DEST/"

# config.js is replaced, never edited in place: it is a hard link to this checkout's.
rm -f "$DEST/scripts/config.js"
sed -e "s|^export const SUPABASE_URL *= .*|export const SUPABASE_URL      = '$API';|" \
    -e "s|^export const SUPABASE_ANON_KEY *= .*|export const SUPABASE_ANON_KEY = '$KEY';|" \
    "$ROOT/scripts/config.js" > "$DEST/scripts/config.js"
if ! grep -q "SUPABASE_URL      = '$API'" "$DEST/scripts/config.js" \
  || ! grep -q "SUPABASE_ANON_KEY = '$KEY'" "$DEST/scripts/config.js"; then
  echo "config.js was not rewritten (its SUPABASE_URL/SUPABASE_ANON_KEY lines changed?)" >&2
  exit 1
fi

nohup python3 "$ROOT/tools/serve-pages.py" "$DEST" --port "$PORT" --host 0.0.0.0 >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null -m 1 "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.2
done
curl -fsS -o /dev/null -m 2 "http://127.0.0.1:$PORT/" || { echo "the server did not start; see $LOG" >&2; exit 1; }

echo "Preview of $ROOT"
echo "  files    $DEST"
echo "  database $API"
echo "  open     http://$HOST_IP:$PORT/"
echo "  server   pid $PID, log $LOG (stop it with: kill $PID)"
