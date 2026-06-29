import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['delete', {
      description: 'Delete alerts (--ids 1,2,3 | --inactive | --all)',
      options: {
        ids: { type: 'string', description: 'Comma-separated alert IDs to delete' },
        inactive: { type: 'boolean', description: 'Delete all inactive (triggered/disabled) alerts, keep active' },
        all: { type: 'boolean', description: 'Delete ALL alerts (active included)' },
      },
      handler: (opts) => core.deleteAlerts({
        alert_ids: opts.ids ? opts.ids.split(',').map((s) => Number(s.trim())) : undefined,
        delete_inactive: opts.inactive,
        delete_all: opts.all,
      }),
    }],
    ['disable', {
      description: 'Pause alerts (--ids 1,2,3 | --all to pause every active alert)',
      options: {
        ids: { type: 'string', description: 'Comma-separated alert IDs to pause' },
        all: { type: 'boolean', description: 'Pause all currently-active alerts' },
      },
      handler: (opts) => core.setAlertsActive({
        alert_ids: opts.ids ? opts.ids.split(',').map((s) => Number(s.trim())) : [],
        all: opts.all,
        active: false,
      }),
    }],
    ['enable', {
      description: 'Re-enable alerts (--ids 1,2,3 | --all to re-enable every paused alert)',
      options: {
        ids: { type: 'string', description: 'Comma-separated alert IDs to re-enable' },
        all: { type: 'boolean', description: 'Re-enable all currently-inactive alerts' },
      },
      handler: (opts) => core.setAlertsActive({
        alert_ids: opts.ids ? opts.ids.split(',').map((s) => Number(s.trim())) : [],
        all: opts.all,
        active: true,
      }),
    }],
  ]),
});
