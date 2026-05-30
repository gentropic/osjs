/**
 * @module io/openstereo — best-effort importer for OpenStereo `.openstereo`
 * projects (the manifest + per-layer `.os_lyr` settings + bundled data files).
 *
 * Input is the unzipped map { filename: Uint8Array | string }. We map what OSJS
 * understands — planes / lines / small circles / azimuth (→ lines), groups, and
 * single-datum items (attitude parsed from the layer name) — carrying over basic
 * styling and which sub-layers were on. Relational faults, slope kinematics, arcs,
 * `.xlsx` data, and files that live outside a (non-packed) project are skipped and
 * reported in `.skipped`. Returns a serializeProject()-shaped object for loadProject().
 */

import { parseTable } from './parse.js';

const asText = (v) => (typeof v === 'string' ? v : new TextDecoder().decode(v));
const basename = (p) => String(p).split(/[\\/]/).pop();
const num = (s) => parseFloat(s);

// OpenStereo data_type (the .os_lyr top key) → OSJS item type (null = unsupported)
const TYPE_MAP = {
  plane_data: 'planes', singleplane_data: 'planes', slope_data: 'planes',
  line_data: 'lines', singleline_data: 'lines', circular_data: 'lines',
  smallcircle_data: 'smallcircle', singlesc_data: 'smallcircle', singlesmallcircle_data: 'smallcircle',
};

const numbersIn = (s) => (String(s).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

function measurementsFromData(dtype, kwargs, text) {
  const table = parseTable(text);
  let rows = table.rows;
  if (kwargs.skip_rows) rows = rows.slice(kwargs.skip_rows);
  const dd = kwargs.dipdir_column ?? 0, dp = kwargs.dip_column ?? 1, al = kwargs.alpha_column ?? 2;
  const strike = kwargs.dip_direction === false;     // azimuth stored as strike (RHR)
  const out = [];
  for (const r of rows) {
    const a = num(r[dd]), b = num(r[dp]);
    if (dtype === 'smallcircle_data') { const c = num(r[al]); if ([a, b, c].every(Number.isFinite)) out.push([a, b, c]); continue; }
    if (dtype === 'circular_data') { if (Number.isFinite(a)) out.push([a, 0]); continue; }   // azimuth → horizontal line
    if (![a, b].every(Number.isFinite)) continue;
    out.push(dtype.startsWith('plane') && strike ? [(a + 90) % 360, b] : [a, b]);
  }
  return out;
}

function measurementsFromName(osjsType, name) {
  const n = numbersIn(name);
  if (n.length < 2) return [];
  return [osjsType === 'smallcircle' ? [n[0], n[1], n[2] ?? 30] : [n[0], n[1]]];
}

function mapStyle(body, osjsType) {
  const pt = body.point_settings || body.scaxis_settings || {};
  const gc = body.GC_settings || body.sccirc_settings || {};
  const color = (osjsType === 'planes' ? gc.colors : pt.c) || pt.c || gc.colors || '#888888';
  return { color, size: pt.ms ?? 4, width: gc.linewidths ?? 1 };
}

function mapLayersAndParams(item, body, osjsType) {
  const plots = item.checked_plots || {};
  const layers = {};
  const set = (label, key) => { if (label in plots) layers[key] = !!plots[label]; };
  if (osjsType === 'planes') { set('Poles', 'poles'); set('Great Circles', 'great'); set('Pole', 'poles'); set('Great Circle', 'great'); }
  if (osjsType === 'lines') { set('Lines', 'points'); set('Point', 'points'); }
  if (osjsType === 'smallcircle') { set('Axis', 'axes'); set('Axes', 'axes'); set('Small Circles', 'circles'); set('Small Circle', 'circles'); }
  set('Contours', 'contours'); set('Eigenvectors', 'eigen');
  const params = {};
  const cs = body.check_settings;
  if (cs) {
    params.eigPole = [!!cs.v1point, !!cs.v2point, !!cs.v3point];
    params.eigPlane = [!!cs.v1GC, !!cs.v2GC, !!cs.v3GC];
    if (params.eigPole.some(Boolean) || params.eigPlane.some(Boolean)) layers.eigen = true;
    if (cs.meanpoint) layers.mean = true;
  }
  return { layers, params };
}

function mapItem(item, files, skipped) {
  const lyrName = item.layer_settings_file;
  const lyrRaw = lyrName && files[lyrName] != null ? JSON.parse(asText(files[lyrName])) : null;
  const dtype = lyrRaw ? Object.keys(lyrRaw)[0] : (item.kwargs ? (item.kwargs.line ? 'line_data' : 'plane_data') : null);
  const osjsType = dtype && TYPE_MAP[dtype];
  if (!osjsType) { skipped.push(item.name); return null; }       // fault / arc / slope-kinematics / unknown
  const body = (lyrRaw && lyrRaw[dtype]) || {};

  let measurements;
  if (item.kwargs && item.path) {
    const data = files[item.path] || files[basename(item.path)] || files[String(item.path).replace(/\\/g, '/')];
    if (!data) { skipped.push(`${item.name} (data not bundled)`); return null; }
    if (/\.xlsx?$/i.test(item.path)) { skipped.push(`${item.name} (.xls/.xlsx unsupported)`); return null; }
    measurements = measurementsFromData(dtype, item.kwargs, asText(data));
  } else {
    measurements = measurementsFromName(osjsType, item.name);     // synthetic single-datum item
  }
  if (!measurements.length) { skipped.push(`${item.name} (no readable data)`); return null; }

  const { layers, params } = mapLayersAndParams(item, body, osjsType);
  return { type: osjsType, name: item.name, visible: item.checked !== false, measurements, columns: [], style: mapStyle(body, osjsType), params, layers };
}

function walk(items, files, skipped) {
  const out = [];
  for (const item of items || []) {
    if (item.items) out.push({ kind: 'group', name: item.name, visible: item.checked !== false, expanded: true, children: walk(item.items, files, skipped) });
    else { const node = mapItem(item, files, skipped); if (node) out.push(node); }
  }
  return out;
}

/**
 * Parse an unzipped `.openstereo` (map of filename → bytes/text) into a project.
 * @returns {{ format:'osjs-project', version:number, projection:string, items:Array, skipped:string[] }}
 */
export function parseOpenStereo(files) {
  const manifest = JSON.parse(asText(files['project_data.json'] ?? files[Object.keys(files).find((k) => k.endsWith('project_data.json'))]));
  const g = (manifest.global_settings && manifest.global_settings.general_settings) || {};
  const projection = /angle/i.test(g.projection || '') ? 'equal-angle' : 'equal-area';
  const skipped = [];
  const items = walk(manifest.items, files, skipped);
  return { format: 'osjs-project', version: 2, projection, items, skipped };
}
