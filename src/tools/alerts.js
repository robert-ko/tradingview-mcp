import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete alerts: specific IDs, all inactive (triggered/disabled), or all', {
    alert_ids: z.array(z.coerce.number()).optional().describe('Specific alert IDs to delete'),
    delete_inactive: z.coerce.boolean().optional().describe('Delete all inactive (triggered/disabled) alerts, keep active'),
    delete_all: z.coerce.boolean().optional().describe('Delete ALL alerts (active included)'),
  }, async ({ alert_ids, delete_inactive, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_ids, delete_inactive, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_set_active', 'Pause (active=false) or re-enable (active=true) existing alerts by id', {
    alert_ids: z.array(z.coerce.number()).describe('Alert IDs to pause/re-enable'),
    active: z.coerce.boolean().describe('true = re-enable (restart), false = pause (stop)'),
  }, async ({ alert_ids, active }) => {
    try { return jsonResult(await core.setAlertsActive({ alert_ids, active })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
