import CDP from 'chrome-remote-interface';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

let client = null;
let targetInfo = null;

function probeTcp(host, port) {
  // Synchronous best-effort TCP reachability check (WSL startup only). Uses bash's
  // /dev/tcp builtin so it needs no curl/nc. Returns true if the port accepts a connection.
  try {
    execSync(`timeout 1 bash -c ': < /dev/tcp/${host}/${port}'`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isWSL() {
  // WSL_DISTRO_NAME is the usual signal, but it's stripped under cron/minimal envs —
  // fall back to /proc/version which always contains "microsoft"/"WSL" on WSL.
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

function resolveHost() {
  if (process.env.CDP_HOST) return process.env.CDP_HOST;
  // In WSL2 the right host depends on the networking mode:
  //   * mirrored (networkingMode=mirrored): loopback is shared, so 127.0.0.1 reaches Windows CDP
  //   * NAT (default): 127.0.0.1 is WSL-local, so we must use the Windows gateway IP
  // Probe loopback first; fall back to the default-route gateway. CDP_HOST overrides both.
  if (isWSL()) {
    const port = parseInt(process.env.CDP_PORT || '9222', 10);
    if (probeTcp('127.0.0.1', port)) return '127.0.0.1';
    try {
      const gw = execSync("ip route show default", { encoding: 'utf8' })
        .match(/default via (\S+)/)?.[1];
      if (gw) return gw;
    } catch {}
  }
  return 'localhost';
}

export const CDP_HOST = resolveHost();
export const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV._value',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV._value._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}${connectHint()}`);
}

// Append a targeted hint for the most common WSL2 failure mode: TradingView is
// running with the debug flag, but a portproxy bound to 0.0.0.0 is shadowing
// loopback (or there's no proxy at all), so CDP never becomes reachable.
function connectHint() {
  if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME && !process.env.CDP_HOST) {
    return ` (WSL2: CDP unreachable at ${CDP_HOST}:${CDP_PORT}. Re-run scripts/launch_msix_debug.ps1 on Windows`
      + ` — a portproxy bound to 0.0.0.0 shadows loopback so CDP never binds.`
      + ` See docs/WINDOWS_WSL2_SETUP.md.)`;
  }
  return '';
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
