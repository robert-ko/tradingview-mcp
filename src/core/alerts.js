/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

export async function create({ condition, price, message }) {
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], ${safeString(String(price))});
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], ${safeString(String(price))});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, source: 'dom_fallback' };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

const DELETE_URL = 'https://pricealerts.tradingview.com/delete_alerts';

// Delete a batch of alert ids via the pricealerts REST API (the same call the TV web UI
// makes). IMPORTANT: the body is JSON but we must NOT set a Content-Type header — a JSON
// content-type triggers a cross-origin CORS preflight (chart page -> pricealerts subdomain)
// that the endpoint rejects ("Failed to fetch"). Omitting it sends text/plain, a CORS
// "simple request" (no preflight). Body shape is {"payload":{"alert_ids":[...]}}.
async function deleteIdBatch(ids) {
  return evaluateAsync(`
    fetch(${safeString(DELETE_URL)}, {
      method: 'POST', credentials: 'include',
      body: JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } })
    })
      .then(function(r) { return r.json(); })
      .then(function(j) { return (j && j.s) || 'no_status'; })
      .catch(function(e) { return 'fetch_error:' + e.message; })
  `);
}

/**
 * Delete alerts. Provide one of:
 *   alert_ids: [id, ...]   — delete specific alerts
 *   delete_inactive: true  — delete all inactive (triggered/disabled) alerts, keep active
 *   delete_all: true       — delete ALL alerts (active included)
 * Deletes in chunks of 100 and returns { success, deleted }.
 */
export async function deleteAlerts({ alert_ids, delete_inactive, delete_all } = {}) {
  let ids;
  if (Array.isArray(alert_ids) && alert_ids.length) {
    ids = alert_ids.map(Number).filter(Number.isFinite);
  } else if (delete_inactive || delete_all) {
    const { alerts } = await list();
    ids = alerts.filter(a => (delete_all ? true : !a.active)).map(a => a.alert_id);
  } else {
    throw new Error('Specify alert_ids: [...], delete_inactive: true, or delete_all: true');
  }
  if (ids.length === 0) return { success: true, deleted: 0, note: 'no matching alerts to delete' };

  const CHUNK = 100;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const status = await deleteIdBatch(batch);
    if (status !== 'ok') {
      return { success: false, deleted, error: `delete_alerts returned "${status}" after ${deleted} deleted`, source: 'pricealerts_api' };
    }
    deleted += batch.length;
  }
  return { success: true, deleted, source: 'pricealerts_api' };
}

const STOP_URL = 'https://pricealerts.tradingview.com/stop_alerts';
const RESTART_URL = 'https://pricealerts.tradingview.com/restart_alerts';

/**
 * Pause (active=false → stop_alerts) or re-enable (active=true → restart_alerts) alerts.
 * Provide `alert_ids: [...]`, or `all: true` to target every alert in the relevant state
 * (disable → all currently-active; enable → all currently-inactive). Same pricealerts API
 * + no-Content-Type trick as deleteAlerts. Chunks of 100.
 */
export async function setAlertsActive({ alert_ids, active, all } = {}) {
  let ids;
  if (all) {
    const { alerts } = await list();
    // disable → only the ones currently active; enable → only the ones currently inactive
    ids = alerts.filter(a => (active ? !a.active : a.active)).map(a => a.alert_id);
  } else if (Array.isArray(alert_ids) && alert_ids.length) {
    ids = alert_ids.map(Number).filter(Number.isFinite);
  } else {
    throw new Error('Provide alert_ids: [...] or all: true');
  }
  if (ids.length === 0) return { success: true, changed: 0, active, note: 'no alerts to change', source: 'pricealerts_api' };
  const url = active ? RESTART_URL : STOP_URL;
  const CHUNK = 100;
  let changed = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const status = await evaluateAsync(`
      fetch(${safeString(url)}, {
        method: 'POST', credentials: 'include',
        body: JSON.stringify({ payload: { alert_ids: ${JSON.stringify(batch)} } })
      })
        .then(function(r) { return r.json(); })
        .then(function(j) { return (j && j.s) || 'no_status'; })
        .catch(function(e) { return 'fetch_error:' + e.message; })
    `);
    if (status !== 'ok') {
      return { success: false, changed, error: `${active ? 'restart' : 'stop'}_alerts returned "${status}" after ${changed}`, source: 'pricealerts_api' };
    }
    changed += batch.length;
  }
  return { success: true, changed, active, source: 'pricealerts_api' };
}
