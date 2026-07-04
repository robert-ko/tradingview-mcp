# Handoff — setting up TradingView MCP on a new machine

End-to-end runbook to bring this repo up on another computer: environment checks, the patches
that make CDP actually work, locating/arranging the quantum chart tabs, and starting the alert
dashboard. Deep-dive docs are linked where relevant — this is the "do these in order" guide.

---

## 0. What you're setting up

- **TradingView MCP** — reads/controls a live **TradingView Desktop** chart over the Chrome
  DevTools Protocol (CDP, port 9222). The `tv` CLI and the MCP server both use that connection.
- **Trade-plotter automation** — an after-market cron that plots the day's fills onto the quantum
  chart panes by overwriting saved Pine scripts.
- **Alert dashboard** — a local web UI for macro control of alerts.

Everything talks to CDP on `localhost:9222`. If that's not reachable, *nothing* works and every
command returns `fetch failed`.

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | CLI + MCP server are Node/ESM; `node -v`. |
| **TradingView Desktop** | Signed in to the **same account** (chart layouts + saved Pine scripts are cloud-synced). Usually an **MSIX / Microsoft Store** install on Windows. |
| **Git + repo clone** | `git clone` this repo; `npm install`. |
| **(WSL2 users) a working WSL2 distro** | systemd on, and able to reach the Windows host. |
| **Python venv w/ pandas** | only for the trade-plotter generator (see §6). |

```bash
git clone <repo> tradingview-mcp && cd tradingview-mcp
npm install
```

---

## 2. Launch TradingView with CDP (the part that bites everyone)

TradingView must run with `--remote-debugging-port=9222`. On Windows MSIX you **cannot** just pass
that flag — the `.exe` is in a locked `WindowsApps` path and `explorer shell:` /
`ELECTRON_EXTRA_LAUNCH_ARGS` tricks silently drop the flag. Use the provided launcher:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\launch_msix_debug.ps1
```

It uses the COM `IApplicationActivationManager` to launch with the flag, auto-detects NAT vs
mirrored networking, and sets up the proxy correctly. Full detail + failure table:
**[docs/WINDOWS_WSL2_SETUP.md](WINDOWS_WSL2_SETUP.md)**.

### WSL2 networking — the two "fetch failed" traps (patches)

`src/connection.js` auto-resolves the CDP host from WSL2: it probes loopback first (works under
**mirrored** networking) and falls back to the Windows gateway IP (**NAT**). Override with
`CDP_HOST`. The gotchas:

1. **NAT mode needs a `netsh portproxy`** forwarding `<WSL-adapter-IP>:9222 → 127.0.0.1:9222`,
   bound to the **specific WSL adapter IP — never `0.0.0.0`**. A `0.0.0.0` bind shadows/overlaps
   Electron's loopback and CDP silently fails. `launch_msix_debug.ps1` does this in the right order.
2. **Recommended permanent fix: mirrored networking** (`.wslconfig` → `networkingMode=mirrored`),
   which shares `127.0.0.1` with Windows — no portproxy, no reboot IP-drift. Then
   `export CDP_HOST=127.0.0.1`. Launch with `launch_msix_debug.ps1 -NoProxy`.

Manual recovery commands and a full troubleshooting table are in
[docs/WINDOWS_WSL2_SETUP.md](WINDOWS_WSL2_SETUP.md).

> **Cron caveat:** under cron's minimal env `WSL_DISTRO_NAME` is unset, so `connection.js` detects
> WSL via `/proc/version` instead — this is already patched in the repo; don't regress it.

---

## 3. Make the `tv` CLI resolve

Pick one (for scripts/agents, calling `node src/cli/index.js` directly is most reliable — no
alias/PATH assumptions):

```bash
source scripts/setup_env.sh          # sets a `tv` alias for the current shell
# or permanent: echo "source $(pwd)/scripts/setup_env.sh" >> ~/.bashrc
# or npm link (needs sudo on WSL/Linux):  sudo npm link
# or just:  node src/cli/index.js <args>
```

---

## 4. Verify the setup

```bash
node src/cli/index.js status          # cdp_connected: true  (else see §2)
node src/cli/index.js tab windows -t   # human table of all windows/tabs/panes/symbols
```

If `status` shows `fetch failed`: TradingView isn't running with CDP, or the WSL2 host/proxy is
wrong → back to §2. `node src/cli/index.js tv_health_check` (or MCP `tv_health_check`) also works.

---

## 5. Locate / arrange the quantum chart tabs

Chart **layouts and saved Pine scripts are account-synced**, so after signing in on the new machine
the quantum layout and the `<SYM> Trades Plotter` scripts are already in the account — you just open
and arrange them.

1. **Open the saved layout** — the quantum multi-chart layout (named **"Quantum Panel"** in the UI).
   `node src/cli/index.js layout list` to see saved layouts, `layout switch "Quantum Panel"` to load.
2. **Find its chart id** — `tv tab windows -t` or `tv tab list`. Note the `chart_id` (was
   `7Nyb38Km` on the origin machine; **it may differ per account/layout — always re-read it**, don't
   hardcode). Scripts take `--chart <id>` / `--pane <index>`.
3. **Pane layout** (6 panes): `0` QUBT · `1` IONQ · `2` RGTI · `3` QBTS · `4` `2*QUBT-RGTI` spread ·
   `5` `IONQ-2*QBTS` spread. Confirm with `tv pane list` / `tv tab windows`.
4. **Trade plotters bind to the single-symbol panes (0–3).** Each `<SYM> Trades Plotter` study must
   be **added once** to its pane via **Indicators → My scripts → "<SYM> Trades Plotter"** (the
   editor "Add to chart" path is unreliable in this build). After that, the cron just overwrites the
   saved script and the pane refreshes on re-add.
5. **Multi-window caveat:** a layout can be open in **several windows/tabs at once** (the automation
   resolves the *first* renderer for a chart id). Keep the quantum layout in **one** window to avoid
   the "edits land in a background window" confusion. Use `tv tab windows` to spot duplicates.

> Entity/study IDs from `chart_get_state` are **session-specific** — never cache them across
> sessions or machines. Layout ids and saved-script ids are stable per account.

---

## 6. Trade-plotter automation (optional)

Daily after-market job: generate the day's indicators, then overwrite each saved
`<SYM> Trades Plotter` in place via the pine-facade REST endpoint (renderer-independent, no editor,
no duplicates).

- **Generator needs pandas** — only in the venv. Pin it:
  `PYTHON=/path/to/pyenvs/tv_env/bin/python3` (default in the script points at the origin path;
  **update this env for the new machine**).
- Run: `node scripts/plot_today_trades.mjs` (add `--reload` to also refresh on-chart studies).
- Cron: `0 16 * * 1-5` (16:00 America/Chicago) via `scripts/afterhours_plot.sh`; run log
  `logs/afterhours_plot.log`.
- Keep WSL alive so cron fires: `scripts/keep_wsl_alive.vbs` in the Windows Startup folder.
- Full mechanism + why v1/v2 failed: `docs/` + memory `aftermarket-plot-cron` /
  `pine-facade-save-endpoint`.

Env overrides: `TRADE_PLOTTER_DIR`, `SUCCESSTRADER_LOG_DIR`, `PYTHON`.

---

## 7. Start the alert dashboard

```bash
node scripts/dashboard.js --port=8787          # then open http://127.0.0.1:8787
```

- Binds `127.0.0.1` only. Grid to enable/disable/add alerts by symbol × type × tab, "Recently
  fired" panel, save state to `alerts_config.json`.
- To receive webhook fires (optional), you need a **public tunnel** — TradingView fires from its
  cloud and rejects `localhost`, accepting only public https/http on ports 80/443:
  ```bash
  WEBHOOK_SECRET=<secret> WEBHOOK_URL='https://<you>.ngrok-free.app/webhook/<secret>' \
    node scripts/dashboard.js --port=8787
  # then click "🔗 Webhook all"
  ```
- Full guide: **[docs/DASHBOARD.md](DASHBOARD.md)**; tunnel/ngrok + the SafeBrowse local-filter
  gotcha: **[docs/WEBHOOK_TUNNEL.md](WEBHOOK_TUNNEL.md)**.

---

## 8. New-machine checklist

- [ ] Node 18+ installed
- [ ] Repo cloned, `npm install`
- [ ] Signed into TradingView Desktop (same account) → layouts + Pine scripts synced
- [ ] Launched TradingView with CDP via `launch_msix_debug.ps1`
- [ ] (WSL2) `node src/cli/index.js status` → `cdp_connected: true` (fix networking per §2 if not)
- [ ] `tv` resolves (`setup_env.sh` / `npm link` / direct node)
- [ ] "Quantum Panel" layout open; chart id + panes confirmed via `tv tab windows`
- [ ] Each `<SYM> Trades Plotter` added once to its pane (Indicators → My scripts)
- [ ] `PYTHON` / `TRADE_PLOTTER_DIR` / `SUCCESSTRADER_LOG_DIR` updated for this machine (if using the cron)
- [ ] Cron + `keep_wsl_alive.vbs` installed (if using the after-market job)
- [ ] Dashboard starts and loads at `http://127.0.0.1:8787`

