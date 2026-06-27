# Alert Injection — capture & replay TradingView alerts

How to create alerts programmatically — especially **indicator-condition** alerts
(e.g. "price crosses VWAP") — and fan a single hand-made alert out across many
symbols. The TradingView UI is the only sane way to *author* a complex condition;
the `pricealerts` REST API is the only sane way to *replicate* it.

Utility: **`scripts/alert_inject.mjs`** (`arm` / `show` / `replay`).

```bash
node scripts/alert_inject.mjs arm                      # hook fetch/XHR on all chart tabs
#   ... create ONE alert in the TradingView UI (any condition) ...
node scripts/alert_inject.mjs show                     # inspect captured create_alert payloads
node scripts/alert_inject.mjs replay NYSE:IONQ NASDAQ:RGTI NYSE:QBTS   # fan it out
#   replay --index=N to pick a specific capture (default: last)
```

---

## The pricealerts REST API

Base: `https://pricealerts.tradingview.com`. All calls use `credentials: 'include'`
(rides the logged-in TradingView session). The UI appends query params
(`?log_username=…&maintenance_unset_reason=initial_operated&build_time=…`) — these
are **not required**.

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/list_alerts` | GET | — | `{s:'ok', r:[{alert_id, symbol, active, message, condition, resolution, …}]}` |
| `/create_alert` | POST | `{"payload":{…}}` (see below) | `{s:'ok', id, r:{…created alert…}}` |
| `/delete_alerts` | POST | `{"payload":{"alert_ids":[…]}}` | `{s:'ok'}` |
| `/stop_alerts` | POST | `{"payload":{"alert_ids":[…]}}` | pause/disable (active→false) |
| `/restart_alerts` | POST | `{"payload":{"alert_ids":[…]}}` | re-enable (active→true) |
| `/modify_restart_alert` | POST | a full create payload **+ `"alert_id": <id>`** (+ optional `client_id`) | **edit in place** + restart |

> There is **no** `modify_alert` endpoint (it 404s); the UI tries it, then falls back to
> `modify_restart_alert`. So editing = re-send the (modified) create payload with the
> existing `alert_id` added. CLI/tool wrappers exist for stop/restart:
> `tv alert disable|enable --ids 1,2,3` / MCP `alert_set_active`.

### ⚠️ The one trap: NO `Content-Type` header
`create_alert` and `delete_alerts` take a **JSON body**, but you must **not** set
`Content-Type: application/json`. The call is cross-origin (chart page
`tradingview.com` → `pricealerts.tradingview.com`), and a JSON content-type triggers
a **CORS preflight** the endpoint rejects → `TypeError: Failed to fetch`. Omitting the
header makes fetch default to `text/plain`, a CORS **"simple request"** (no preflight),
and the server parses the JSON anyway. (`application/x-www-form-urlencoded` reaches the
endpoint too but every form-field shape returns `invalid_request` — it wants the JSON
`payload` body.)

```js
fetch('https://pricealerts.tradingview.com/create_alert', {
  method: 'POST', credentials: 'include',
  body: JSON.stringify({ payload: {/* ... */} })   // <-- no headers
})
```

---

## create_alert payload shape

```jsonc
{ "payload": {
  "conditions": [{
    "type": "cross",                 // cross | greater | less | ...
    "frequency": "on_first_fire",    // or "once_per_bar", etc.
    "series": [ /* see "Conditions" */ ],
    "resolution": "10S"
  }],
  "symbol": "={\"adjustment\":\"dividends\",\"currency-id\":\"USD\",\"session\":\"extended\",\"symbol\":\"NASDAQ:QUBT\"}",
  "resolution": "10S",
  "message": "QUBT, 10s Crossing VWAP + Reclaim [rko] (Session, 1, 10, 30)",
  "expiration": "2026-06-30T20:00:00.000Z",
  "active": true,
  "ignore_warnings": true,
  "sound_file": "alert/chirpy", "sound_duration": 5,
  "popup": true, "mobile_push": true, "email": false, "web_hook": null, "name": null
}}
```

**`symbol`** is an `=`-prefixed JSON descriptor — to retarget, parse it, change
`.symbol`, re-stringify, re-prefix with `=`. **`message`** typically embeds the short
ticker, so swap that too when fanning out.

### Conditions — the `series` array encodes the comparison
`type` (`cross`, etc.) is applied between the items in `series`:

| Item | Meaning |
|---|---|
| `{"type":"barset"}` | the chart's **price** (OHLC bars) |
| `{"type":"value","value":N}` | a **constant** level (symbol-specific!) |
| `{"type":"study","study":"Script@tv-scripting-101","plot_id":"plot_0","offsets_by_plot":{"plot_0":0},"inputs":{…},"pine_id":"USER;<id>","pine_version":"<v>"}` | an **indicator plot** |

Therefore:
- **"price crosses VWAP"** → `series: [{barset}, {study plot_0}]` — **no per-symbol value, generalizes cleanly** (this is what we used for the quantum stocks).
- **"indicator plot crosses level X"** → `series: [{study plot_0}, {value:X}]` — `X` is symbol-specific, so it does **not** generalize; replaying needs a per-symbol level.

The `study` object (pine_id, inputs) is identical across panes when the same
indicator instance is applied, so indicator-based conditions port between symbols.

### Condition `type` values
`cross` (either direction), `cross_up`, `cross_down` (directional), `greater`, `less`,
plus **`alert_cond`** for Pine `alertcondition()`-based alerts.

### Pine `alertcondition()` alerts (e.g. PDH/PDL, "Buyers/Sellers Trapped")
These don't compare two series — they fire a named condition baked into the script:
```jsonc
{ "type":"alert_cond", "frequency":"on_first_fire",
  "alert_cond_id":"plot_0",                       // which alertcondition (plot_0, plot_1, ... plot_8 ...)
  "series":[{ "type":"study", "study":"Script@tv-scripting-101", "inputs":{…}, "pine_id":"USER;<id>", "pine_version":"…" }],
  "resolution":"10S" }
