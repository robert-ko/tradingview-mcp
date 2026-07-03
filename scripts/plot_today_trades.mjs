#!/usr/bin/env node
/**
 * plot_today_trades.mjs  --  after-market automation (v2: update saved scripts in place)
 *
 * 1. Runs the trade_plotter generator:  ./trade_indicator_generator.py --log
 * 2. Detects which <sym>_trades_indicator.pine files it (re)wrote = today's traded symbols.
 * 3. If none -> no trades today -> does nothing.
 * 4. For each symbol: opens the saved "<SYM> Trades Plotter" Pine script, replaces its source
 *    with today's, and SAVES IN PLACE (Ctrl+S). Any chart study bound to that saved script
 *    auto-refreshes with today's trades — no "Add to chart", no unsaved "My script", no
 *    duplicate accumulation.
 *
 * Why v2: the old version added the *unsaved* editor script via "Add to chart", which in the
 * current TradingView build silently added the blank default template (indicator("My script")
 * / plot(close)) instead of the trades — so charts showed no update — and the save-name dialog
 * spawned "<SYM> Trades Plotter 1" duplicate scripts. Updating the saved script sidesteps both
 * and is chart/pane independent (validated: open->set->save leaves exactly one saved script).
 *
 * ONE-TIME per symbol: the "<SYM> Trades Plotter" study must already be on your chart, bound to
 * the saved script (add it once via Indicators -> My scripts). After that it updates every day.
 * A symbol with no saved "<SYM> Trades Plotter" script is reported and skipped (never auto-named,
 * to avoid creating junk/duplicates).
 *
 * Env overrides:
 *   TRADE_PLOTTER_DIR   (default /home/robert/Dropbox_Projects/tradingview-trade_plotter)
 *   SUCCESSTRADER_LOG_DIR (default "/mnt/c/SuccessTrader Pro_x64/LOG")
 *   PYTHON              (default the tv_env venv python — needs pandas)
 */
import { spawnSync } from 'child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CDP_HOST, CDP_PORT } from '../src/connection.js';
import { list as listTabs, switchTab } from '../src/core/tab.js';
import { ensurePineEditorOpen, openScript, setSource, save, listScripts } from '../src/core/pine.js';

const PLOTTER_DIR = process.env.TRADE_PLOTTER_DIR || '/home/robert/Dropbox_Projects/tradingview-trade_plotter';
const LOG_DIR = process.env.SUCCESSTRADER_LOG_DIR || '/mnt/c/SuccessTrader Pro_x64/LOG';
// The generator needs pandas, which lives in this venv (not /usr/bin/python3 that cron's
// minimal PATH would otherwise pick). Override with the PYTHON env var if it moves.
const PYTHON = process.env.PYTHON || '/mnt/c/Users/Robert/Dropbox/Projects/pyenvs/tv_env/bin/python3';
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
  // freshly (re)written pine files = today's symbols
  const symbols = readdirSync(PLOTTER_DIR)
    .filter(f => /_trades_indicator\.pine$/.test(f))
    .filter(f => statSync(join(PLOTTER_DIR, f)).mtimeMs >= startMs - 1500)
    .map(f => ({ sym: f.replace('_trades_indicator.pine', '').toUpperCase(), file: join(PLOTTER_DIR, f) }));
  return { ok: true, symbols };
}

// ── 2. Update the saved "<SYM> Trades Plotter" script in place ───────────────
async function updateSaved(sym, code, savedNames) {
  const name = scriptName(sym);
  // guard: only touch symbols that already have a saved script (avoid creating junk)
  const exists = savedNames.some(n => n.toLowerCase() === name.toLowerCase());
  if (!exists) return { ok: false, name, skipped: true, error: 'no saved script — add it to a chart once via Indicators → My scripts' };

  const opened = await openScript({ name });   // fetch saved source + bind the editor to it
  await sleep(500);
  await setSource({ source: code });           // replace with today's trades
  await sleep(400);
  const s = await save();                       // Ctrl+S -> in-place update (no dialog for a bound script)
  await sleep(900);

  // dup guard: if a "<SYM> Trades Plotter 1" (etc.) appeared, the save wasn't in place
  const after = (await listScripts()).scripts
    .map(x => x.name).filter(n => new RegExp('^' + sym + ' Trades Plotter( \\d+)?$', 'i').test(n));
  return { ok: after.length === 1, name: opened.name, id: opened.script_id, save: s.action, matches: after };
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
    log(`ERROR: TradingView CDP not reachable at ${CDP_HOST}:${CDP_PORT} — is TradingView open with --remote-debugging-port? Skipping. (${e.message})`);
    process.exit(1);
  }

  // Need a foreground chart tab so the Pine editor is available; a backgrounded Electron tab won't open it.
  const tabs = await listTabs();
  if (!tabs.tabs.length) { log('ERROR: no chart tabs open.'); process.exit(1); }
  await switchTab({ index: 0 });
  await sleep(1500);
  if (!(await ensurePineEditorOpen())) { log('ERROR: could not open the Pine editor.'); process.exit(1); }

  const saved = (await listScripts()).scripts.map(s => s.name);

  let okN = 0, failN = 0, skipN = 0;
  for (const { sym, file } of symbols) {
    try {
      const code = readFileSync(file, 'utf8');
      const res = await updateSaved(sym, code, saved);
      if (res.skipped) { log(`${sym}: SKIP — ${res.error}`); skipN++; }
      else if (res.ok) { log(`${sym}: updated saved "${res.name}" (${res.id}) in place [${res.save}]`); okN++; }
      else { log(`${sym}: WARN save may not be in place — scripts now: ${JSON.stringify(res.matches)}`); failN++; }
    } catch (e) {
      log(`${sym}: ERROR ${e.message}`); failN++;
    }
  }
  log(`Done. ${okN} updated, ${skipN} skipped (no saved script), ${failN} failed, of ${symbols.length} symbols.`);
  process.exit(failN > 0 ? 1 : 0);
})();
