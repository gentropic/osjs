/**
 * @module core/model — the reactive domain model.
 *
 * A Project holds typed DataItems. Each item is a PURE source of plot
 * contributions via contribute(space) — no DOM, no UI coupling. measurements /
 * visibility / style / layers are sideact signals, so renderers and UI react
 * with fine granularity. For UI controls that must NOT subscribe (avoiding
 * rebuild churn / focus loss), currentStyle()/currentLayers() return untracked
 * snapshots.
 *
 * LAYERS: each item exposes toggleable render-elements (great circles, poles,
 * contours, mean, eigenvectors) — OpenStereo's checkable-tree model. _net emits
 * only the enabled layers. Contribution shapes are per-space: net → geometric
 * primitives; rose → {azimuths,axial}; fabric → {dcos}.
 */

import { signal } from '../../vendor/sideact/signals.js';
import * as bearing from '../../vendor/bearing.mjs';
import { point, greatCircle, smallCircle, text, contour, heatmap } from './primitives.js';

const { conversions, statistics, color } = bearing;
const { meanVector, principalAxes, fisherStats } = statistics;

// categorical palette for colour-by-class (distinct, print-friendly)
const CAT_PALETTE = ['#1aa39a', '#e8920c', '#cc3333', '#7a5cff', '#3a9a3a', '#c060c0', '#d4548a', '#5bb8d4', '#9a7a3a', '#6a6f78'];
const distinct = (vals) => [...new Set(vals.map((v) => String(v)))];

// per-element tuning (contour method/smoothing/levels, mean confidence cone,
// per-eigenvector display mode) — separate from on/off layers and from style.
const DEFAULT_PARAMS = {
  cMethod: 'fisher', cSigma: null, cLevels: 4,       // density: method, σ (auto if null), # levels
  meanCone: false,                                   // draw the α95 confidence cone
  eigPole: [true, true, true], eigPlane: [false, false, true], // V1..V3 as point / great circle
};
const contourLevels = (method, n) => {
  const step = method === 'kamb' ? 2 : 2;            // σ (Kamb) or MUD (Fisher)
  return Array.from({ length: Math.max(1, n) }, (_, i) => (i + 1) * step);
};

let _seq = 0;
const uid = (p) => `${p || 'item'}${++_seq}`;

export class DataItem {
  constructor(opts = {}) {
    this.type = this.constructor.kind;
    this.id = opts.id || uid(this.type);
    this._nv = opts.name || this.id;
    const [name, setNameSig] = signal(this._nv);
    this.name = name;
    this.setName = (v) => { this._nv = v; setNameSig(v); };
    this.currentName = () => this._nv;

    this._mv = opts.measurements || [];
    const [measurements, setMeasurementsSig] = signal(this._mv);
    this.measurements = measurements;
    this.setMeasurements = (v) => { this._mv = v; setMeasurementsSig(v); };
    this.currentMeasurements = () => this._mv;

    // columns — optional per-measurement attributes (from CSV import), each
    // { name, values } with values aligned to measurements. Enables colour-by.
    this._cv = opts.columns || [];
    const [columns, setColumnsSig] = signal(this._cv);
    this.columns = columns;
    this.currentColumns = () => this._cv;
    this.setColumns = (v) => { this._cv = v || []; setColumnsSig(this._cv); };
    this._vv = opts.visible !== false;
    const [visible, setVisibleSig] = signal(this._vv);
    this.visible = visible;
    this.setVisible = (v) => { this._vv = v; setVisibleSig(v); };
    this.currentVisible = () => this._vv;

    // style — reactive read for renderers, untracked snapshot for UI controls
    this._sv = opts.style || {};
    const [style, setStyleSig] = signal(this._sv);
    this.style = style;
    this.setStyle = (v) => { this._sv = v; setStyleSig(v); };
    this.currentStyle = () => this._sv;

    // layers — toggleable render-elements, defaulted per type
    this._lv = {};
    for (const L of this.constructor.LAYERS || []) this._lv[L.key] = !!L.default;
    const [layers, setLayersSig] = signal(this._lv);
    this.layers = layers;
    this.currentLayers = () => this._lv;
    this.toggleLayer = (k) => { this._lv = { ...this._lv, [k]: !this._lv[k] }; setLayersSig(this._lv); };
    this.setLayer = (k, v) => { this._lv = { ...this._lv, [k]: !!v }; setLayersSig(this._lv); };

    // params — per-element tuning (contour/mean/eigen detail)
    this._pv = { ...DEFAULT_PARAMS, ...(opts.params || {}) };
    const [params, setParamsSig] = signal(this._pv);
    this.params = params;
    this.currentParams = () => this._pv;
    this.setParams = (patch) => { this._pv = { ...this._pv, ...patch }; setParamsSig(this._pv); };
  }

