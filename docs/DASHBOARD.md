# Alert Dashboard

A local, zero-dependency web UI for **macro control of TradingView price/indicator alerts** —
enable/disable/add alerts by symbol × type × tab, save the current state to a config file, and
watch recent fires. It reads and drives your live alerts through CDP (the same connection the
`tv` CLI uses), so TradingView Desktop must be running with `--remote-debugging-port=9222`.

## Prerequisites

- **Node.js 18+**.
- **TradingView Desktop running with CDP reachable** (port 9222) — same requirement as any `tv`
  command. See [Windows/WSL2 setup](WINDOWS_WSL2_SETUP.md).

## Run it

```bash
node scripts/dashboard.js --port=8787
# then open http://127.0.0.1:8787
```

- Binds to **`127.0.0.1` only** (local-only by design). Override host with `DASH_HOST`, port with
  `--port=` or `PORT`.
- The HTML/CSS is served fresh on every request, so UI tweaks need no restart. Changes to the
  **server** JS (`scripts/dashboard.js`) do require a restart.

## The grid

The main view is a matrix of **alerts you already have**:

- **Rows = symbols**, grouped by the chart tab they appear on (each tab shows its symbol list).
- **Columns = alert types** — templates (PDH/PDL, VWAP, traps, …) and cross conditions. Cross
  types are split by direction with arrows (↑ up / ↓ down / ↕ plain cross).
- **Cell** = the alert for that symbol+type:
  - click a **filled** cell to toggle it **enabled/disabled**;
  - click an **empty** cell to **create** that alert for the symbol (directional for cross types).
- **Per-column** enable/disable and **per-tab** (row-group) enable/disable buttons sit next to the
  headers, so you can flip a whole type or a whole tab at once.
- A **busy indicator** shows while an update is in flight (alert changes take a moment to settle).

### Header actions

| Button | What it does |
|--------|--------------|
| Refresh | re-read live alert state |
| Enable all | re-enable every alert |
| Disable all | pause every alert |
| 🔗 Webhook all | recreate every alert with the webhook URL stamped on it (for fire push — see below) |
| 💾 Save to config | write the current alert set to `alerts_config.json` (gitignored) |

## "Recently fired" panel

Shows alerts that have fired, newest first. Two sources, automatically:

- **Polled (default):** reads each alert's `last_fire_time` from `list_alerts` every 15s — works
  with **no** webhook setup at all.
- **🟢 Live via webhook:** if fires are being POSTed to the dashboard (see below), it shows the
  live feed with resolved ticker/price, and survives restarts (hydrates from the log file).

## Receiving fires (optional — needs a tunnel)

TradingView fires webhooks from **its cloud**, and only accepts **public https/http URLs on ports
80/443** — it rejects `localhost`. To push fires into the dashboard you expose it through a tunnel
(ngrok/cloudflared) and set `WEBHOOK_URL`. Full runbook — incl. `scripts/tunnel.sh`, the
`WEBHOOK_SECRET` path guard, and the SafeBrowse local-filter gotcha — is in
[WEBHOOK_TUNNEL.md](WEBHOOK_TUNNEL.md). Short version:

```bash
WEBHOOK_SECRET=<secret> WEBHOOK_URL='https://<you>.ngrok-free.app/webhook/<secret>' \
  node scripts/dashboard.js --port=8787
# then click "🔗 Webhook all"
```

Without a tunnel, the polling "Recently fired" panel still works — you just don't get instant push.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `--port=` / `PORT` | `8787` | listen port |
| `DASH_HOST` | `127.0.0.1` | listen host (keep local unless you know why) |
| `WEBHOOK_SECRET` | — | adds an unguessable `/webhook/<secret>` path (403 without it) |
| `WEBHOOK_URL` | `http://localhost:PORT/webhook[/secret]` | URL stamped onto alerts by "Webhook all" |

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | the dashboard SPA |
| GET | `/api/state` | live alert matrix (symbols × types × tabs) |
| GET | `/api/fired` | recently fired (live webhook feed, else `last_fire_time` poll) |
| GET | `/api/webhook` | recent in-memory webhook fires |
| GET | `/webhook.log` | raw `logs/webhook_alerts.jsonl` |
| POST | `/api/toggle` | enable/disable matched alerts |
| POST | `/api/create` | create alert(s) for symbol(s) |
| POST | `/api/delete` | delete alerts by id |
| POST | `/api/save` | write `alerts_config.json` |
| POST | `/api/webhookify` | recreate all alerts with the webhook URL (accepts `defaults` to mute, e.g. `{popup:false,sound_duration:0}`) |
| POST | `/webhook` or `/webhook/<secret>` | receive a TradingView fire (logged) |

## Related tooling

- `scripts/quiet_alerts.mjs` — bulk-recreate alerts muted / rate-limited (reuses the dashboard's
  payload builder).
- `docs/ALERT_INJECTION.md` — the underlying pricealerts REST API (payload shapes, the
  no-Content-Type CORS trick, frequency/resolution notes).
