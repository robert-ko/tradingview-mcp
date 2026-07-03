#!/usr/bin/env node
/**
 * plot_today_trades.mjs  --  after-market automation (v3: overwrite saved script via pine-facade REST)
 *
 * 1. Runs the trade_plotter generator:  ./trade_indicator_generator.py --log
 * 2. Detects which <sym>_trades_indicator.pine files it (re)wrote = today's traded symbols.
 * 3. If none -> no trades today -> does nothing.
 * 4. For each symbol: overwrites the saved "<SYM> Trades Plotter" Pine script IN PLACE via
 *    the pine-facade save endpoint (no editor, no dialog, no duplicates):
 *        POST /pine-facade/save/next/{scriptId}?allow_create_new=false&name={name}
 *        body: FormData { source: <today's pine> }
 *    (Run inside a TradingView page so the session cookie authenticates the request.)
 * 5. Optional --reload: also refresh the on-chart study (remove + re-add via the Indicators
 *    dialog) so panes show today's trades immediately; existing studies otherwise keep the
 *    version they were added with until re-added.
 *
 * Why v3: v1 clicked "Add to chart" of the *unsaved* editor script, which this TradingView
 * build silently added as the blank default template ("My script" / plot(close)) — charts
 * showed no update. v2 used the editor's Ctrl+S save, which is a no-op unless the editor is
 * focused AND bound to that exact script (monaco.setValue doesn't mark it dirty), so it wrote
 * nothing to the cloud. The REST save is renderer-independent and always overwrites in place.
 *
 * A symbol with no saved "<SYM> Trades Plotter" is reported and skipped (never auto-created,
 * to avoid junk). Env: TRADE_PLOTTER_DIR, SUCCESSTRADER_LOG_DIR, PYTHON.
 */
import { spawnSync } from 'child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CDP_HOST, CDP_PORT, evaluateAsync } from '../src/connection.js';
import { listScripts } from '../src/core/pine.js';
import { resolveRenderer, evaluateInTarget } from '../src/core/tab.js';

const PLOTTER_DIR = process.env.TRADE_PLOTTER_DIR || '/home/robert/Dropbox_Projects/tradingview-trade_plotter';
const LOG_DIR = process.env.SUCCESSTRADER_LOG_DIR || '/mnt/c/SuccessTrader Pro_x64/LOG';
const PYTHON = process.env.PYTHON || '/mnt/c/Users/Robert/Dropbox/Projects/pyenvs/tv_env/bin/python3';
const RELOAD = process.argv.includes('--reload');
const SAVE_BASE = 'https://pine-facade.tradingview.com/pine-facade/save/next/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const scriptName = sym => `${sym} Trades Plotter`;

// ── 1. Generate ────────────────────────────────────────────────────────────
function runGenerator() {
  const startMs = Date.now();
  log(`Running generator (${PYTHON}) in ${PLOTTER_DIR} ...`);
  const gen = spawnSync(PYTHON, ['trade_indicator_generator.py', '--log', '--log-dir', LOG_DIR],
    { cwd: PLOTTER_DIR, encoding: 'utf8' });
  if (gen.stdout) process.stdout.write(gen.stdout);
  if (gen.stderr) process.stderr.write(gen.stderr);
  if (gen.error) { log(`Generator failed to spawn: ${gen.error.message}`); return { ok: false, symbols: [] }; }
  if (gen.status !== 0) { log(`Generator exited ${gen.status} (see output above)`); return { ok: false, symbols: [] }; }
  const symbols = readdirSync(PLOTTER_DIR)
    .filter(f => /_trades_indicator\.pine$/.test(f))
    .filter(f => statSync(join(PLOTTER_DIR, f)).mtimeMs >= startMs - 1500)
    .map(f => ({ sym: f.replace('_trades_indicator.pine', '').toUpperCase(), file: join(PLOTTER_DIR, f) }));
  return { ok: true, symbols };
}

// ── 2. Overwrite the saved script in place via pine-facade (runs in the TV page) ─────────────
async function saveScriptSource(scriptId, name, source) {
  const expr = `(function(){
    var fd = new FormData();
    fd.append('source', ${JSON.stringify(source)});
    var url = ${JSON.stringify(SAVE_BASE)} + encodeURIComponent(${JSON.stringify(scriptId)}) +
              '?allow_create_new=false&name=' + encodeURIComponent(${JSON.stringify(name)});
    return fetch(url, { method: 'POST', credentials: 'include', body: fd })
      .then(function(r){ return r.text(); })
      .then(function(t){ var j=null; try{ j=JSON.parse(t); }catch(e){}
        return { ok: !!(j && j.success), version: (j && j.result && j.result.version) || null,
                 err: (j && !j.success) ? JSON.stringify(j).slice(0,160) : (j ? null : ('non-json: ' + t.slice(0,120))) }; })
      .catch(function(e){ return { ok:false, err:String(e) }; });
  })()`;
  return evaluateAsync(expr);
}

