#!/usr/bin/env bash
# tunnel.sh — expose the local alert dashboard to the public internet so TradingView's
# cloud can POST webhook fires to it. TradingView only accepts public http/https URLs on
# ports 80/443 (localhost is rejected), so a tunnel is required.
#
#   ./scripts/tunnel.sh                 # ephemeral URL
#   NGROK_DOMAIN=you.ngrok-free.app ./scripts/tunnel.sh   # your reserved static domain
#
# Env:
#   DASH_PORT       dashboard port to forward           (default 8787)
#   NGROK_DOMAIN    reserved static domain (stable URL) (optional; grab one free at
#                   https://dashboard.ngrok.com/domains — survives restarts)
#   WEBHOOK_SECRET  unguessable path segment; must match the dashboard's WEBHOOK_SECRET
#
# One-time: install ngrok, then `ngrok config add-authtoken <TOKEN>` (token from
# https://dashboard.ngrok.com/get-started/your-authtoken). Config lives in
# ~/.config/ngrok/ngrok.yml — NOT in this repo.
set -euo pipefail

PORT="${DASH_PORT:-8787}"
NGROK_BIN="${NGROK_BIN:-$(command -v ngrok || echo "$HOME/.local/bin/ngrok")}"
SECRET="${WEBHOOK_SECRET:-}"

if [ ! -x "$NGROK_BIN" ]; then
  echo "ngrok not found. Install it: https://ngrok.com/download  (or set NGROK_BIN)" >&2
  exit 1
fi

# is the dashboard up?
if ! curl -s -m2 "http://127.0.0.1:${PORT}/api/fired" >/dev/null 2>&1; then
  echo "warning: dashboard not responding on 127.0.0.1:${PORT} — start it first:" >&2
  echo "  WEBHOOK_SECRET=${SECRET:-<secret>} node scripts/dashboard.js --port=${PORT}" >&2
fi

ARGS=(http "$PORT" --log stdout --log-format json)
[ -n "${NGROK_DOMAIN:-}" ] && ARGS+=(--url "https://${NGROK_DOMAIN}")

echo "starting ngrok → 127.0.0.1:${PORT} ..."
"$NGROK_BIN" "${ARGS[@]}" >/tmp/tv_ngrok.log 2>&1 &
NGROK_PID=$!
trap 'kill $NGROK_PID 2>/dev/null || true' EXIT

# wait for the public URL from ngrok's local API
URL=""
for _ in $(seq 1 20); do
  URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
        | python3 -c "import sys,json;t=json.load(sys.stdin).get('tunnels',[]);print(t[0]['public_url'] if t else '')" 2>/dev/null || true)
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -z "$URL" ]; then echo "failed to get ngrok URL; see /tmp/tv_ngrok.log" >&2; exit 1; fi

HOOK="${URL}/webhook${SECRET:+/$SECRET}"
cat <<EOF

  public URL : ${URL}
  webhook    : ${HOOK}
  inspector  : http://127.0.0.1:4040

  Point alerts at this webhook:
    WEBHOOK_URL='${HOOK}' WEBHOOK_SECRET='${SECRET}' node scripts/dashboard.js --port=${PORT}
    # then click "Webhook all" in the dashboard (or POST /api/webhookify)

  NOTE: some networks (e.g. SafeBrowse/OpenDNS-style filters) block *-ngrok URLs locally,
  so you may not be able to open this URL from this PC's browser. TradingView's cloud is
  NOT behind your filter, so alert fires still arrive. Verify from a phone on cellular data.

  Ctrl-C to stop the tunnel.
EOF

wait $NGROK_PID
