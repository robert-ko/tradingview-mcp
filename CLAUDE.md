# TradingView MCP — Claude Instructions

68 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## CLI Quick Reference (`tv` command)

The `tv` CLI mirrors the MCP tools for direct terminal use.

**Setup** (WSL2 / Linux — `npm link` requires sudo):
```bash
source scripts/setup_env.sh        # set alias for current shell
# or permanently:
echo "source $(pwd)/scripts/setup_env.sh" >> ~/.bashrc
```

### Inspect all windows/tabs
```bash
tv tab windows          # JSON: all windows, tabs, panes, symbols
tv tab windows --table  # Human-readable aligned table (-t short flag)
```

### Query any pane on any tab without switching focus
All data commands accept `--chart <layout_id>` and `--pane <index>` flags:
```bash
tv quote --chart OrGYLj5W --pane 0        # price of pane 0 on tab OrGYLj5W
tv quote IBIT --chart OrGYLj5W --pane 1   # override symbol on specific pane
tv data lines --chart OrGYLj5W --pane 2   # Pine lines from background tab
tv data labels --chart OrGYLj5W           # labels from any tab, active pane
```
Chart layout IDs come from `tv tab list` or `tv tab windows` output.

### Tab management
```bash
tv tab list             # list open chart tabs with IDs
tv tab switch 2         # switch to tab by index
tv tab new              # open new tab (Ctrl+T)
tv tab close            # close current tab (Ctrl+W)
```

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol
4. `tab_windows` → all open windows/tabs with pane symbols (use when multiple charts are open)

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

All four tools accept optional `chart_id` and `pane_index` to query a **background tab** without switching focus.

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view all alerts (each has `active` true/false; inactive = triggered/disabled)
- `alert_delete` → remove alerts: `alert_ids: [...]` (specific), `delete_inactive: true` (clear triggered/disabled, keep active), or `delete_all: true`. Deletes via the pricealerts REST API in chunks of 100. CLI: `tv alert delete --ids 1,2,3` / `--inactive` / `--all`.
- `alert_set_active` → pause/re-enable existing alerts: `alert_ids: [...]`, `active: true|false` (stop_alerts/restart_alerts). CLI: `tv alert disable --ids 1,2,3` / `tv alert enable --ids 1,2,3`.
- **Indicator-condition alerts (e.g. "price crosses VWAP") across many symbols**: `alert_create` only does price alerts. To author a complex condition once in the UI and fan it out, use `scripts/alert_inject.mjs` (`arm` → create one in the UI → `show` → `replay EXCHANGE:SYM ...`). **Editing** an alert = re-send the create payload with the existing `alert_id` to `modify_restart_alert` (there's no `modify_alert`). Full API notes (no-Content-Type CORS trick, payload/series shapes, all endpoints): `docs/ALERT_INJECTION.md`.

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

**WSL2 note**: `connection.js` auto-detects the right host when running inside WSL2 (`WSL_DISTRO_NAME` is set): it probes loopback first (works under **mirrored networking**, which shares `127.0.0.1` with Windows) and falls back to the Windows gateway IP from `ip route show default` (**NAT networking**). Set `CDP_HOST` to override. For **NAT mode** a Windows `netsh interface portproxy` must forward `<WSL-adapter-IP>:9222 -> 127.0.0.1:9222` — bound to the **specific WSL adapter IP, never `0.0.0.0`** (a `0.0.0.0` bind shadows/overlaps Electron's loopback and CDP silently fails → `fetch failed`).

**Launching on Windows**: TradingView is usually an **MSIX/Store install** (locked `WindowsApps` path) — launch it with `scripts/launch_msix_debug.ps1` (COM `IApplicationActivationManager`; the `.bat` and `explorer shell:`/`ELECTRON_EXTRA_LAUNCH_ARGS` tricks can't reliably pass `--remote-debugging-port`). The `.ps1` auto-detects NAT vs mirrored and sets up the proxy correctly. Full runbook + failure modes: `docs/WINDOWS_WSL2_SETUP.md`.

**Multi-tab / multi-pane access**: `evaluateInTarget(targetId, expr)` opens a fresh CDP connection to any renderer target, evaluates JS, and closes — enabling reads from background tabs without switching focus. `resolveRenderer(chartId)` finds the live renderer for a given layout ID. Pane-specific reads use `window.TradingViewApi._chartWidgetCollection.getAll()[paneIndex]` instead of `_activeChartWidgetWV`.

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`

## Agent Memory & Local Automation

**Persistent cross-session memory** (Claude Code auto-loads its index each session, but the full notes are worth reading when working on setup/automation):
`/home/robert/.claude/projects/-mnt-c-Users-Robert-Dropbox-Projects-tradingview-mcp/memory/` — start at `MEMORY.md` (the index). Covers: WSL2/MSIX CDP launch & portproxy fixes, placing trade-plotter indicators on specific panes (incl. the `Ctrl+K Ctrl+I` editor-unbind trick), and the after-market plot cron.

**Local automation** (lives in `scripts/`, environment-specific, not core app code):
- `scripts/plot_today_trades.mjs` + `scripts/afterhours_plot.sh` — after-market job: runs the trade_plotter generator, then plots today's indicators onto the matching chart panes (add-to-chart, no cloud save). Cron: `0 16 * * 1-5` (16:00 CDT). **Run log: `logs/afterhours_plot.log`** (gitignored).
- `scripts/launch_msix_debug.ps1` — launch the MSIX TradingView build with CDP; see `docs/WINDOWS_WSL2_SETUP.md`.
- A Windows logon task keeps WSL running so the cron fires (`scripts/keep_wsl_alive.vbs`).
