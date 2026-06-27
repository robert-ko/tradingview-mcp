#!/usr/bin/env node
/**
 * plot_today_trades.mjs  --  after-market automation
 *
 * 1. Runs the trade_plotter generator:  ./trade_indicator_generator.py --log
 * 2. Detects which <sym>_trades_indicator.pine files it (re)wrote = today's traded symbols.
 * 3. If none -> no trades today -> does nothing.
 * 4. For each symbol: finds the pane showing it (any open tab), removes the previous
 *    "<SYM> Trades Plotter" study, then adds today's via the Pine editor (Add to chart,
 *    NO cloud save -> no "...Plotter N" duplicate accumulation).
 * 5. If a symbol isn't on any open chart, opens a new tab for it and plots there.
 *
 * Env overrides:
 *   TRADE_PLOTTER_DIR   (default /home/robert/Dropbox_Projects/tradingview-trade_plotter)
 *   SUCCESSTRADER_LOG_DIR (default "/mnt/c/SuccessTrader Pro_x64/LOG")
 */
import { spawnSync } from 'child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT } from '../src/connection.js';
import { resolveRenderer, list as listTabs, newTab } from '../src/core/tab.js';

const PLOTTER_DIR = process.env.TRADE_PLOTTER_DIR || '/home/robert/Dropbox_Projects/tradingview-trade_plotter';
const LOG_DIR = process.env.SUCCESSTRADER_LOG_DIR || '/mnt/c/SuccessTrader Pro_x64/LOG';
// The generator needs pandas, which lives in this venv (not /usr/bin/python3 that cron's
// minimal PATH would otherwise pick). Override with the PYTHON env var if it moves.
const PYTHON = process.env.PYTHON || '/mnt/c/Users/Robert/Dropbox/Projects/pyenvs/tv_env/bin/python3';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container, fiberKey;
    for (var i = 0; i < 20; i++) { if (!el) break; fiberKey = Object.keys(el).find(function(k){return k.startsWith('__reactFiber$');}); if (fiberKey) break; el = el.parentElement; }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') { var editors = env.editor.getEditors(); if (editors.length > 0) return { editor: editors[0], env: env }; }
      }
      current = current.return;
    }
    return null;
  })()
