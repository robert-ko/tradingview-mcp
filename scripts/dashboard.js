#!/usr/bin/env node
/**
 * dashboard.js — local web dashboard for macro control of TradingView alerts.
 *
 *   node scripts/dashboard.js [--port 8787]
 *   open http://127.0.0.1:8787
 *
 * Reads the live alert state (grouped by symbol × type × tab), lets you enable/disable
 * groups, add alerts, and save the current state to alerts_config.json. Also exposes
 * POST /webhook to receive + log TradingView alert fires (logs/webhook_alerts.jsonl).
 * Zero external deps (built-in http); reuses src/core/alerts.js + connection + tab.
 */
import http from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { list, setAlertsActive, deleteAlerts } from '../src/core/alerts.js';
import { evaluateAsync } from '../src/connection.js';
import { listWindows } from '../src/core/tab.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number((process.argv.find((a) => a.startsWith('--port='))?.split('=')[1]) || process.env.PORT || 8787);
const HOST = process.env.DASH_HOST || '127.0.0.1';
const TEMPLATES = JSON.parse(readFileSync(join(__dir, 'alert_templates.json'), 'utf8'));
const CONFIG_PATH = join(__dir, '..', 'alerts_config.json');
const LOG_DIR = join(__dir, '..', 'logs');
const WEBHOOK_LOG = join(LOG_DIR, 'webhook_alerts.jsonl');
const CREATE_URL = 'https://pricealerts.tradingview.com/create_alert';
const MODIFY_URL = 'https://pricealerts.tradingview.com/modify_restart_alert';
// TradingView fires webhooks from its CLOUD (not the desktop app) and only accepts public
// https/http URLs on ports 443/80 — localhost is rejected. To receive fires you expose this
// server through a tunnel (ngrok/cloudflared) and set WEBHOOK_URL to the public URL.
// WEBHOOK_SECRET adds an unguessable path segment so a public /webhook can't be spammed.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WEBHOOK_PATH = `/webhook${WEBHOOK_SECRET ? '/' + WEBHOOK_SECRET : ''}`;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `http://localhost:${PORT}${WEBHOOK_PATH}`;