```
Their `message` typically uses `{{ticker}}` / `{{close}}` placeholders, so they **generalize
to any symbol with no edit** — replay just swaps `payload.symbol`. (Known `[rko]` indicators:
PDH/PDL/PWH/PWL/PMH/PML = `pine_id USER;c1bc6a00…`, each level a different `alert_cond_id`;
Bubbles "Buyers/Sellers Trapped" = `pine_id USER;44900fec…`.)

### Built-in EMA crossing (no capture needed)
"price crosses EMA(N)" uses the **built-in** EMA study `pine_id:"STD;EMA"` — fully constructable:
```jsonc
{ "type":"cross_down",                            // or cross_up / cross
  "series":[ {"type":"barset"},                   // price
             {"type":"study","study":"Script@tv-scripting-101","plot_id":"plot_0",
              "pine_id":"STD;EMA","pine_version":"30.0",
              "inputs":{"in_0":89,"in_1":"close","in_2":0,"in_3":"SMA","in_4":5,"in_5":"","in_6":true,
                        "pineFeatures":"{\"indicator\":1,\"plot\":1,\"ta\":1}","__profile":false}} ],
  "resolution":"10S" }
```
`in_0` = length, `in_1` = source. EMA-crosses-EMA = two `STD;EMA` studies in `series`.

---

## Replay = clone + swap
For each target `EXCHANGE:SYMBOL`: deep-clone the captured `payload`, set the symbol
descriptor's `.symbol`, regenerate `message` (replace old short ticker with new), POST
to `/create_alert` (no Content-Type), check for `{"s":"ok"}`. `alert_inject.mjs replay`
does exactly this. Verify with `/list_alerts`.

## Gotchas
- The capture hook lives in the page **until you reload/restart** TradingView. Re-`arm` after a reload.
- `arm` injects into **every** chart tab, so it captures the alert wherever you create it.
- Prefer "price crosses indicator" style conditions for fan-out (no per-symbol value).
  For "plot crosses value", you must supply each symbol's level.
- Selective/bulk **deletion** uses the same API + no-Content-Type trick — see
  `tv alert delete --ids|--inactive|--all` (`src/core/alerts.js`).

---

## Batch creation from a JSON config — `scripts/batch_alerts.py`

Define the alerts you want in JSON and create them all in one run (pure Python:
`requests` + `websocket-client`, talks to a chart page over CDP):

```bash
python scripts/batch_alerts.py my_alerts.json --dry-run   # preview, no side effects
python scripts/batch_alerts.py my_alerts.json             # create
```

Each entry has `symbols: ["EXCHANGE:SYM", …]` and ONE condition:

| Condition | Spec | Notes |
|---|---|---|
| `template` | `"pdh"` (etc.) | named capture from `scripts/alert_templates.json`; alert_cond, `{{ticker}}` portable |
| `ema_cross` | `{length, source, direction}` | price × EMA(N) (built-in `STD;EMA`) |
| `ema_cross_ema` | `{fast, slow, source, direction}` | EMA × EMA |
| `vwap_cross` | `{direction}` | price × VWAP+Reclaim (`pine_id USER;650815…`) |
| `price_cross_value` | `{value, direction}` | price × fixed level (symbol-specific) |

`direction` ∈ `up`/`down`/`cross`. Per-entry overrides: `message` (use `{sym}`), `resolution`,
`expiration_days`. Templates live in `scripts/alert_templates.json` (captured via `alert_inject.mjs`);
re-capture + re-run `_tmp_save_templates` style extraction to refresh/add indicators.
See `scripts/alerts.example.json`.
