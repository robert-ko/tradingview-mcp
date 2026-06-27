#!/usr/bin/env python3
"""
batch_alerts.py — batch-create TradingView alerts from a JSON config.

Reads a config of alerts you want, builds each create_alert payload (reusing the
captured indicator templates in scripts/alert_templates.json), and submits them
through a TradingView chart page over CDP (so they ride your logged-in session).

Usage:
    python scripts/batch_alerts.py <config.json> [--dry-run]
    CDP_HOST=127.0.0.1 python scripts/batch_alerts.py config.json   # force host (mirrored WSL)

Config shape (see scripts/alerts.example.json):
{
  "defaults": { "resolution": "10S", "expiration_days": 30,
                "popup": true, "mobile_push": true, "auto_deactivate": false },
  "alerts": [
    { "template": "pdh", "symbols": ["NASDAQ:QUBT", "NYSE:IONQ", "NASDAQ:RGTI", "NYSE:QBTS"] },
    { "template": "buyers_trapped", "symbols": ["NASDAQ:RGTI"] },
    { "ema_cross": { "length": 89, "source": "close", "direction": "down" }, "symbols": ["NYSE:IONQ"] }
  ]
}

Each alert entry needs `symbols` (EXCHANGE:SYMBOL list) and ONE of:
  - "template": a name from alert_templates.json
      (pdh pdl pwh pwl pmh pml buyers_trapped sellers_trapped ema)
  - "ema_cross":         { "length": N, "source": "close", "direction": "up|down|cross" }   # price x EMA
  - "ema_cross_ema":     { "fast": 9, "slow": 21, "source": "close", "direction": "up|down|cross" }
  - "vwap_cross":        { "direction": "up|down|cross" }                                   # price x VWAP+Reclaim
  - "price_cross_value": { "value": 12.5, "direction": "up|down|cross" }
Optional per-entry: "message" (use {sym} for the ticker), "resolution", "expiration_days".
"""
import sys, os, json, copy, subprocess, datetime
from pathlib import Path

import requests
from websocket import create_connection

HERE = Path(__file__).resolve().parent
TEMPLATES = json.loads((HERE / "alert_templates.json").read_text())
CREATE_URL = "https://pricealerts.tradingview.com/create_alert"
CROSS_TYPE = {"up": "cross_up", "down": "cross_down", "cross": "cross", "both": "cross"}


# ── CDP host resolution (mirrors src/connection.js) ──────────────────────────
def is_wsl():
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except Exception:
        return False

def wsl_gateway():
    try:
        out = subprocess.check_output(["ip", "route", "show", "default"], text=True)
        for tok in out.split():
            if tok.count(".") == 3:
                return tok
    except Exception:
        pass
    return None

def resolve_cdp():
    port = int(os.environ.get("CDP_PORT", "9222"))
    cands = []
    if os.environ.get("CDP_HOST"):
        cands = [os.environ["CDP_HOST"]]
    else:
        cands = ["127.0.0.1"]
        if is_wsl():
            gw = wsl_gateway()
            if gw:
                cands.append(gw)
        cands.append("localhost")
    for h in cands:
        try:
            requests.get(f"http://{h}:{port}/json/version", timeout=2)
            return h, port
        except Exception:
            continue
    sys.exit(f"ERROR: CDP not reachable on any of {cands}:{port} — is TradingView running with --remote-debugging-port?")


# ── CDP page session (one websocket, reused for all alerts) ──────────────────
class Page:
    def __init__(self, host, port):
        targets = requests.get(f"http://{host}:{port}/json/list", timeout=5).json()
        page = next((t for t in targets if t.get("type") == "page"
                     and "tradingview.com/chart" in (t.get("url") or "")), None)
        if not page:
            sys.exit("ERROR: no TradingView chart tab open.")
        # rewrite ws host to the one we can actually reach
        path = page["webSocketDebuggerUrl"].split("9222", 1)[-1] if "9222" in page["webSocketDebuggerUrl"] \
            else "/" + page["webSocketDebuggerUrl"].split("/", 3)[-1]
        self.ws = create_connection(f"ws://{host}:{port}{path}", timeout=20,
                                    suppress_origin=True, host=f"{host}:{port}")
        self._id = 0

    def evaluate(self, expr):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                                 "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    return {"err": msg["error"].get("message")}
                return msg.get("result", {}).get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


# ── payload building ─────────────────────────────────────────────────────────
def symbol_descriptor(full):
    return "=" + json.dumps({"adjustment": "dividends", "currency-id": "USD",
                             "session": "extended", "symbol": full})

def expiry(days):
    dt = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")

BARSET = {"type": "barset"}
# Your custom "VWAP + Reclaim [rko]" study object (captured), for vwap_cross.
VWAP_STUDY = {
    "type": "study", "study": "Script@tv-scripting-101", "plot_id": "plot_0",
    "offsets_by_plot": {"plot_0": 0},
    "inputs": {"pineFeatures": "{\"indicator\":1,\"plot\":1,\"ta\":1,\"label\":1,\"request.security\":1}",
               "in_0": False, "in_1": "Session", "in_2": "hlc3", "in_3": 0, "in_4": 1,
               "in_5": True, "in_6": True, "in_7": 10, "in_8": 30, "__fast_calc": False, "__profile": False},
    "pine_id": "USER;650815288d3c41afa53e38511884a352", "pine_version": "19.0",
}

def _skeleton():
    # the 'ema' template is a full barset-cross-study payload (carries all the standard
    # flags); reuse it as the skeleton for constructed cross conditions.
    return copy.deepcopy(TEMPLATES["ema"])

def ema_study(length, source):
    s = copy.deepcopy(TEMPLATES["ema"]["conditions"][0]["series"][1])  # the STD;EMA study object
    s["inputs"]["in_0"] = length
    s["inputs"]["in_1"] = source
    return s