`;

// Per-pane symbols on one renderer
const PANES_EXPR = `(function() {
  try {
    var all = window.TradingViewApi._chartWidgetCollection.getAll();
    return all.map(function(cw, i) {
      var sym = null; try { sym = cw.model().mainSeries().symbol(); } catch(e) {}
      return { index: i, symbol: sym };
    });
  } catch(e) { return null; }
})()`;

async function evIn(client, expression, awaitPromise = false) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

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
  // freshly (re)written pine files = today's symbols
  const symbols = readdirSync(PLOTTER_DIR)
    .filter(f => /_trades_indicator\.pine$/.test(f))
    .filter(f => statSync(join(PLOTTER_DIR, f)).mtimeMs >= startMs - 1500)
    .map(f => ({ sym: f.replace('_trades_indicator.pine', '').toUpperCase(), file: join(PLOTTER_DIR, f) }));
  return { ok: true, symbols };
}

// ── 2. Locate the pane for a symbol across all open tabs ─────────────────────
async function findPane(sym) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const seen = new Set();
  for (const t of targets) {
    if (t.type !== 'page' || !/tradingview\.com\/chart/i.test(t.url)) continue;
    const chartId = t.url.match(/\/chart\/([^/?]+)/)?.[1];
    if (!chartId || seen.has(chartId)) continue;
    seen.add(chartId);
    let client;
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id });
      await client.Runtime.enable();
      const panes = await evIn(client, PANES_EXPR);
      if (panes) {
        const m = panes.find(p => p.symbol && p.symbol.split(':').pop() === sym);
        if (m) { await client.close(); return { chartId, rendererId: t.id, paneIndex: m.index }; }
      }
    } catch (e) { /* ignore */ } finally { if (client) try { await client.close(); } catch {} }
  }
  return null;
}

// ── 3. Add today's indicator to a pane (remove previous, no cloud save) ──────
async function plotOnPane(rendererId, paneIndex, sym, code) {
  // Bring the tab to the front — a backgrounded Electron tab won't render/open the Pine editor.
  try { await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${rendererId}`); } catch {}
  await sleep(1200);
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: rendererId });
  await client.Runtime.enable();
  const ev = (e, ap = false) => evIn(client, e, ap);
  const key = async (type, k, c, vk, mods = 0) => client.Input.dispatchKeyEvent({ type, modifiers: mods, key: k, code: c, windowsVirtualKeyCode: vk });
  const clickByTitle = (re) => ev(`(function(){var els=document.querySelectorAll('[title]');for(var i=0;i<els.length;i++){var t=els[i].getAttribute('title')||'';if(${re}.test(t)&&els[i].offsetParent!==null){els[i].click();return t;}}return null;})()`);
  const boundName = () => ev(`(function(){var e=document.querySelectorAll('[class*="name"]');for(var i=0;i<e.length;i++){var t=(e[i].textContent||'').trim();if(/Untitled script|Trades Plotter/i.test(t))return t;}return '(?)';})()`);
  const activate = () => ev(`(function(){var d=window.TradingViewApi._chartWidgetCollection.getAll()[${paneIndex}]._mainDiv;d.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));d.dispatchEvent(new MouseEvent('click',{bubbles:true}));return true;})()`);
  try {
    // 1. activate pane
    await activate();
    // 2. open pine editor (BEFORE removing anything, so a failure never leaves a bare pane)
    let mono = await ev(`(${FIND_MONACO}) !== null`);
    if (!mono) {
      await ev(`(function(){var bwb=window.TradingView&&window.TradingView.bottomWidgetBar;if(bwb){if(typeof bwb.activateScriptEditorTab==='function')bwb.activateScriptEditorTab();else if(typeof bwb.showWidget==='function')bwb.showWidget('pine-editor');}})()`);
      await ev(`(function(){var b=document.querySelector('[aria-label="Pine"]')||document.querySelector('[data-name="pine-dialog-button"]');if(b)b.click();})()`);
      for (let i = 0; i < 50 && !mono; i++) { await sleep(200); mono = await ev(`(${FIND_MONACO}) !== null`); }
    }
    if (!mono) throw new Error('pine editor/monaco not available');
    // 3. focus + Ctrl+K Ctrl+I to get a fresh untitled (unbind)
    await ev(`(function(){var m=${FIND_MONACO};if(m)m.editor.focus();var c=document.querySelector('.monaco-editor.pine-editor-monaco .view-lines');if(c){var r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+30,clientY:r.top+10}));c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+30,clientY:r.top+10}));}return true;})()`);
    await sleep(250);
    await key('rawKeyDown', 'k', 'KeyK', 75, 2); await key('keyUp', 'k', 'KeyK', 75, 2); await sleep(120);
    await key('rawKeyDown', 'i', 'KeyI', 73, 2); await key('keyUp', 'i', 'KeyI', 73, 2); await sleep(800);
    await ev(`(function(){var btns=document.querySelectorAll('button');for(var i=0;i<btns.length;i++){var t=btns[i].textContent.trim();if(/^(Discard|Don't save|No)$/i.test(t)&&btns[i].offsetParent!==null){btns[i].click();return;}}})()`);
    await sleep(400);
    const bn = await boundName();
    if (!/Untitled script/i.test(bn)) throw new Error(`editor not untitled (bound to ${JSON.stringify(bn)}) — skipping to avoid overwrite`);
    // 4. set today's source
    const len = await ev(`(function(){var m=${FIND_MONACO};m.editor.setValue(${JSON.stringify(code)});return m.editor.getValue().length;})()`);
    if (len < 1) throw new Error('setValue failed');
    await sleep(400);
    // 5. NOW remove the previous "<SYM> Trades Plotter" study (editor confirmed ready)
    await activate();
    const removed = await ev(`(function(){var ch=window.TradingViewApi._activeChartWidgetWV._value;var out=[];ch.getAllStudies().forEach(function(s){if(new RegExp('^'+${JSON.stringify(sym)}+' Trades Plotter','i').test(s.name)){try{ch.removeEntity(s.id);out.push(s.name);}catch(e){}}});return out;})()`);
    if (removed.length) log(`  removed previous: ${JSON.stringify(removed)}`);
    await sleep(400);
    // 6. Add to chart (today's code) on the active pane
    const before = await ev(`window.TradingViewApi._activeChartWidgetWV._value.getAllStudies().map(function(s){return s.name;})`);
    const add = await clickByTitle('/^Add to chart$/i');
    await sleep(2500);
    const after = await ev(`window.TradingViewApi._activeChartWidgetWV._value.getAllStudies().map(function(s){return s.name;})`);
    const net = after.filter(n => !before.includes(n));
    return { ok: net.length > 0, add, net };
  } finally { try { await client.close(); } catch {} }
}