  _convert(_pair) { return [0, 0, -1]; }  // subclass: a degree pair → unit vector
  _azimuths() { return []; }              // subclass: azimuths for the rose
  get _axial() { return true; }

  dcos() { return this.measurements().map((m) => this._convert(m)); }

  // Distinct categories of a column → { value: colour } (style.catColors overrides).
  _categories(col) {
    const st = this.style(), over = st.catColors || {};
    const out = {};
    distinct(col.values).forEach((v, i) => { out[v] = over[v] || CAT_PALETTE[i % CAT_PALETTE.length]; });
    return out;
  }

  // Per-measurement colour function (i) → CSS colour, honouring style.colorMode.
  _colorFn() {
    const st = this.style(), cols = this.columns();
    const single = st.color || '#888888';
    const col = cols[st.colorBy];
    if (!col || (st.colorMode !== 'ramp' && st.colorMode !== 'categorical')) return () => single;
    if (st.colorMode === 'ramp') {
      const nums = col.values.map(Number);
      const finite = nums.filter(Number.isFinite);
      if (!finite.length) return () => single;
      const min = st.rampMin != null ? st.rampMin : Math.min(...finite);
      const max = st.rampMax != null ? st.rampMax : Math.max(...finite);
      const ramp = st.colorRamp || 'viridis';
      return (i) => (Number.isFinite(nums[i]) ? color.mapValue(ramp, nums[i], min, max, { reverse: !!st.rampReverse }) : single);
    }
    const cats = this._categories(col);
    return (i) => cats[String(col.values[i])] || single;
  }

  // Legend descriptor for the active colour-by mode (null if single colour).
  colorLegend() {
    const st = this.style(), cols = this.columns();
    const col = cols[st.colorBy];
    if (!col) return null;
    if (st.colorMode === 'ramp') {
      const nums = col.values.map(Number).filter(Number.isFinite);
      if (!nums.length) return null;
      return { type: 'ramp', column: col.name, ramp: st.colorRamp || 'viridis', reverse: !!st.rampReverse,
        min: st.rampMin != null ? st.rampMin : Math.min(...nums), max: st.rampMax != null ? st.rampMax : Math.max(...nums) };
    }
    if (st.colorMode === 'categorical') {
      const cats = this._categories(col);
      return { type: 'categorical', column: col.name, entries: Object.entries(cats) };
    }
    return null;
  }

  // Layer-aware geometric contribution (shared by all item types).
  _net() {
    const L = this.layers(), st = this.style(), P = this.params(), d = this.dcos(), out = [];
    const src = (i) => ({ item: this.id, datum: i });
    const colorFn = this._colorFn();
    const dStyle = (i) => (st.colorMode === 'ramp' || st.colorMode === 'categorical') ? { ...st, color: colorFn(i) } : st;
    if (this.type === 'planes') {
      if (L.great) d.forEach((p, i) => out.push(greatCircle(p, dStyle(i), src(i))));
      if (L.poles) d.forEach((p, i) => out.push(point(p, dStyle(i), src(i))));
    } else if (L.points !== false) {
      d.forEach((p, i) => out.push(point(p, dStyle(i), src(i))));
    }
    // density — method / smoothing / levels are tunable per item
    const dOpts = { method: P.cMethod };
    if (P.cSigma) dOpts.sigma = P.cSigma;
    if (L.heatmap && d.length >= 3) out.push(heatmap(d, dOpts, st, { item: this.id }));
    if (L.contours && d.length >= 3) out.push(contour(d, { ...dOpts, levels: contourLevels(P.cMethod, P.cLevels) }, st, { item: this.id }));
    // mean vector (+ optional α95 confidence cone)
    if (L.mean && d.length >= 1) {
      out.push(point(meanVector(d), { ...st, size: (st.size || 4) + 3 }, { item: this.id, mean: true }));
      if (P.meanCone && d.length >= 2) {
        const f = fisherStats(d);
        if (f.alpha95 > 0) out.push(smallCircle(f.mean, f.alpha95, st, { item: this.id, cone: true }));
      }
    }
    // eigenvectors — each as a point (pole) and/or great circle, independently
    if (L.eigen && d.length >= 2) {
      principalAxes(d).eigenvectors.forEach((v, i) => {
        if (P.eigPole[i]) out.push(point(v, { ...st, size: 5 }, { item: this.id, eigen: i }));
        if (P.eigPlane[i]) out.push(greatCircle(v, st, { item: this.id, eigen: i }));
        if (P.eigPole[i] || P.eigPlane[i]) out.push(text(v, 'V' + (i + 1), { dx: 7, dy: -5, fontSize: 10, fill: st.color || '#333' }, { item: this.id }));
      });
    }
    return out;
  }

