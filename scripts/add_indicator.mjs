/**
 * add_indicator.mjs <SYM>
 *
 * Finds the pane showing <SYM>, then adds <sym>_trades_indicator.pine
 * from the "My scripts" section of the Indicators dialog.
 *
 * The pine file must already be saved to TradingView. The script is
 * identified by its title "<SYM> Trades Plotter" in My scripts.
 *
 * Usage:
 *   node scripts/add_indicator.mjs ALLO
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT } from '../src/connection.js';
import { evaluateInTarget } from '../src/core/tab.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Args ────────────────────────────────────────────────────────────────────
const sym = process.argv[2]?.toUpperCase();
if (!sym) {
  console.error('Usage: node scripts/add_indicator.mjs <SYM>');
  process.exit(1);
}

const pineFile = join(__dir, '..', `${sym.toLowerCase()}_trades_indicator.pine`);
if (!existsSync(pineFile)) {
  console.error(`Pine file not found: ${pineFile}`);
  process.exit(1);
}

// Title that appears in TV "My scripts" list
const scriptTitle = `${sym} Trades Plotter`;

// ── Find pane with <SYM> ─────────────────────────────────────────────────────
console.log(`Looking for pane with symbol ${sym}...`);

const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
const targets = await resp.json();

const chartPages = targets.filter(t =>
  t.type === 'page' &&
  /tradingview\.com\/chart/i.test(t.url) &&
  !t.url.startsWith('data:') &&
  !/tab-menu/i.test(t.url)
);

// Group by chart_id to avoid querying duplicate renderers
const byChart = new Map();
for (const t of chartPages) {
  const chartId = t.url.match(/\/chart\/([^/?]+)/)?.[1];
  if (!chartId) continue;
  if (!byChart.has(chartId)) byChart.set(chartId, { chartId, renderers: [] });
  byChart.get(chartId).renderers.push(t.id);
}

const PANES_EXPR = `(function() {
  try {
    var cwc = window.TradingViewApi._chartWidgetCollection;
    if (!cwc) return null;
    var all = cwc.getAll();
    var panes = [];
    for (var i = 0; i < all.length; i++) {
      try {
        var m = all[i].model ? all[i].model() : null;
        var ms = m ? m.mainSeries() : null;
        panes.push({ index: i, symbol: ms ? ms.symbol() : null });
      } catch(e) { panes.push({ index: i, symbol: null }); }
    }
    return panes;
  } catch(e) { return null; }
})()`;

let found = null;
for (const { chartId, renderers } of byChart.values()) {
  for (const rid of renderers) {
    const panes = await evaluateInTarget(rid, PANES_EXPR);
    if (!panes) continue;
    const match = panes.find(p => p.symbol && p.symbol.split(':').pop() === sym);
    if (match) {
      found = { chartId, rendererId: rid, paneIndex: match.index, symbol: match.symbol };
      break;
    }
  }
  if (found) break;
}

if (!found) {
  console.error(`No pane found with symbol ${sym}. Is the chart open?`);
  process.exit(1);
}

console.log(`Found: chart=${found.chartId} pane=${found.paneIndex} symbol=${found.symbol}`);

// ── Open CDP connection to that renderer ─────────────────────────────────────
const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: found.rendererId });
await client.Runtime.enable();

// ── Activate the pane ────────────────────────────────────────────────────────
const symRes = await client.Runtime.evaluate({
  expression: `(function() {
    var pane = window.TradingViewApi._chartWidgetCollection.getAll()[${found.paneIndex}];
    if (!pane || !pane._mainDiv) return 'no mainDiv';
    pane._mainDiv.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
    pane._mainDiv.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    return window.TradingViewApi._activeChartWidgetWV._value.symbol();
  })()`,
  returnByValue: true,
});
console.log('Activated pane, symbol:', symRes.result?.value);

const beforeRes = await client.Runtime.evaluate({
  expression: `window.TradingViewApi._activeChartWidgetWV._value.getAllStudies().map(s => ({id:s.id,name:s.name}))`,
  returnByValue: true,
});
const before = beforeRes.result?.value || [];
const alreadyAdded = before.find(s => s.name === scriptTitle);
if (alreadyAdded) {
  console.log(`"${scriptTitle}" is already on the chart (id: ${alreadyAdded.id}). Nothing to do.`);
  await client.close();
  process.exit(0);
}
console.log('Studies before:', before.length);

// ── Open Indicators dialog ───────────────────────────────────────────────────
const openedDialog = await client.Runtime.evaluate({
  expression: `(function() {
    // Try toolbar Indicators button
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var txt = btns[i].textContent.trim();
      if (txt === 'Indicators' && btns[i].offsetParent !== null) { btns[i].click(); return 'toolbar button'; }
    }
    // Try aria-label
    var btn2 = document.querySelector('[aria-label*="Indicators"]');
    if (btn2 && btn2.offsetParent !== null) { btn2.click(); return 'aria-label'; }
    return 'not found';
  })()`,
  returnByValue: true,
});
console.log('Open Indicators dialog:', openedDialog.result?.value);
await new Promise(r => setTimeout(r, 1500));

// ── Click "My scripts" tab ───────────────────────────────────────────────────
await client.Runtime.evaluate({
  expression: `(function() {
    var dialog = document.querySelector('[role="dialog"]') || document.querySelector('[class*="dialog"]') || document.querySelector('[class*="modal"]');
    if (!dialog) return;
    var walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
    var node;
    while (node = walker.nextNode()) {
      if (node.nodeValue.trim() === 'My scripts') {
        var el = node.parentElement;
        if (el && el.offsetParent !== null) { el.click(); return; }
      }
    }
  })()`,
  returnByValue: true,
});
await new Promise(r => setTimeout(r, 1000));

// Clear search to show all scripts
await client.Runtime.evaluate({
  expression: `(function() {
    var input = document.querySelector('input[placeholder*="earch"]');
    if (!input) return;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`,
  returnByValue: true,
});
await new Promise(r => setTimeout(r, 500));

// ── Find and click the script ────────────────────────────────────────────────
const clickRes = await client.Runtime.evaluate({
  expression: `(function() {
    var title = ${JSON.stringify(scriptTitle)};
    var sym = ${JSON.stringify(sym)};
    var dialog = document.querySelector('[role="dialog"]') || document.querySelector('[class*="dialog"]') || document.querySelector('[class*="modal"]');
    if (!dialog) return 'no dialog';

    // Walk all text nodes — try exact title, then "SYM Trades", then just SYM
    var patterns = [title, sym + ' Trades', sym];
    for (var pi = 0; pi < patterns.length; pi++) {
      var pat = patterns[pi];
      var walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
      var node;
      while (node = walker.nextNode()) {
        var val = node.nodeValue.trim();
        if (val === pat || val.startsWith(pat)) {
          node.parentElement.click();
          return 'clicked: "' + val.slice(0, 60) + '"';
        }
      }
    }
    return 'not found — dialog: ' + dialog.textContent.slice(0, 200);
  })()`,
  returnByValue: true,
});
console.log('Click script:', clickRes.result?.value);

await new Promise(r => setTimeout(r, 3000));

// Close dialog
await client.Runtime.evaluate({
  expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, keyCode: 27}))`,
  returnByValue: true,
});
await new Promise(r => setTimeout(r, 500));

// ── Verify ───────────────────────────────────────────────────────────────────
const afterRes = await client.Runtime.evaluate({
  expression: `window.TradingViewApi._activeChartWidgetWV._value.getAllStudies().map(s => ({id:s.id,name:s.name}))`,
  returnByValue: true,
});
const after = afterRes.result?.value || [];
const added = after.filter(s => !before.find(b => b.id === s.id));

if (added.length > 0) {
  console.log(`✓ Added: ${added.map(s => `"${s.name}" (${s.id})`).join(', ')}`);
} else {
  console.log('No new studies detected. Check that the script is saved in TV under "My scripts".');
}

await client.close();