// ── alert classify/build (JS port of alerts_sync.py / batch_alerts.py) ───────
const TYPE_DIR = { cross: 'cross', cross_up: 'up', cross_down: 'down' };
const CROSS_TYPE = { up: 'cross_up', down: 'cross_down', cross: 'cross', both: 'cross' };
const BARSET = { type: 'barset' };
const VWAP_STUDY = {
  type: 'study', study: 'Script@tv-scripting-101', plot_id: 'plot_0', offsets_by_plot: { plot_0: 0 },
  inputs: { pineFeatures: '{"indicator":1,"plot":1,"ta":1,"label":1,"request.security":1}', in_0: false, in_1: 'Session', in_2: 'hlc3', in_3: 0, in_4: 1, in_5: true, in_6: true, in_7: 10, in_8: 30, __fast_calc: false, __profile: false },
  pine_id: 'USER;650815288d3c41afa53e38511884a352', pine_version: '19.0',
};
const VWAP_PINE = VWAP_STUDY.pine_id;
const TEMPLATE_BY_KEY = {};
for (const [name, p] of Object.entries(TEMPLATES)) {
  const c = p.conditions[0];
  if (c.type === 'alert_cond') TEMPLATE_BY_KEY[`${c.series[0].pine_id}|${c.alert_cond_id}`] = name;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const cleanSymbol = (s) => { try { return JSON.parse(String(s).replace(/^=/, '')).symbol; } catch { return s; } };

function classify(alert) {
  const sym = cleanSymbol(alert.symbol || '');
  const short = sym.split(':').pop();
  const cond = alert.condition || {};
  const msg = alert.message || '';
  const entry = { id: alert.alert_id, symbol: sym, resolution: alert.resolution, active: alert.active,
    message: short && msg.includes(short) ? msg.split(short).join('{sym}') : msg };
  const t = cond.type; const s = cond.series || []; const s0 = s[0] || {}; const s1 = s[1] || {};
  const d = TYPE_DIR[t] || 'cross';
  if (t === 'alert_cond') {
    const name = TEMPLATE_BY_KEY[`${s0.pine_id}|${cond.alert_cond_id}`];
    entry.kind = name ? { type: 'template', name } : { type: 'raw' };
    if (entry.kind.type === 'raw') entry.raw = cond;
  } else if (TYPE_DIR[t]) {
    if (s0.type === 'barset' && s1.type === 'value') entry.kind = { type: 'price_cross_value', value: s1.value, direction: d };
    else if (s0.type === 'barset' && s1.pine_id === 'STD;EMA') entry.kind = { type: 'ema_cross', length: s1.inputs.in_0, source: s1.inputs.in_1, direction: d };
    else if (s0.pine_id === 'STD;EMA' && s1.pine_id === 'STD;EMA') entry.kind = { type: 'ema_cross_ema', fast: s0.inputs.in_0, slow: s1.inputs.in_0, source: s0.inputs.in_1, direction: d };
    else if (s0.type === 'barset' && s1.pine_id === VWAP_PINE) entry.kind = { type: 'vwap_cross', direction: d };
    else { entry.kind = { type: 'raw' }; entry.raw = cond; }
  } else { entry.kind = { type: 'raw' }; entry.raw = cond; }
  return entry;
}
// cross kinds get their direction encoded so up/down are separate columns: "ema_cross~down"
const typeLabel = (kind) => (kind.type === 'template' ? kind.name : (kind.direction ? `${kind.type}~${kind.direction}` : kind.type));

function emaStudy(length, source) { const s = clone(TEMPLATES.ema.conditions[0].series[1]); s.inputs.in_0 = length; s.inputs.in_1 = source; return s; }
const verbOf = (t) => ({ cross_up: 'crossing up', cross_down: 'crossing down', cross: 'crossing' }[t] || 'crossing');
const symbolDescriptor = (full) => '=' + JSON.stringify({ adjustment: 'dividends', 'currency-id': 'USD', session: 'extended', symbol: full });
const expiry = (days) => new Date(Date.now() + days * 86400000).toISOString().replace(/\.\d+Z$/, '.000Z');

// entry: a batch-style spec {template|ema_cross|ema_cross_ema|vwap_cross|price_cross_value|raw, message?, resolution?}
function buildPayload(entry, symbol, defaults = {}) {
  const short = symbol.split(':').pop();
  const opts = { ...defaults };
  for (const k of ['resolution', 'expiration_days', 'message']) if (k in entry) opts[k] = entry[k];
  // message carries symbol ({{ticker}}), live price ({{close}}) and the alert name
  const msg = (name) => (opts.message || `{{ticker}} @ {{close}} — ${name}`).split('{sym}').join(short);
  let p;
  if (entry.template) { p = clone(TEMPLATES[entry.template]); if (opts.message) p.message = opts.message.split('{sym}').join(short); } // template msg already has {{ticker}}/{{close}}
  else if (entry.ema_cross) { const e = entry.ema_cross; p = clone(TEMPLATES.ema); const c = p.conditions[0]; c.type = CROSS_TYPE[e.direction || 'down'] || 'cross_down'; c.series = [{ ...BARSET }, emaStudy(e.length ?? 89, e.source || 'close')]; p.message = msg(`EMA(${e.length ?? 89},${e.source || 'close'}) ${verbOf(c.type)}`); }
  else if (entry.ema_cross_ema) { const e = entry.ema_cross_ema; p = clone(TEMPLATES.ema); const c = p.conditions[0]; c.type = CROSS_TYPE[e.direction || 'up'] || 'cross_up'; c.series = [emaStudy(e.fast ?? 9, e.source || 'close'), emaStudy(e.slow ?? 21, e.source || 'close')]; p.message = msg(`EMA${e.fast ?? 9}×EMA${e.slow ?? 21} ${verbOf(c.type)}`); }
  else if (entry.vwap_cross) { const e = entry.vwap_cross || {}; p = clone(TEMPLATES.ema); const c = p.conditions[0]; c.type = CROSS_TYPE[e.direction || 'cross'] || 'cross'; c.series = [{ ...BARSET }, clone(VWAP_STUDY)]; p.message = msg(`VWAP ${verbOf(c.type)}`); }
  else if (entry.price_cross_value) { const e = entry.price_cross_value; p = clone(TEMPLATES.ema); const c = p.conditions[0]; c.type = CROSS_TYPE[e.direction || 'cross'] || 'cross'; c.series = [{ ...BARSET }, { type: 'value', value: e.value }]; p.message = msg(`price ${verbOf(c.type)} ${e.value}`); }
  else if (entry.raw) { p = clone(TEMPLATES.ema); p.conditions = [clone(entry.raw)]; if (opts.message) p.message = opts.message.split('{sym}').join(short); }
  else throw new Error('entry needs a condition kind');
  p.symbol = symbolDescriptor(symbol); p.name = null; p.expiration = expiry(Number(opts.expiration_days ?? 30));
  p.web_hook = WEBHOOK_URL;   // report fires to this dashboard
  if (opts.resolution) { p.resolution = opts.resolution; for (const c of p.conditions) c.resolution = opts.resolution; }
  for (const f of ['popup', 'mobile_push', 'sms_over_email', 'email', 'sound_file', 'sound_duration', 'auto_deactivate']) if (f in defaults) p[f] = defaults[f];
  return p;
}

// classify a live alert into a buildPayload entry (for re-applying webhook/message to existing alerts)
function alertToEntry(a) {
  const cl = classify(a);
  const e = { resolution: cl.resolution };
  const k = cl.kind;
  if (k.type === 'template') e.template = k.name;
  else if (k.type === 'raw') e.raw = cl.raw || a.condition;
  else { const { type, ...rest } = k; e[type] = rest; }
  return e;
}

async function modifyAlert(payload) {
  const body = JSON.stringify(JSON.stringify({ payload }));
  return evaluateAsync(`fetch('${MODIFY_URL}',{method:'POST',credentials:'include',body:${body}})`
    + `.then(function(r){return r.json();}).then(function(j){return {s:j.s,err:j.errmsg};})`
    + `.catch(function(e){return {s:'err',err:String(e)};})`);
}

async function createAlert(payload) {
  const body = JSON.stringify(JSON.stringify({ payload }));
  return evaluateAsync(`fetch('${CREATE_URL}',{method:'POST',credentials:'include',body:${body}})`
    + `.then(function(r){return r.json();}).then(function(j){return {s:j.s,id:(j.r&&j.r.alert_id),err:j.errmsg};})`
    + `.catch(function(e){return {s:'err',err:String(e)};})`);
}

// ── state assembly ───────────────────────────────────────────────────────────
async function getState() {
  const [{ alerts = [] }, windows] = await Promise.all([list(), listWindows().catch(() => ({ windows: [] }))]);
  const classified = alerts.map(classify);
  // tab -> symbols (listWindows returns a flat `tabs` array, each with `panes[].symbol`)
  const tabs = (windows.tabs || []).map((tab) => ({
    chart_id: tab.chart_id,
    symbols: [...new Set((tab.panes || []).map((p) => p.symbol).filter(Boolean).map(cleanSymbol))],
  }));
  const symbols = [...new Set(classified.map((a) => a.symbol))].sort();
  const types = [...new Set(classified.map((a) => typeLabel(a.kind)))].sort();
  return {
    alerts: classified.map((a) => ({ id: a.id, symbol: a.symbol, type: typeLabel(a.kind), active: a.active, resolution: a.resolution, message: a.message })),
    symbols, types, tabs, templates: Object.keys(TEMPLATES),
    webhook: recentWebhooks.slice(-50).reverse(),
  };
}

async function matchIds({ symbols, types, tab, tabs }) {
  const { alerts = [] } = await list();
  const cl = alerts.map(classify);
  let targetSyms = symbols && symbols.length ? new Set(symbols) : null;
  if (tab && tabs) { const t = tabs.find((x) => x.chart_id === tab); if (t) targetSyms = new Set(t.symbols); }
  const targetTypes = types && types.length ? new Set(types) : null;
  return cl.filter((a) => (!targetSyms || targetSyms.has(a.symbol)) && (!targetTypes || targetTypes.has(typeLabel(a.kind)))).map((a) => a.id);
}

// ── webhook log ──────────────────────────────────────────────────────────────
const recentWebhooks = [];
function logWebhook(entry) {
  recentWebhooks.push(entry);
  if (recentWebhooks.length > 500) recentWebhooks.shift();
  try { if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(WEBHOOK_LOG, JSON.stringify(entry) + '\n'); } catch {}
}

// ── http server ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
const json = (r, code, obj) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(readFileSync(join(__dir, 'dashboard.html'), 'utf8'));
    }
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, await getState());

    if (req.method === 'POST' && path === '/api/toggle') {
      const body = JSON.parse(await readBody(req) || '{}');
      const st = await getState();
      const ids = await matchIds({ ...body, tabs: st.tabs });
      if (!ids.length) return json(res, 200, { changed: 0, note: 'no matching alerts' });
      const r = await setAlertsActive({ alert_ids: ids, active: !!body.active });
      await sleep(800); // let pricealerts list_alerts settle before the client re-reads
      return json(res, 200, r);
    }
    if (req.method === 'POST' && path === '/api/create') {
      const body = JSON.parse(await readBody(req) || '{}');
      const defaults = body.defaults || { resolution: '10S', expiration_days: 30, popup: true, mobile_push: true };
      const results = [];
      for (const sym of (body.symbols || [])) {
        const r = await createAlert(buildPayload(body.entry, sym, defaults));
        results.push({ symbol: sym, ...r });
      }
      return json(res, 200, { results, ok: results.filter((r) => r.s === 'ok').length });
    }
    if (req.method === 'POST' && path === '/api/delete') {
      const body = JSON.parse(await readBody(req) || '{}');
      return json(res, 200, await deleteAlerts({ alert_ids: body.ids || [] }));
    }
    if (req.method === 'POST' && path === '/api/save') {
      const { alerts = [] } = await list();
      const cfg = { defaults: { resolution: '10S', expiration_days: 30, popup: true, mobile_push: true, sms_over_email: true, auto_deactivate: false },
        alerts: alerts.map(classify).map((a) => ({ id: a.id, symbols: [a.symbol], resolution: a.resolution, message: a.message, ...(a.kind.type === 'template' ? { template: a.kind.name } : a.raw ? { raw: a.raw } : { [a.kind.type]: (({ type, ...rest }) => rest)(a.kind) }) })) };
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      return json(res, 200, { saved: CONFIG_PATH, count: cfg.alerts.length });
    }
    if (req.method === 'POST' && path === '/api/webhookify') {
      // recreate each alert with the webhook + symbol/price/name message, then delete the old
      // (preserving each alert's enabled/disabled state). modify_restart_alert can leave fired
      // on_first_fire alerts inactive, so recreate is the reliable path.
      const { alerts = [] } = await list();
      let ok = 0, fail = 0;
      for (const a of alerts) {
        try {
          const r = await createAlert(buildPayload(alertToEntry(a), a.symbol, {}));
          if (r && r.s === 'ok' && r.id) {
            await deleteAlerts({ alert_ids: [a.alert_id] });
            if (!a.active) await setAlertsActive({ alert_ids: [r.id], active: false });
            ok++;
          } else fail++;
        } catch (e) { fail++; }
      }
      await sleep(800);
      return json(res, 200, { ok, fail, webhook: WEBHOOK_URL });
    }
    if (req.method === 'POST' && (path === '/webhook' || path.startsWith('/webhook/'))) {
      if (WEBHOOK_SECRET && path !== WEBHOOK_PATH) return json(res, 403, { error: 'forbidden' });
      const raw = await readBody(req);
      let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      const entry = { at: new Date().toISOString(), ip: req.socket.remoteAddress, body: parsed };
      logWebhook(entry);
      console.log(`[webhook] ${entry.at}  ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/api/webhook') return json(res, 200, { recent: recentWebhooks.slice(-100).reverse(), logPath: WEBHOOK_LOG });
    if (req.method === 'GET' && path === '/api/fired') {
      // TradingView webhooks can't reach localhost (cloud-origin, ports 80/443 only), so we
      // surface fired alerts by polling last_fire_time from list_alerts instead.
      const { alerts = [] } = await list();
      const fired = alerts
        .filter((a) => a.last_fired)
        .map((a) => ({ id: a.alert_id, symbol: a.symbol, message: a.message, at: a.last_fired, active: a.active }))
        .sort((x, y) => String(y.at).localeCompare(String(x.at)));
      return json(res, 200, { fired: fired.slice(0, 60) });
    }
    if (req.method === 'GET' && path === '/webhook.log') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(existsSync(WEBHOOK_LOG) ? readFileSync(WEBHOOK_LOG, 'utf8') : '(no webhook fires logged yet)');
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`TradingView alert dashboard → http://${HOST}:${PORT}`);
  console.log(`webhook receiver: POST http://${HOST}:${PORT}${WEBHOOK_PATH}  (logs to ${WEBHOOK_LOG})`);
  console.log(`alerts will report fires to: ${WEBHOOK_URL}`);
  if (!WEBHOOK_SECRET) console.log('tip: set WEBHOOK_SECRET when exposing publicly (see docs/WEBHOOK_TUNNEL.md)');
});
