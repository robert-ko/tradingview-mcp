#!/usr/bin/env python3
"""
export_alerts.py — dump all current TradingView alerts to a readable JSON file.

    python scripts/export_alerts.py [out.json]      # default: alerts_export.json

Reuses the CDP plumbing in batch_alerts.py (so it rides your logged-in session).
Each alert is summarized with a human-readable `condition` plus the fields you'd
need to recreate or audit it.
"""
import sys, json
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from batch_alerts import resolve_cdp, Page  # noqa: E402


def clean_symbol(s):
    try:
        return json.loads(s.replace("=", "", 1))["symbol"]
    except Exception:
        return s


def render_condition(cond):
    """Human-readable one-liner for an alert condition."""
    if not cond:
        return None
    t = cond.get("type")
    if t == "alert_cond":
        return f"alertcondition[{cond.get('alert_cond_id')}]"
    parts = []
    for s in cond.get("series", []):
        st = s.get("type")
        if st == "barset":
            parts.append("price")
        elif st == "value":
            parts.append(str(s.get("value")))
        elif st == "study":
            pid = s.get("pine_id", "")
            ins = s.get("inputs", {})
            if pid == "STD;EMA":
                parts.append(f"EMA({ins.get('in_0')}, {ins.get('in_1')})")
            else:
                parts.append(f"study[{pid}:{s.get('plot_id')}]")
        else:
            parts.append(str(st))
    return f" {t} ".join(parts)


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "alerts_export.json"
    host, port = resolve_cdp()
    print(f"CDP: {host}:{port}")
    page = Page(host, port)
    try:
        raw = page.evaluate(
            "fetch('https://pricealerts.tradingview.com/list_alerts',{credentials:'include'})"
            ".then(r=>r.json()).then(d=>JSON.stringify(d.r||[]))"
        )
    finally:
        page.close()
    alerts = json.loads(raw)

    export = []
    for a in alerts:
        export.append({
            "alert_id": a.get("alert_id"),
            "symbol": clean_symbol(a.get("symbol", "")),
            "active": a.get("active"),
            "type": a.get("type"),
            "resolution": a.get("resolution"),
            "condition": render_condition(a.get("condition")),
            "message": a.get("message"),
            "created": a.get("create_time"),
            "last_fired": a.get("last_fire_time"),
            "expiration": a.get("expiration"),
            "notify": {"popup": a.get("popup"), "mobile_push": a.get("mobile_push"),
                       "email": a.get("email"), "sms": a.get("sms_over_email")},
        })
    export.sort(key=lambda x: (x["symbol"] or "", x["message"] or ""))

    doc = {
        "count": len(export),
        "active": sum(1 for x in export if x["active"]),
        "by_symbol": dict(Counter(x["symbol"] for x in export)),
        "alerts": export,
    }
    Path(out_path).write_text(json.dumps(doc, indent=2))
    print(f"wrote {out_path}: {doc['count']} alerts ({doc['active']} active)")
    print("by symbol:", doc["by_symbol"])


if __name__ == "__main__":
    main()