// ── 4. Open a new tab for a symbol not on any chart ──────────────────────────
async function openTabFor(sym) {
  const beforeIds = new Set((await listTabs()).tabs.map(t => t.chart_id));
  await newTab();
  await sleep(2500);
  const after = (await listTabs()).tabs;
  const fresh = after.find(t => !beforeIds.has(t.chart_id)) || after[after.length - 1];
  if (!fresh) return null;
  const rid = await resolveRenderer(fresh.chart_id);
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: rid });
  await client.Runtime.enable();
  try {
    await evIn(client, `(function(){var ch=window.TradingViewApi._activeChartWidgetWV.value();ch.setSymbol(${JSON.stringify(sym)},{});return true;})()`);
    await sleep(2500);
  } finally { try { await client.close(); } catch {} }
  return { chartId: fresh.chart_id, rendererId: rid, paneIndex: 0 };
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (!existsSync(PLOTTER_DIR)) { log(`ERROR: trade plotter dir not found: ${PLOTTER_DIR}`); process.exit(1); }
  const { ok, symbols } = runGenerator();
  if (!ok) { log('ERROR: generator did not complete — aborting (not treating as "no trades").'); process.exit(1); }
  if (symbols.length === 0) { log('No trades today — nothing to plot. Done.'); process.exit(0); }
  log(`Today's traded symbols (${symbols.length}): ${symbols.map(s => s.sym).join(', ')}`);

  // CDP reachable? (TradingView running with debug port). Exit cleanly if not.
  try {
    const v = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`).then(r => r.json());
    log(`TradingView CDP OK (${v.Browser || 'unknown'}) at ${CDP_HOST}:${CDP_PORT}`);
  } catch (e) {
    log(`ERROR: TradingView CDP not reachable at ${CDP_HOST}:${CDP_PORT} — is TradingView open with --remote-debugging-port? Skipping upload. (${e.message})`);
    process.exit(1);
  }

  let okN = 0, failN = 0;
  for (const { sym, file } of symbols) {
    try {
      const code = readFileSync(file, 'utf8');
      let loc = await findPane(sym);
      if (!loc) {
        log(`${sym}: not on any open chart — opening a new tab.`);
        loc = await openTabFor(sym);
        if (!loc) { log(`${sym}: FAILED to open a chart.`); failN++; continue; }
      }
      log(`${sym}: plotting on chart ${loc.chartId} pane ${loc.paneIndex} ...`);
      const res = await plotOnPane(loc.rendererId, loc.paneIndex, sym, code);
      if (res.ok) { log(`${sym}: OK (added ${JSON.stringify(res.net)})`); okN++; }
      else { log(`${sym}: add did not register (button=${res.add}).`); failN++; }
    } catch (e) {
      log(`${sym}: ERROR ${e.message}`); failN++;
    }
  }
  log(`Done. ${okN} plotted, ${failN} failed, of ${symbols.length} symbols.`);
  process.exit(failN > 0 ? 1 : 0);
})();
