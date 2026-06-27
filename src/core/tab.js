/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import CDP from 'chrome-remote-interface';
import { getClient, evaluate, CDP_HOST, CDP_PORT } from '../connection.js';

/**
 * Open a temporary CDP connection to a specific target, evaluate an expression, then close.
 */
export async function evaluateInTarget(targetId, expression, { awaitPromise = false } = {}) {
  let client;
  try {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    await client.Runtime.enable();
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise,
      timeout: 10000,
    });
    if (exceptionDetails) return null;
    return result.value ?? null;
  } catch {
    return null;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  // Verify a new tab appeared
  const state = await list();
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  // Use CDP Target.activateTarget to bring the tab to front
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    const text = await resp.text();
    return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}

/**
 * Find a live renderer target ID for a given chart layout ID.
 * Tries each renderer until one has TradingViewApi loaded.
 */
export async function resolveRenderer(chartId) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const renderers = targets.filter(t =>
    t.type === 'page' && t.url.includes(`/chart/${chartId}/`)
  );
  if (renderers.length === 0) throw new Error(`No renderer found for chart "${chartId}"`);

  for (const r of renderers) {
    const ok = await evaluateInTarget(r.id, 'typeof window.TradingViewApi !== "undefined" ? true : null');
    if (ok) return r.id;
  }
  throw new Error(`Chart "${chartId}" found but TradingViewApi not loaded in any renderer`);
}

/**
 * Evaluate a JS expression in the context of a specific chart tab (by layout ID).
 */
export async function evaluateInChart(chartId, expression, opts = {}) {
  const rendererId = await resolveRenderer(chartId);
  return evaluateInTarget(rendererId, expression, opts);
}

/**
 * List all TradingView windows and their tabs, with symbols for each pane.
 * Groups chart tabs by window using Electron instance IDs from the tabbed-window shells.
 */
export async function listWindows() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  // Extract the 3 window shells and their instance IDs
  // URL is encoded: remoteServiceInstanceId%22%3A%22<uuid>-tvd:tabbed-window
  const windowShells = [];
  const seenInstances = new Set();
  for (const t of targets) {
    if (!t.url.includes('tabbed-window')) continue;
    // Only the main window shell (app/window/index.html), not tooltip companions
    if (!t.url.includes('/window/index.html')) continue;
    let decoded;
    try { decoded = decodeURIComponent(t.url); } catch { decoded = t.url; }
    const m = decoded.match(/"remoteServiceInstanceId"\s*:\s*"([a-f0-9\-]+)-tvd/);
    const instanceId = m?.[1] || t.id.slice(0, 8);
    if (seenInstances.has(instanceId)) continue;
    seenInstances.add(instanceId);
    windowShells.push({ windowId: instanceId, shellTargetId: t.id });
  }

  const windowCount = windowShells.length;

  // Collect all unique TV page targets grouped by layout/page key
  // Exclude Electron UI targets (context menus, tooltips) that match tradingview.com but aren't real pages
  const tvPages = targets.filter(t =>
    t.type === 'page' &&
    /tradingview\.com/i.test(t.url) &&
    !t.url.startsWith('data:') &&
    !/tab-menu/i.test(t.url) &&
    !/[?&]contextmenu/i.test(t.url) &&
    (t.title ? !t.title.startsWith('<') : true)
  );
  const byKey = new Map();
  for (const t of tvPages) {
    const chartId = t.url.match(/\/chart\/([^/?]+)/)?.[1];
    const key = chartId || t.url.replace(/[?#].*/, ''); // use base URL for non-chart pages
    if (!byKey.has(key)) byKey.set(key, { key, chartId: chartId || null, renderers: [], url: t.url, title: t.title });
    byKey.get(key).renderers.push(t.id);
  }

  // JS to query all panes in a chart target
  const PANES_EXPR = `(function() {
    try {
      var cwc = window.TradingViewApi._chartWidgetCollection;
      if (!cwc) return null;
      var lt = cwc._layoutType;
      if (lt && typeof lt.value === 'function') lt = lt.value();
      var all = cwc.getAll();
      var panes = [];
      for (var i = 0; i < all.length; i++) {
        try {
          var m = all[i].model ? all[i].model() : null;
          var ms = m ? m.mainSeries() : null;
          panes.push({ index: i, symbol: ms ? ms.symbol() : null, resolution: ms ? ms.interval() : null });
        } catch(e) { panes.push({ index: i, symbol: null, resolution: null }); }
      }
      return { layout: lt, panes: panes };
    } catch(e) { return null; }
  })()`;

  // Query all pages in parallel
  const tabResults = await Promise.all([...byKey.values()].map(async (entry) => {
    let panesData = null;

    if (entry.chartId) {
      for (const renderId of entry.renderers) {
        panesData = await evaluateInTarget(renderId, PANES_EXPR);
        if (panesData) break;
      }
    }

    // renderer_count capped at window count — stale renderers from closed windows inflate this
    const renderer_count = Math.min(entry.renderers.length, windowCount);

    return {
      chart_id: entry.chartId,
      type: entry.chartId ? 'chart' : 'page',
      title: entry.chartId ? null : entry.title || entry.url,
      renderer_count,
      layout: panesData?.layout || null,
      panes: panesData?.panes || [],
    };
  }));

  // Sort: charts first (by pane count), then other pages
  tabResults.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'chart' ? -1 : 1;
    return b.panes.length - a.panes.length;
  });

  return {
    success: true,
    windows: windowShells.map((w, i) => ({ index: i + 1, windowId: w.windowId })),
    tab_count: tabResults.length,
    tabs: tabResults,
  };
}
