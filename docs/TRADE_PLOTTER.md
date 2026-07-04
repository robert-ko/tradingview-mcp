# Trade-Plotter Automation

After-market job that plots each day's fills onto the quantum chart panes. It generates a per-symbol
Pine indicator from your trade log, then **overwrites the saved `<SYM> Trades Plotter` cloud script
in place** so the on-chart study shows today's trades.

```
SuccessTrader log ──▶ trade_indicator_generator.py ──▶ <sym>_trades_indicator.pine
                                                              │
plot_today_trades.mjs ── detects today's (re)written files ──┘
   └─▶ for each symbol: overwrite saved "<SYM> Trades Plotter" via pine-facade REST (in place)
   └─▶ (optional --reload) remove + re-add the on-chart study so the pane refreshes
```

## How a run works

1. **Generate** — runs `trade_indicator_generator.py --log` in `TRADE_PLOTTER_DIR`. It parses the
   latest SuccessTrader log and writes `<sym>_trades_indicator.pine` for every symbol traded today.
2. **Detect** — the files whose mtime ≥ run start = **today's traded symbols**. No files ⇒ no trades
   ⇒ the job exits cleanly (does nothing).
3. **Overwrite** — for each symbol, resolve the saved `<SYM> Trades Plotter` `scriptIdPart` from
   `listScripts()`, then POST today's source to the pine-facade save endpoint (see below). Runs
   inside a TradingView page so the session cookie authenticates. In place, one script, no duplicate.
4. **(optional) Reload** — with `--reload`, find the pane showing the symbol, remove the existing
   `<SYM> Trades` study, and re-add it via **Indicators → My scripts** so the pane picks up the new
   version. Without `--reload` the saved script is still updated; existing studies just keep the
   version they were added with until re-added.

## The overwrite mechanism (why this is the reliable way)

```
POST https://pine-facade.tradingview.com/pine-facade/save/next/{scriptId}?allow_create_new=false&name={name}
body: multipart FormData { source: <pine> }        credentials: 'include'
```

- `scriptId` includes the `USER;` prefix (URL-encode it). `allow_create_new=false` ⇒ overwrite in
  place, never a `… 1` duplicate. Only `source` is needed — no compiled metadata.
- **Do not use the Pine editor path.** History (don't regress):
  - **v1** clicked "Add to chart" of the *unsaved* editor script → this TradingView build silently
    added the blank default template `indicator("My script")/plot(close)` instead of the trades, so
    charts showed no update; the save-name dialog also spawned `<SYM> Trades Plotter 1` duplicates.
  - **v2** used the editor's `Ctrl+S` save → a **no-op** unless the editor is *focused AND bound* to
    that exact script; `monaco.setValue` doesn't mark the doc dirty, so nothing was written (verified:
    the cloud stayed at the old version, zero write requests captured). There are also multiple Monaco
    instances and `getClient` isn't the quantum renderer — more ways to hit the wrong editor.
  - **v3 (current)** is the REST call above — renderer-independent, no editor. Verified in place.

## One-time per symbol: bind the study to its pane

The cron overwrites the **saved script**, but a study has to be on the chart to display it. Add each
`<SYM> Trades Plotter` **once** to its pane via **Indicators → My scripts → "<SYM> Trades Plotter"**
(the editor "Add to chart" is unreliable here). After that it's bound to the saved script; daily runs
overwrite the script and the pane refreshes (instantly with `--reload`, otherwise on next re-add).

Quantum panes: `0` QUBT · `1` IONQ · `2` RGTI · `3` QBTS (spreads on 4/5 have no plotter).

## Run it

```bash
node scripts/plot_today_trades.mjs             # generate + overwrite saved scripts
node scripts/plot_today_trades.mjs --reload    # also refresh the on-chart studies
```

Requires TradingView reachable over CDP (see [HANDOFF.md](HANDOFF.md) §2). If CDP is down the job
logs a clear error and exits 1 (nothing is corrupted).

## Cron / scheduling

- `scripts/afterhours_plot.sh` — cron wrapper: sets PATH, logs to `logs/afterhours_plot.log`
  (gitignored, trimmed).
- Crontab: `0 16 * * 1-5` (16:00 America/Chicago, weekdays).
- `scripts/keep_wsl_alive.vbs` in the Windows Startup folder keeps WSL running so cron fires
  (systemd starts cron); it needs an interactive logon (the machine must be on + logged in — which it
  is anyway for TradingView).

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `TRADE_PLOTTER_DIR` | `…/tradingview-trade_plotter` | where the generator + `<sym>_trades_indicator.pine` live |
| `SUCCESSTRADER_LOG_DIR` | `/mnt/c/SuccessTrader Pro_x64/LOG` | trade log source for the generator |
| `PYTHON` | venv path (`…/pyenvs/tv_env/bin/python3`) | interpreter with **pandas** (cron's `/usr/bin/python3` lacks it) |

> **New machine:** update all three for that machine's paths. The generator lives in a *separate*
> repo/dir (`TRADE_PLOTTER_DIR`), not this one.

## Maintenance — remove duplicate scripts

If old `<SYM> Trades Plotter N` duplicates exist (from the v1 dialog-save days), delete them:

```
POST https://pine-facade.tradingview.com/pine-facade/delete/{scriptId}   (credentials: 'include')
```

(Run from a TradingView page. `/pine-facade/remove/{id}` is 404 — use `/delete/`.) List saved scripts
with `listScripts()` / `tv pine list` to find `… 1`/`… 2` names whose base also exists.

## See also

- [HANDOFF.md](HANDOFF.md) — new-machine setup (CDP, quantum tabs, dashboard).
- [WINDOWS_WSL2_SETUP.md](WINDOWS_WSL2_SETUP.md) — CDP launch + WSL2 networking.
- Memory: `aftermarket-plot-cron`, `pine-facade-save-endpoint`, `trade-plotter-add-to-pane`.