// ── 3. (optional) reload the on-chart study so panes show today's trades ─────────────────────
async function reloadStudy(sym) {
  // find a renderer/pane showing this symbol
  const targets = await (await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`)).json();
  const pages = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  for (const t of pages) {
    const chartId = t.url.match(/\/chart\/([^/?]+)/)?.[1];
    if (!chartId) continue;
    let rid; try { rid = await resolveRenderer(chartId); } catch { continue; }
    const paneIdx = await evaluateInTarget(rid, `(function(){try{var all=window.TradingViewApi._chartWidgetCollection.getAll();for(var i=0;i<all.length;i++){try{var s=all[i].model().mainSeries().symbol();if(s&&s.split(':').pop()===${JSON.stringify(sym)})return i;}catch(e){}}return -1;}catch(e){return -1;}})()`);
    if (paneIdx == null || paneIdx < 0) continue;
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${rid}`).catch(() => {});
    await sleep(1200);
    const ev = (e) => evaluateInTarget(rid, e);
    // activate pane + remove existing "<SYM> Trades" study
    await ev(`(function(){var d=window.TradingViewApi._chartWidgetCollection.getAll()[${paneIdx}]._mainDiv;d.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));d.dispatchEvent(new MouseEvent('click',{bubbles:true}));var ch=window.TradingViewApi._activeChartWidgetWV._value;ch.getAllStudies().forEach(function(s){if(new RegExp('^'+${JSON.stringify(sym)}+' Trades','i').test(s.name)){try{ch.removeEntity(s.id);}catch(e){}}});return true;})()`);
    await sleep(600);
    // open Indicators dialog -> My scripts -> click "<SYM> Trades Plotter"
    await ev(`(function(){var b=document.querySelector('[data-name="open-indicators-dialog"]');if(b)b.click();})()`);
    await sleep(2200);
    await ev(`(function(){var e=document.querySelectorAll('[role="dialog"] *');for(var i=0;i<e.length;i++){if(e[i].childElementCount===0&&(e[i].textContent||'').trim()==='My scripts'&&e[i].offsetParent!==null){(e[i].closest('button,[role="tab"],[role="button"],a,div')||e[i]).click();break;}}})()`);
    await sleep(1400);
    const clicked = await ev(`(function(){var nm=${JSON.stringify(scriptName(sym))};var e=document.querySelectorAll('[role="dialog"] *');for(var i=0;i<e.length;i++){if(e[i].childElementCount===0&&(e[i].textContent||'').trim()===nm&&e[i].offsetParent!==null){(e[i].closest('[class*="item"],[class*="row"],div')||e[i]).click();return true;}}return false;})()`);
    await sleep(2500);
    await ev(`(function(){var d=document.querySelector('[role="dialog"]');if(!d)return;var dr=d.getBoundingClientRect();var bs=d.querySelectorAll('button,[role="button"],[class*="close"]');var best=null,bx=-1;for(var i=0;i<bs.length;i++){var b=bs[i];if(b.offsetParent===null)continue;var r=b.getBoundingClientRect();if(r.top<dr.top+60&&r.right>dr.right-60&&r.width<50&&r.right>bx){bx=r.right;best=b;}}if(best)best.click();})()`);
    return clicked ? { reloaded: true, chartId, pane: paneIdx } : { reloaded: false, chartId };
  }
  return { reloaded: false, reason: 'symbol not on any open chart' };
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (!existsSync(PLOTTER_DIR)) { log(`ERROR: trade plotter dir not found: ${PLOTTER_DIR}`); process.exit(1); }
  const { ok, symbols } = runGenerator();
  if (!ok) { log('ERROR: generator did not complete — aborting (not treating as "no trades").'); process.exit(1); }
  if (symbols.length === 0) { log('No trades today — nothing to plot. Done.'); process.exit(0); }
  log(`Today's traded symbols (${symbols.length}): ${symbols.map(s => s.sym).join(', ')}`);

  try {
    const v = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`).then(r => r.json());
    log(`TradingView CDP OK (${v.Browser || 'unknown'}) at ${CDP_HOST}:${CDP_PORT}`);
  } catch (e) {
    log(`ERROR: TradingView CDP not reachable at ${CDP_HOST}:${CDP_PORT} — is TradingView open with --remote-debugging-port? Skipping. (${e.message})`);
    process.exit(1);
  }

  // map saved "<SYM> Trades Plotter" -> scriptIdPart
  const { scripts = [] } = await listScripts();
  const idByName = new Map(scripts.map(s => [s.name.toLowerCase(), s.id]));

  let okN = 0, failN = 0, skipN = 0;
  for (const { sym, file } of symbols) {
    try {
      const name = scriptName(sym);
      const id = idByName.get(name.toLowerCase());
      if (!id) { log(`${sym}: SKIP — no saved "${name}" (add it to a chart once via Indicators → My scripts).`); skipN++; continue; }
      const code = readFileSync(file, 'utf8');
      const r = await saveScriptSource(id, name, code);
      if (r && r.ok) {
        log(`${sym}: overwrote saved "${name}" (${id}) -> v${r.version}`);
        if (RELOAD) { const rl = await reloadStudy(sym); log(`${sym}: chart reload ${rl.reloaded ? 'OK' : 'skipped (' + (rl.reason || 'add did not register') + ')'}`); }
        okN++;
      } else { log(`${sym}: SAVE FAILED — ${r && r.err}`); failN++; }
    } catch (e) {
      log(`${sym}: ERROR ${e.message}`); failN++;
    }
  }
  log(`Done. ${okN} overwritten, ${skipN} skipped (no saved script), ${failN} failed, of ${symbols.length} symbols.${RELOAD ? '' : '  (studies already on a chart keep their version until re-added; run with --reload to refresh them.)'}`);
  process.exit(failN > 0 ? 1 : 0);
})();
