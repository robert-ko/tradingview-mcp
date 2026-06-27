#!/usr/bin/env python3
"""
alerts_sync.py — round-trippable alert config + declarative sync.

    python scripts/alerts_sync.py export [config.json]        # live alerts -> editable config
    python scripts/alerts_sync.py apply  config.json [--dry-run]   # make live match config

`export` writes each live alert as a batch_alerts entry (template / ema_cross /
ema_cross_ema / vwap_cross / price_cross_value / raw). Hand-edit that file, then
`apply` it: the diff is CONTENT-BASED (symbol + condition kind/params + resolution +
message), so it won't churn unchanged alerts and the `id` field is informational only.

apply reconciles to match the config:
  * entries with no matching live alert  -> CREATE
  * live alerts not present in the config -> DELETE
  * matches -> left alone
Editing a param/message changes the fingerprint => old deleted + new created (= update).
Use {sym} in messages to make them symbol-agnostic.
"""
import sys, json, copy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch_alerts as BA  # build, Page, resolve_cdp, TEMPLATES, VWAP_STUDY, symbol_descriptor, expiry

DELETE_URL = "https://pricealerts.tradingview.com/delete_alerts"
LIST_URL = "https://pricealerts.tradingview.com/list_alerts"
TYPE_DIR = {"cross": "cross", "cross_up": "up", "cross_down": "down"}
VWAP_PINE = BA.VWAP_STUDY["pine_id"]

# reverse map: (study pine_id, alert_cond_id) -> template name (for alert_cond templates)
TEMPLATE_BY_KEY = {}
for _name, _p in BA.TEMPLATES.items():
    _c = _p["conditions"][0]
    if _c.get("type") == "alert_cond":
        TEMPLATE_BY_KEY[(_c["series"][0].get("pine_id"), _c.get("alert_cond_id"))] = _name


def clean_symbol(s):
    try:
        return json.loads(s.replace("=", "", 1))["symbol"]
    except Exception:
        return s


# ── classify a live alert into a config entry ────────────────────────────────
def classify(alert):
    sym = clean_symbol(alert.get("symbol", ""))
    short = sym.split(":")[-1]
    cond = alert.get("condition") or {}
    msg = alert.get("message") or ""
    entry = {"id": alert.get("alert_id"), "symbols": [sym], "resolution": alert.get("resolution"),
             "message": msg.replace(short, "{sym}") if short and short in msg else msg}
    t = cond.get("type")
    series = cond.get("series", [])
    s0 = series[0] if len(series) > 0 else {}
    s1 = series[1] if len(series) > 1 else {}
    d = TYPE_DIR.get(t, "cross")
    if t == "alert_cond":
        name = TEMPLATE_BY_KEY.get((s0.get("pine_id"), cond.get("alert_cond_id")))
        if name:
            entry["template"] = name
        else:
            entry["raw"] = cond
    elif t in TYPE_DIR:
        if s0.get("type") == "barset" and s1.get("type") == "value":
            entry["price_cross_value"] = {"value": s1.get("value"), "direction": d}
        elif s0.get("type") == "barset" and s1.get("pine_id") == "STD;EMA":
            entry["ema_cross"] = {"length": s1["inputs"].get("in_0"), "source": s1["inputs"].get("in_1"), "direction": d}
        elif s0.get("pine_id") == "STD;EMA" and s1.get("pine_id") == "STD;EMA":
            entry["ema_cross_ema"] = {"fast": s0["inputs"].get("in_0"), "slow": s1["inputs"].get("in_0"),
                                      "source": s0["inputs"].get("in_1"), "direction": d}
        elif s0.get("type") == "barset" and s1.get("pine_id") == VWAP_PINE:
            entry["vwap_cross"] = {"direction": d}
        else:
            entry["raw"] = cond
    else:
        entry["raw"] = cond
    return entry