def verb_of(t):
    return {"cross_up": "crossing up", "cross_down": "crossing down", "cross": "crossing"}.get(t, "crossing")

def entry_label(entry):
    if "template" in entry:
        return entry["template"]
    for k in ("ema_cross", "ema_cross_ema", "vwap_cross", "price_cross_value"):
        if k in entry:
            return k
    return "?"


def build(entry, symbol, defaults):
    opts = {**defaults, **{k: entry[k] for k in ("resolution", "expiration_days", "message") if k in entry}}
    short = symbol.split(":")[-1]

    if "template" in entry:
        name = entry["template"]
        if name not in TEMPLATES:
            raise ValueError(f"unknown template '{name}' (have: {', '.join(TEMPLATES)})")
        p = copy.deepcopy(TEMPLATES[name])
        # template messages for alert_cond use {{ticker}}/{{close}} → portable as-is
        if "message" in opts:
            p["message"] = opts["message"].replace("{sym}", short)
    elif "ema_cross" in entry:
        ec = entry["ema_cross"]
        length, source = ec.get("length", 89), ec.get("source", "close")
        p = _skeleton()
        cond = p["conditions"][0]
        cond["type"] = CROSS_TYPE.get(ec.get("direction", "down"), "cross_down")
        cond["series"] = [dict(BARSET), ema_study(length, source)]
        p["message"] = opts.get("message", f"{short}, price {verb_of(cond['type'])} EMA({length}, {source})").replace("{sym}", short)
    elif "ema_cross_ema" in entry:
        ec = entry["ema_cross_ema"]
        fast, slow, source = ec.get("fast", 9), ec.get("slow", 21), ec.get("source", "close")
        p = _skeleton()
        cond = p["conditions"][0]
        cond["type"] = CROSS_TYPE.get(ec.get("direction", "up"), "cross_up")
        cond["series"] = [ema_study(fast, source), ema_study(slow, source)]
        p["message"] = opts.get("message", f"{short}, EMA({fast}) {verb_of(cond['type'])} EMA({slow})").replace("{sym}", short)
    elif "vwap_cross" in entry:
        vc = entry["vwap_cross"] if isinstance(entry["vwap_cross"], dict) else {}
        p = _skeleton()
        cond = p["conditions"][0]
        cond["type"] = CROSS_TYPE.get(vc.get("direction", "cross"), "cross")
        cond["series"] = [dict(BARSET), copy.deepcopy(VWAP_STUDY)]
        p["message"] = opts.get("message", f"{short}, price {verb_of(cond['type'])} VWAP").replace("{sym}", short)
    elif "price_cross_value" in entry:
        pc = entry["price_cross_value"]
        value = pc["value"]
        p = _skeleton()
        cond = p["conditions"][0]
        cond["type"] = CROSS_TYPE.get(pc.get("direction", "cross"), "cross")
        cond["series"] = [dict(BARSET), {"type": "value", "value": value}]
        p["message"] = opts.get("message", f"{short}, price {verb_of(cond['type'])} {value}").replace("{sym}", short)
    else:
        raise ValueError("alert entry needs one of: template, ema_cross, ema_cross_ema, vwap_cross, price_cross_value")

    p["symbol"] = symbol_descriptor(symbol)
    p["name"] = None
    p["expiration"] = expiry(int(opts.get("expiration_days", 30)))
    if "resolution" in opts:
        p["resolution"] = opts["resolution"]
        for c in p.get("conditions", []):
            c["resolution"] = opts["resolution"]
    for flag in ("popup", "mobile_push", "sms_over_email", "email", "sound_file",
                 "sound_duration", "auto_deactivate"):
        if flag in defaults:
            p[flag] = defaults[flag]
    return p


def submit(page, payload):
    body = json.dumps(json.dumps({"payload": payload}))  # JS string literal of the JSON
    expr = (f"fetch('{CREATE_URL}',{{method:'POST',credentials:'include',body:{body}}})"
            ".then(r=>r.json()).then(j=>JSON.stringify({s:j.s,id:(j.r&&j.r.alert_id),err:j.errmsg}))"
            ".catch(e=>JSON.stringify({s:'fetch_error',err:String(e)}))")
    res = page.evaluate(expr)
    try:
        return json.loads(res)
    except Exception:
        return {"s": "?", "raw": res}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if not args:
        sys.exit(__doc__)
    cfg = json.loads(Path(args[0]).read_text())
    defaults = cfg.get("defaults", {})
    defaults.setdefault("expiration_days", 30)

    jobs = []
    for entry in cfg.get("alerts", []):
        for sym in entry.get("symbols", []):
            jobs.append((entry, sym))
    print(f"{len(jobs)} alert(s) to create" + (" [DRY RUN]" if dry else ""))

    if dry:
        for entry, sym in jobs:
            p = build(entry, sym, defaults)
            print(f"  {sym:14} {entry_label(entry):16} | {p['conditions'][0].get('type'):11} | {p['message']}")
        return

    host, port = resolve_cdp()
    print(f"CDP: {host}:{port}")
    page = Page(host, port)
    ok = fail = 0
    try:
        for entry, sym in jobs:
            label = entry_label(entry)
            try:
                r = submit(page, build(entry, sym, defaults))
                if r.get("s") == "ok":
                    print(f"  OK   {sym:14} {label:16} id={r.get('id')}")
                    ok += 1
                else:
                    print(f"  FAIL {sym:14} {label:16} -> {r}")
                    fail += 1
            except Exception as e:
                print(f"  ERR  {sym:14} {label:16} -> {e}")
                fail += 1
    finally:
        page.close()
    print(f"Done: {ok} created, {fail} failed.")


if __name__ == "__main__":
    main()
