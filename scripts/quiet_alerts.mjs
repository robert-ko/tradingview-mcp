#!/usr/bin/env node
/**
 * quiet_alerts.mjs — recreate TradingView alerts with quieter notifications and/or a
 * lower firing rate, keeping each alert's condition + webhook.
 *
 * TradingView has no "modify these fields" API for alerts, and list_alerts doesn't echo
 * popup/sound/web_hook/frequency — so the only way to change them is to re-create the alert
 * (create with the new payload, delete the old). This reuses the dashboard's tested
 * buildPayload, so the recreated alert is byte-identical except for the overrides below.
 *
 * Because each recreate rebuilds from the template baseline (popup/sound/push ON), this
 * script DEFAULTS TO FULLY QUIET (no popup, no sound, no mobile push). Opt back in with
 * --keep-popup / --keep-sound / --keep-push.
 *
 *   # disable push (and keep popup+sound muted) on ALL alerts:
 *   WEBHOOK_URL='https://<you>.ngrok-free.dev/webhook/<secret>' node scripts/quiet_alerts.mjs
 *
 *   # rate-limit VWAP-crossing alerts to <= once per minute (raise the alert timeframe):
 *   WEBHOOK_URL='…' node scripts/quiet_alerts.mjs --type vwap --resolution 1
 *
 *   node scripts/quiet_alerts.mjs --dry-run          # preview, no changes
 *
 * Flags:
 *   --type <substr>     only touch alerts whose type label contains <substr> (e.g. vwap, ema, pdh)
 *   --resolution <res>  alert timeframe, e.g. 1, 5, 15, 60, D. Lower firing rate = coarser tf.
 *                       This is the ONLY rate limiter that works for study/indicator cross alerts.
 *   --freq <value>      per-condition frequency. NOTE: TradingView REJECTS everything except
 *                       "on_first_fire" for study-based cross conditions (once_per_bar,
 *                       once_per_minute, once_per_bar_close all -> invalid_request). Use
 *                       --resolution to slow these down instead.
 *   --keep-popup / --keep-sound / --keep-push
 *   --dry-run
 *
 * IMPORTANT: run with the SAME WEBHOOK_URL (and WEBHOOK_SECRET) the dashboard uses, or the
 * recreated alerts will point their webhook at localhost. TradingView must be reachable via CDP.
 */
import { list, deleteAlerts, setAlertsActive } from '../src/core/alerts.js';
import { buildPayload, alertToEntry, classify, typeLabel, createAlert, WEBHOOK_URL } from './dashboard.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const dry = flag('--dry-run');
const typeFilter = (val('--type') || '').toLowerCase();
const defaults = {};
if (!flag('--keep-popup')) defaults.popup = false;
if (!flag('--keep-sound')) defaults.sound_duration = 0;
if (!flag('--keep-push')) defaults.mobile_push = false;
if (val('--freq')) defaults.frequency = val('--freq');
if (val('--resolution')) defaults.resolution = val('--resolution');

if (!/^https?:\/\//.test(WEBHOOK_URL) || WEBHOOK_URL.includes('localhost')) {
  console.warn(`⚠  WEBHOOK_URL is "${WEBHOOK_URL}" — recreated alerts will use this. Set WEBHOOK_URL to the public tunnel URL to keep webhooks working.`);
}

const { alerts = [] } = await list();
const targets = alerts.filter((a) => !typeFilter || typeLabel(classify(a).kind).toLowerCase().includes(typeFilter));

console.log(`alerts: ${alerts.length} total, ${targets.length} match${typeFilter ? ` type~"${typeFilter}"` : ''}`);
console.log(`overrides: ${JSON.stringify(defaults)}  |  webhook: ${WEBHOOK_URL}${dry ? '  |  DRY-RUN' : ''}`);
if (!targets.length) { console.log('nothing to do.'); process.exit(0); }

let ok = 0, fail = 0;
for (const a of targets) {
  const label = `${a.symbol} ${typeLabel(classify(a).kind)}`;
  if (dry) { console.log('  would recreate', label); continue; }
  try {
    const entry = alertToEntry(a);
    for (const k of Object.keys(defaults)) delete entry[k]; // explicit CLI overrides beat inherited values (e.g. resolution)
    const r = await createAlert(buildPayload(entry, a.symbol, defaults));
    if (r && r.s === 'ok' && r.id) {
      await deleteAlerts({ alert_ids: [a.alert_id] });
      if (!a.active) await setAlertsActive({ alert_ids: [r.id], active: false }); // preserve paused state
      ok++; process.stdout.write('.');
    } else { fail++; console.error('\n  FAIL', label, r && r.err); }
  } catch (e) { fail++; console.error('\n  ERR', label, e.message); }
}
console.log(`\ndone: ${ok} recreated, ${fail} failed`);
