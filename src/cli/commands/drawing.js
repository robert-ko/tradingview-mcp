import { register } from '../router.js';
import * as core from '../../core/drawing.js';

register('draw', {
  description: 'Drawing tools (shape, list, get, remove, clear)',
  subcommands: new Map([
    ['shape', {
      description: 'Draw a shape on the chart',
      options: {
        type: { type: 'string', short: 't', description: 'Shape type: horizontal_line, trend_line, rectangle, circle, ellipse, text, icon, arrow_up, arrow_down, flag, balloon, brush, highlighter, vertical_line, price_label' },
        price: { type: 'string', short: 'p', description: 'Price level' },
        time: { type: 'string', description: 'Unix timestamp' },
        price2: { type: 'string', description: 'Second point price (for trend_line, rectangle)' },
        time2: { type: 'string', description: 'Second point time (for trend_line, rectangle)' },
        text: { type: 'string', description: 'Text content (for text shapes)' },
        overrides: { type: 'string', description: 'JSON style overrides' },
        chart: { type: 'string', short: 'c', description: 'Chart layout ID (e.g. OrGYLj5W)' },
        pane: { type: 'string', description: 'Pane index within the chart' },
      },
      handler: (opts) => {
        const point = { time: Number(opts.time), price: Number(opts.price) };
        const point2 = opts.price2 ? { time: Number(opts.time2), price: Number(opts.price2) } : undefined;
        return core.drawShape({
          shape: opts.type || 'horizontal_line',
          point, point2,
          overrides: opts.overrides,
          text: opts.text,
          chartId: opts.chart,
          paneIndex: opts.pane != null ? Number(opts.pane) : undefined,
        });
      },
    }],
    ['list', {
      description: 'List all drawings on the chart',
      handler: () => core.listDrawings(),
    }],
    ['get', {
      description: 'Get properties of a drawing',
      handler: (opts, positionals) => core.getProperties({ entity_id: positionals[0] }),
    }],
    ['remove', {
      description: 'Remove a drawing by entity ID',
      handler: (opts, positionals) => core.removeOne({ entity_id: positionals[0] }),
    }],
    ['clear', {
      description: 'Remove all drawings',
      handler: () => core.clearAll(),
    }],
  ]),
});