  contribute(space) {
    if (space === 'net') return this._net();
    if (space === 'rose') {
      const az = this._azimuths();
      return az.length
        ? [{ kind: 'rose', azimuths: az, axial: this._axial, style: this.style(), label: this.name(), source: { item: this.id } }]
        : [];
    }
    if (space === 'fabric') {
      const d = this.dcos();
      return d.length >= 2
        ? [{ kind: 'fabric', dcos: d, style: this.style(), label: this.name(), source: { item: this.id } }]
        : [];
    }
    return [];
  }

  stats() {
    const d = this.dcos();
    return d.length >= 2 ? { ...principalAxes(d), fisher: statistics.fisherStats(d) } : null;
  }
}

const COMMON_LAYERS = [
  { key: 'heatmap', label: 'density (fill)', default: false },
  { key: 'contours', label: 'contours', default: false },
  { key: 'mean', label: 'mean', default: false },
  { key: 'eigen', label: 'eigenvectors', default: false },
];

export class PlaneSet extends DataItem {
  _convert([dd, dip]) { return conversions.planeToDcos(dd, dip); }
  _azimuths() { return this.measurements().map(([dd]) => (dd - 90 + 360) % 360); }
}
PlaneSet.kind = 'planes';
PlaneSet.LAYERS = [
  { key: 'great', label: 'great circles', default: true },
  { key: 'poles', label: 'poles', default: false },
  ...COMMON_LAYERS,
];

export class PoleSet extends DataItem {
  _convert([dd, dip]) { return conversions.planeToDcos(dd, dip); }
  _azimuths() { return this.measurements().map(([dd]) => (dd - 90 + 360) % 360); }
}
PoleSet.kind = 'poles';
PoleSet.LAYERS = [{ key: 'points', label: 'points', default: true }, ...COMMON_LAYERS];

export class LineSet extends DataItem {
  _convert([t, p]) { return conversions.lineToDcos(t, p); }
  _azimuths() { return this.measurements().map(([t]) => ((t % 360) + 360) % 360); }
}
LineSet.kind = 'lines';
LineSet.LAYERS = [{ key: 'points', label: 'points', default: true }, ...COMMON_LAYERS];

export const ITEM_TYPES = { planes: PlaneSet, poles: PoleSet, lines: LineSet };

export class Project {
  constructor(opts = {}) {
    const [items, setItems] = signal([]);
    this.items = items; this.setItems = setItems;
    const [projection, setProjection] = signal(opts.projection || 'equal-area');
    this.projection = projection; this.setProjection = setProjection;
    // global render settings (read by renderers, so changes re-render reactively)
    const [roseBinWidth, setRoseBinWidth] = signal(opts.roseBinWidth || 10);
    this.roseBinWidth = roseBinWidth; this.setRoseBinWidth = setRoseBinWidth;
    const [contourMethod, setContourMethod] = signal(opts.contourMethod || 'fisher');
    this.contourMethod = contourMethod; this.setContourMethod = setContourMethod;
  }

  add(item) { this.setItems([...this.items(), item]); return item; }
  remove(item) { this.setItems(this.items().filter((i) => i !== item)); }

  contribute(space) {
    const out = [];
    for (const it of this.items()) if (it.visible()) out.push(...it.contribute(space));
    return out;
  }
}