# ── content fingerprint (identity of an alert, ignoring id/expiration) ────────
def kind_params(entry):
    if "template" in entry:
        return ("template:" + entry["template"], ())
    for k in ("ema_cross", "ema_cross_ema", "vwap_cross", "price_cross_value"):
        if k in entry:
            p = entry[k] or {}
            return (k, tuple(sorted((kk, p[kk]) for kk in p)))
    if "raw" in entry:
        return ("raw", (json.dumps(entry["raw"], sort_keys=True),))
    return ("?", ())

def fingerprint(entry, symbol):
    k, p = kind_params(entry)
    msg = (entry.get("message") or "").replace("{sym}", symbol.split(":")[-1])
    return (symbol, k, p, entry.get("resolution"), msg)


# ── CDP helpers ───────────────────────────────────────────────────────────────
def fetch_live(page):
    raw = page.evaluate(f"fetch('{LIST_URL}',{{credentials:'include'}}).then(r=>r.json()).then(d=>JSON.stringify(d.r||[]))")
    return json.loads(raw)

def delete_ids(page, ids):
    for i in range(0, len(ids), 100):
        batch = json.dumps(ids[i:i + 100])
        page.evaluate(f"fetch('{DELETE_URL}',{{method:'POST',credentials:'include',"
                      f"body:JSON.stringify({{payload:{{alert_ids:{batch}}}}})}}).then(r=>r.json()).catch(e=>0)")


# ── subcommands ───────────────────────────────────────────────────────────────
def do_export(out_path):
    host, port = BA.resolve_cdp()
    page = BA.Page(host, port)
    try:
        live = fetch_live(page)
    finally:
        page.close()
    entries = [classify(a) for a in live]
    entries.sort(key=lambda e: (e["symbols"][0], json.dumps(kind_params(e))))
    doc = {"defaults": {"resolution": "10S", "expiration_days": 30,
                        "popup": True, "mobile_push": True, "sms_over_email": True, "auto_deactivate": False},
           "alerts": entries}
    Path(out_path).write_text(json.dumps(doc, indent=2))
    print(f"wrote {out_path}: {len(entries)} alerts (round-trippable config)")


def do_apply(cfg_path, dry):
    cfg = json.loads(Path(cfg_path).read_text())
    defaults = cfg.get("defaults", {})
    # desired jobs: (entry, symbol) -> fingerprint
    desired = {}
    for entry in cfg.get("alerts", []):
        for sym in entry.get("symbols", []):
            desired[fingerprint(entry, sym)] = (entry, sym)

    host, port = BA.resolve_cdp()
    print(f"CDP: {host}:{port}")
    page = BA.Page(host, port)
    try:
        live = fetch_live(page)
        live_fp = {fingerprint(classify(a), clean_symbol(a.get("symbol", ""))): a for a in live}

        to_create = [v for fp, v in desired.items() if fp not in live_fp]
        to_delete = [a for fp, a in live_fp.items() if fp not in desired]

        print(f"diff vs {len(live)} live alerts: {len(to_create)} to create, {len(to_delete)} to delete, "
              f"{len(desired) - len(to_create)} unchanged")
        for entry, sym in to_create:
            print(f"  + {sym:16} {BA.entry_label(entry)}")
        for a in to_delete:
            print(f"  - {clean_symbol(a.get('symbol','')):16} {(a.get('message') or '')[:50]}")

        if dry:
            print("[dry run — nothing changed]")
            return
        if to_delete:
            delete_ids(page, [a["alert_id"] for a in to_delete])
            print(f"deleted {len(to_delete)}")
        ok = 0
        for entry, sym in to_create:
            r = BA.submit(page, BA.build(entry, sym, defaults))
            ok += 1 if r.get("s") == "ok" else 0
            if r.get("s") != "ok":
                print(f"  FAIL {sym} -> {r}")
        print(f"created {ok}/{len(to_create)}")
    finally:
        page.close()


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd = a[0]
    if cmd == "export":
        do_export(a[1] if len(a) > 1 and not a[1].startswith("--") else "alerts_config.json")
    elif cmd == "apply":
        paths = [x for x in a[1:] if not x.startswith("--")]
        if not paths:
            sys.exit("usage: alerts_sync.py apply config.json [--dry-run]")
        do_apply(paths[0], "--dry-run" in a)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
