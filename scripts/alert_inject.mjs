#!/usr/bin/env node
/**
 * alert_inject.mjs — capture an alert you create in the TradingView UI, then
 * replay it (esp. indicator-condition alerts) across other symbols via the
 * pricealerts REST API. Built because the UI is the only reliable way to author
 * a complex condition, but the API is the only sane way to fan it out.
 *
 * Workflow:
 *   node scripts/alert_inject.mjs arm                 # install fetch/XHR capture on all chart tabs
 *   # ...create ONE alert in the TradingView UI (any condition)...
 *   node scripts/alert_inject.mjs show                # see captured create_alert payloads
 *   node scripts/alert_inject.mjs replay NYSE:IONQ NASDAQ:RGTI NYSE:QBTS [--index N]
 *
 * Notes:
 *  - The capture hook lives in the page until you reload/restart TradingView.
 *  - create_alert/delete_alerts require NO Content-Type header (JSON content-type
 *    triggers a cross-origin CORS preflight the endpoint rejects; omitting it
 *    sends text/plain = a CORS "simple request"). See docs/ALERT_INJECTION.md.
 */
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT, getClient } from '../src/connection.js';

const CREATE_URL = 'https://pricealerts.tradingview.com/create_alert';
const LIST_URL = 'https://pricealerts.tradingview.com/list_alerts';

// Persistent updatable predicate (__aiKeep) + a single wrapper (__aiWrapped), so
// re-running 'arm' can broaden the capture filter without re-wrapping fetch/XHR.
const HOOK = `(function(){
  window.__alertInject = window.__alertInject || [];
  window.__aiKeep = function(url, body){
    try { if (/pricealerts/i.test(url||'') && !/list_alerts/i.test(url||''))
      window.__alertInject.push({ url:url, body:(typeof body==='string'?body:JSON.stringify(body)), t:Date.now() }); } catch(e){}
  };
  if (!window.__aiWrapped) {
    window.__aiWrapped = true;
    var of = window.fetch;
    window.fetch = function(u,o){ try{ if(o&&(o.method||'').toUpperCase()==='POST') window.__aiKeep((typeof u==='string')?u:(u&&u.url), o.body); }catch(e){} return of.apply(this, arguments); };
    var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m,u){ this.__m=m; this.__u=u; return oo.apply(this,arguments); };
    XMLHttpRequest.prototype.send = function(b){ try{ if((this.__m||'').toUpperCase()==='POST') window.__aiKeep(this.__u, b); }catch(e){} return os.apply(this,arguments); };
    return 'installed';
  }
  return 'filter-updated ('+window.__alertInject.length+' captured)';
})()`;

