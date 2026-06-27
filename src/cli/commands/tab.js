import { register } from '../router.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List all open chart tabs',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new chart tab',
      handler: () => core.newTab(),
    }],
    ['close', {
      description: 'Close the current tab',
      handler: () => core.closeTab(),
    }],
    ['switch', {
      description: 'Switch to a tab by index',
      handler: (opts, positionals) => {
        if (positionals[0] === undefined) throw new Error('Index required. Usage: tv tab switch 0');
        return core.switchTab({ index: positionals[0] });
      },
    }],
    ['windows', {
      description: 'List all TV windows and tabs with pane symbols',
      options: {
        table: { type: 'boolean', short: 't', description: 'Print as human-readable table instead of JSON' },
      },
      handler: async (opts) => {
        const data = await core.listWindows();
        if (!opts.table) return data;

        const lines = [];
        const wins = data.windows.map(w => w.windowId).join(' · ');
        lines.push(`${data.windows.length} Windows: ${wins}`);
        lines.push('');

        const col = (s, w) => String(s ?? '').padEnd(w);
        const hdr = col('chart_id', 12) + col('layout', 8) + col('TF', 6) + col('pane', 6) + 'symbol';
        const sep = '─'.repeat(hdr.length);
        lines.push(hdr);
        lines.push(sep);

        for (const tab of data.tabs) {
          if (tab.type !== 'chart') {
            lines.push(col('', 12) + col('', 8) + col('', 6) + col('', 6) + `[page] ${tab.title || ''}`);
            continue;
          }
          const tf = tab.panes[0]?.resolution ?? '?';
          tab.panes.forEach((p, i) => {
            const chartCol = i === 0 ? col(tab.chart_id, 12) : col('', 12);
            const layoutCol = i === 0 ? col(tab.layout, 8) : col('', 8);
            const tfCol = i === 0 ? col(tf, 6) : col('', 6);
            lines.push(chartCol + layoutCol + tfCol + col(i, 6) + (p.symbol ?? ''));
          });
          lines.push(sep);
        }
        return lines.join('\n');
      },
    }],
  ]),
});
