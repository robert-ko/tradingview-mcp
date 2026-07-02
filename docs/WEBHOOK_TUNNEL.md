# Receiving TradingView webhook fires locally (ngrok tunnel)

## The problem

The dashboard has a `/webhook` receiver, but TradingView **won't POST to `localhost`**.
Two hard constraints from TradingView:

1. **Fires originate in TradingView's cloud**, not the desktop app. So the target URL must
   be reachable from the public internet — `localhost` / `127.0.0.1` / LAN IPs are rejected
   ("URL not allowed").
2. **Only ports 80 and 443** are accepted.

A tunnel (ngrok or cloudflared) solves both: it gives a public `https://…` URL (TLS on 443)
that forwards down to the dashboard on `127.0.0.1:8787`.

```
TradingView cloud ──POST──▶ https://<you>.ngrok-free.app/webhook/<secret>
                             │ (ngrok edge, :443)
                             ▼  tunnel
                           ngrok agent ──▶ 127.0.0.1:8787 /webhook/<secret>  (dashboard)
```

> You do **not** need robswc/tradingview-webhooks-bot. That's a separate Flask receiver;
> the dashboard already receives + logs fires. The tunnel just exposes it.

## One-time setup

1. **Install ngrok** (WSL2/Linux): download from https://ngrok.com/download, or:
   ```bash
   mkdir -p ~/.local/bin
   curl -sSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar xz -C ~/.local/bin
   ```
2. **Add your authtoken** (from https://dashboard.ngrok.com/get-started/your-authtoken):
   ```bash
   ngrok config add-authtoken <TOKEN>
   ```
   Stored in `~/.config/ngrok/ngrok.yml` — **not** in this repo, never commit it.
3. **(Recommended) claim your free static domain** at
   https://dashboard.ngrok.com/domains. The free plan includes **one** — it gives a URL that
   survives restarts, so you set the alert webhooks once instead of after every restart.

## Run it

```bash
# 1. start the dashboard with a secret path segment (guards the public /webhook)
WEBHOOK_SECRET=pick-something-random node scripts/dashboard.js --port=8787

# 2. open the tunnel (in another shell)
WEBHOOK_SECRET=pick-something-random NGROK_DOMAIN=<you>.ngrok-free.app ./scripts/tunnel.sh
#   (omit NGROK_DOMAIN for a random ephemeral URL)
```

`tunnel.sh` prints the public URL and the exact webhook URL, e.g.
`https://<you>.ngrok-free.app/webhook/pick-something-random`.

Then point the alerts at it and click **🔗 Webhook all** in the dashboard (or `POST /api/webhookify`):

```bash
WEBHOOK_URL='https://<you>.ngrok-free.app/webhook/pick-something-random' \
WEBHOOK_SECRET=pick-something-random node scripts/dashboard.js --port=8787
```

`buildPayload()` reads `WEBHOOK_URL` and stamps it onto every (re)created alert's `web_hook`.

## The SafeBrowse / local-filter gotcha

This machine's network runs **SafeBrowse** content filtering (an HTTP request to any
ngrok URL 302-redirects to `safebrowse.io/warn.html`, and HTTPS handshakes are mangled →
`WRONG_VERSION_NUMBER`). This is **client-side** — it filters requests *leaving your network*.

Consequences:
- You **cannot** open/curl the ngrok URL from this PC (or its browser) — it's blocked here.
- **TradingView's cloud is not behind your filter**, so alert fires still arrive at the tunnel.

**How to verify** (bypass the local filter):
- From a **phone on cellular data** (not your Wi-Fi), open the public URL — you should get
  the ngrok interstitial then the dashboard, proving the tunnel is publicly reachable.
- Or just create/point one real alert and wait for (or force) a fire; watch the dashboard
  console + `logs/webhook_alerts.jsonl` + `GET /webhook.log`. A fire landing there is proof.
- To un-break local testing, exempt `*.ngrok-free.app` / `*.ngrok-free.dev` / `*.ngrok.io`
  in the SafeBrowse allowlist, or point the machine at unfiltered DNS.

## Do you even need the tunnel?

The dashboard's **"Recently fired"** panel already works **without** any webhook — it polls
each alert's `last_fire_time` from `list_alerts` every 15s (`GET /api/fired`). That's the
robust default and needs no public URL. The webhook/tunnel adds **near-instant push** fires
(and the raw payload), which the polling panel can't give you between polls.

## cloudflared alternative (no signup)

```bash
cloudflared tunnel --url http://localhost:8787
```
Prints a random `https://…trycloudflare.com` URL. No account needed, no interstitial; the
URL is random per run unless you bind a domain you own.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/webhook` or `/webhook/<secret>` | receive a TradingView fire (403 if secret set and missing) |
| GET  | `/webhook.log` | raw `logs/webhook_alerts.jsonl` |
| GET  | `/api/webhook` | recent in-memory fires (JSON) |
| GET  | `/api/fired` | fired alerts by `last_fire_time` (polling fallback) |
