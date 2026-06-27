import { register } from '../router.js';
import * as core from '../../core/data.js';

register('quote', {
  description: 'Get real-time price quote',
  options: {
    chart: { type: 'string', short: 'c', description: 'Chart layout ID (e.g. OrGYLj5W) to query without switching focus' },
    pane: { type: 'string', short: 'p', description: 'Pane index within the chart (default 0)' },
  },
  handler: (opts, positionals) => core.getQuote({
    symbol: positionals[0],
    chartId: opts.chart,
    paneIndex: opts.pane != null ? Number(opts.pane) : undefined,
  }),
});

register('ohlcv', {
  description: 'Get OHLCV bar data',
  options: {
    count: { type: 'string', short: 'n', description: 'Number of bars (default 100, max 500)' },
    summary: { type: 'boolean', short: 's', description: 'Return summary stats instead of all bars' },
  },
  handler: (opts) => core.getOhlcv({
    count: opts.count ? Number(opts.count) : undefined,
    summary: opts.summary,
  }),
});

register('values', {
  description: 'Get current indicator values from data window',
  handler: () => core.getStudyValues(),
});

register('data', {
  description: 'Advanced data tools (lines, labels, tables, boxes, strategy, trades, equity, depth)',
  subcommands: new Map([
    ['levels', {
      description: 'Get price levels with labels (lines + labels joined by price)',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        chart: { type: 'string', short: 'c', description: 'Chart layout ID' },
        pane: { type: 'string', short: 'p', description: 'Pane index (default: active pane)' },
        table: { type: 'boolean', short: 't', description: 'Print as human-readable table' },
      },
      handler: async (opts) => {
        const data = await core.getPaneLevels({
          study_filter: opts.filter,
          chartId: opts.chart,
          paneIndex: opts.pane != null ? Number(opts.pane) : undefined,
        });
        if (!opts.table) return data;
        const col = (s, w) => String(s ?? '').padEnd(w);
        const lines = [col('price', 12) + 'label'];
        lines.push('─'.repeat(32));
        for (const l of data.levels) {
          lines.push(col(l.price, 12) + (l.label || ''));
        }
        return lines.join('\n');
      },
    }],
    ['lines', {
      description: 'Get Pine Script line.new() price levels',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw line data' },
        chart: { type: 'string', short: 'c', description: 'Chart layout ID to query without switching focus' },
        pane: { type: 'string', short: 'p', description: 'Pane index within the chart (default: active pane)' },
      },
      handler: (opts) => core.getPineLines({ study_filter: opts.filter, verbose: opts.verbose, chartId: opts.chart, paneIndex: opts.pane != null ? Number(opts.pane) : undefined }),
    }],
    ['labels', {
      description: 'Get Pine Script label.new() annotations',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        max: { type: 'string', short: 'n', description: 'Max labels per study (default 50)' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw label data' },
        chart: { type: 'string', short: 'c', description: 'Chart layout ID to query without switching focus' },
        pane: { type: 'string', short: 'p', description: 'Pane index within the chart (default: active pane)' },
      },
      handler: (opts) => core.getPineLabels({ study_filter: opts.filter, max_labels: opts.max ? Number(opts.max) : undefined, verbose: opts.verbose, chartId: opts.chart, paneIndex: opts.pane != null ? Number(opts.pane) : undefined }),
    }],
    ['tables', {
      description: 'Get Pine Script table.new() data',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        chart: { type: 'string', short: 'c', description: 'Chart layout ID to query without switching focus' },
        pane: { type: 'string', short: 'p', description: 'Pane index within the chart (default: active pane)' },
      },
      handler: (opts) => core.getPineTables({ study_filter: opts.filter, chartId: opts.chart, paneIndex: opts.pane != null ? Number(opts.pane) : undefined }),
    }],
    ['boxes', {
      description: 'Get Pine Script box.new() price zones',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw box data' },
        chart: { type: 'string', short: 'c', description: 'Chart layout ID to query without switching focus' },
        pane: { type: 'string', short: 'p', description: 'Pane index within the chart (default: active pane)' },
      },
      handler: (opts) => core.getPineBoxes({ study_filter: opts.filter, verbose: opts.verbose, chartId: opts.chart, paneIndex: opts.pane != null ? Number(opts.pane) : undefined }),
    }],
    ['strategy', {
      description: 'Get strategy performance metrics',
      handler: () => core.getStrategyResults(),
    }],
    ['trades', {
      description: 'Get strategy trade list',
      options: {
        max: { type: 'string', short: 'n', description: 'Max trades to return' },
      },
      handler: (opts) => core.getTrades({ max_trades: opts.max ? Number(opts.max) : undefined }),
    }],
    ['equity', {
      description: 'Get strategy equity curve',
      handler: () => core.getEquity(),
    }],
    ['depth', {
      description: 'Get order book / DOM data',
      handler: () => core.getDepth(),
    }],
    ['indicator', {
      description: 'Get indicator info and inputs by entity ID',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Entity ID required. Usage: tv data indicator eFu1Ot');
        return core.getIndicator({ entity_id: positionals[0] });
      },
    }],
    ['indicators', {
      description: 'List all indicators on a pane',
      options: {
        chart: { type: 'string', short: 'c', description: 'Chart layout ID (e.g. OrGYLj5W)' },
        pane: { type: 'string', short: 'p', description: 'Pane index (default: active pane)' },
      },
      handler: (opts) => core.getPaneIndicators({
        chartId: opts.chart,
        paneIndex: opts.pane != null ? Number(opts.pane) : undefined,
      }),
    }],
  ]),
});