---

## 9. Reference — key files & docs

| Path | Purpose |
|------|---------|
| `scripts/launch_msix_debug.ps1` | launch MSIX TradingView with CDP + set up proxy |
| `scripts/setup_env.sh` | `tv` alias |
| `scripts/plot_today_trades.mjs` | after-market trade-plotter job (REST overwrite) |
| `scripts/afterhours_plot.sh` | cron wrapper + log |
| `scripts/keep_wsl_alive.vbs` | keep WSL running for cron (Windows Startup) |
| `scripts/dashboard.js` | alert dashboard server |
| `scripts/tunnel.sh` | ngrok tunnel for webhook fires |
| `scripts/quiet_alerts.mjs` | bulk mute / rate-limit alerts |
| `docs/WINDOWS_WSL2_SETUP.md` | CDP launch + WSL2 networking (the "fetch failed" fixes) |
| `docs/DASHBOARD.md` | running the alert dashboard |
| `docs/WEBHOOK_TUNNEL.md` | exposing the dashboard for TV webhook fires |
| `docs/ALERT_INJECTION.md` | pricealerts REST API notes |

Cross-session memory (Claude Code) lives at
`~/.claude/projects/-mnt-c-Users-Robert-Dropbox-Projects-tradingview-mcp/memory/` — start at
`MEMORY.md`. Relevant notes: `wsl2-cdp-portproxy-fix`, `aftermarket-plot-cron`,
`pine-facade-save-endpoint`, `trade-plotter-add-to-pane`, `webhook-tunnel-ngrok`,
`alert-frequency-resolution`, `alert-delete-api`.