async function eachChartTab(fn) {
  const targets = await (await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`)).json();
  const seen = new Set();
  const out = [];
  for (const t of targets) {
    if (t.type !== 'page' || !/tradingview\.com\/chart/i.test(t.url)) continue;
    const cid = (t.url.match(/\/chart\/([^/?]+)/) || [])[1];
    if (cid && seen.has(cid)) continue; if (cid) seen.add(cid);
    let c;
    try { c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id }); await c.Runtime.enable(); out.push(await fn(c, cid)); }
    catch (e) { /* ignore */ } finally { if (c) await c.close().catch(() => {}); }
  }
  return out;
}

const evCtx = async (c, expr, awaitPromise = false) => {
  const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

async function collectCaptures() {
  const results = await eachChartTab(async (c) => evCtx(c, `JSON.stringify(window.__alertInject || [])`));
  const all = results.flatMap((s) => { try { return JSON.parse(s); } catch { return []; } });
  const seen = new Set();
  return all.filter((x) => { const k = (x.url || '') + '|' + (x.body || ''); if (seen.has(k)) return false; seen.add(k); return true; });
}

function endpointOf(url) { return (url.match(/pricealerts\.tradingview\.com\/([^?]+)/) || [, '?'])[1]; }

function describe(cap) {
  const ep = endpointOf(cap.url || '');
  try {
    const p = JSON.parse(cap.body).payload;
    if (p.alert_ids) return { action: ep, alert_ids: p.alert_ids };   // stop/restart/delete
    const sym = (() => { try { return JSON.parse((p.symbol || '').replace(/^=/, '')).symbol; } catch { return p.symbol; } })();
    const cond = (p.conditions && p.conditions[0]) || {};
    const series = (cond.series || []).map((s) => s.type === 'study' ? `study(${s.plot_id})` : (s.type === 'value' ? `value(${s.value})` : s.type)).join(' ' + (cond.type || 'cross') + ' ');
    return { action: ep, symbol: sym, resolution: p.resolution, condition: series, message: p.message };
  } catch (e) { return { action: ep, error: 'unparseable: ' + e.message }; }
}

// ── subcommands ──────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'arm') {
  const res = await eachChartTab(async (c, cid) => `${cid}: ${await evCtx(c, HOOK)}`);
  res.forEach((r) => console.log('  ' + r));
  console.log(`Armed on ${res.length} tabs. Now create ONE alert in the UI, then: node scripts/alert_inject.mjs show`);
  process.exit(0);
}

if (cmd === 'reset') {
  const res = await eachChartTab(async (c) => evCtx(c, `(window.__alertInject = []), 'cleared'`));
  console.log(`Capture buffer cleared on ${res.length} tabs (hook stays armed).`);
  process.exit(0);
}

if (cmd === 'show') {
  const caps = await collectCaptures();
  if (!caps.length) { console.log('Nothing captured. Run `arm` first, then create an alert in the UI (do not reload the tab).'); process.exit(0); }
  caps.forEach((x, i) => console.log(`[${i}] ${JSON.stringify(describe(x))}`));
  process.exit(0);
}

if (cmd === 'replay') {
  const args = rest.filter((a) => !a.startsWith('--'));
  const idxFlag = rest.find((a) => a.startsWith('--index='));
  const idx = idxFlag ? Number(idxFlag.split('=')[1]) : -1; // default: last captured
  if (args.length === 0) { console.log('Usage: replay <EXCHANGE:SYM> [more...] [--index=N]'); process.exit(1); }

  const caps = await collectCaptures();
  if (!caps.length) { console.log('No captured template. Run `arm`, create an alert in the UI, then replay.'); process.exit(1); }
  const tplCap = caps[idx < 0 ? caps.length - 1 : idx];
  if (!tplCap?.body) { console.log(`No capture at index ${idx}. ${caps.length} available.`); process.exit(1); }
  const tpl = JSON.parse(tplCap.body);
  const oldSym = (() => { try { return JSON.parse((tpl.payload.symbol || '').replace(/^=/, '')).symbol; } catch { return null; } })();
  const oldShort = oldSym ? oldSym.split(':').pop() : null;
  console.log(`Template: ${JSON.stringify(describe(tplCap))}`);

  const c = await getClient();
  for (const full of args) {
    if (!full.includes(':')) { console.log(`${full}: skipped (need EXCHANGE:SYMBOL)`); continue; }
    const short = full.split(':').pop();
    const p = JSON.parse(JSON.stringify(tpl));
    const desc = JSON.parse(p.payload.symbol.replace(/^=/, ''));
    desc.symbol = full;
    p.payload.symbol = '=' + JSON.stringify(desc);
    if (oldShort && p.payload.message) p.payload.message = p.payload.message.split(oldShort).join(short);
    p.payload.name = null;
    const expr = `fetch(${JSON.stringify(CREATE_URL)},{method:'POST',credentials:'include',body:${JSON.stringify(JSON.stringify(p))}}).then(r=>r.json()).then(j=>j.s||JSON.stringify(j)).catch(e=>'ERR '+e.message)`;
    const s = await evCtx(c, expr, true);
    console.log(`  ${full} -> ${s}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  process.exit(0);
}

console.log('Usage: node scripts/alert_inject.mjs <arm|show|replay>');
console.log('  arm                              install capture on all chart tabs');
console.log('  show                             list captured create_alert payloads');
console.log('  replay <EXCHANGE:SYM>... [--index=N]   replay a captured alert to other symbols');
process.exit(1);
