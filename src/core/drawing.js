/**
 * Core drawing logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';
import { evaluateInChart } from './tab.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

/**
 * Build a JS snippet that activates pane N (via DOM click on its mainDiv),
 * runs the drawing call, then restores the previous active pane.
 */
function buildDrawExpr({ shape, p1time, p1price, p2time, p2price, overridesStr, textStr, paneIndex }) {
  const paneActivation = paneIndex != null ? `
    var _cwc = window.TradingViewApi._chartWidgetCollection;
    var _targetPane = _cwc.getAll()[${paneIndex}];
    var _activeApi = window.TradingViewApi._activeChartWidgetWV._value;
    if (_targetPane && _activeApi._chartWidget !== _targetPane) {
      var _div = _targetPane._mainDiv;
      if (_div) {
        _div.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
        _div.dispatchEvent(new MouseEvent('click', {bubbles:true}));
      }
    }
  ` : '';

  const api = `window.TradingViewApi._activeChartWidgetWV._value`;
  const drawCall = p2time != null
    ? `${api}.createMultipointShape([{time:${p1time},price:${p1price}},{time:${p2time},price:${p2price}}],{shape:${safeString(shape)},overrides:${overridesStr},text:${textStr}})`
    : `${api}.createShape({time:${p1time},price:${p1price}},{shape:${safeString(shape)},overrides:${overridesStr},text:${textStr}})`;

  return `(async function(){
    ${paneActivation}
    var _before = ${api}.getAllShapes().map(function(s){return s.id;});
    await ${drawCall};
    var _after = ${api}.getAllShapes().map(function(s){return s.id;});
    return _after.find(function(id){return _before.indexOf(id)===-1;}) || null;
  })()`;
}

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text, chartId, paneIndex, _deps }) {
  const { evaluate } = _resolve(_deps);
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const p1time = requireFinite(point.time, 'point.time');
  const p1price = requireFinite(point.price, 'point.price');
  const p2time = point2 ? requireFinite(point2.time, 'point2.time') : null;
  const p2price = point2 ? requireFinite(point2.price, 'point2.price') : null;

  const expr = buildDrawExpr({ shape, p1time, p1price, p2time, p2price, overridesStr, textStr, paneIndex });

  const newId = chartId
    ? await evaluateInChart(chartId, expr, { awaitPromise: true })
    : await _evaluateAsync(expr);

  return { success: true, shape, entity_id: newId || null };
}

export async function listDrawings() {
  const apiPath = await _getChartApi();
  const shapes = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll() {
  const apiPath = await _getChartApi();
  await _evaluate(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}
