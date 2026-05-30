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
import { point, greatCircle, text, contour, heatmap } from './primitives.js';

const { conversions, statistics } = bearing;
const { meanVector, principalAxes } = statistics;

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

    const [measurements, setMeasurements] = signal(opts.measurements || []);
    this.measurements = measurements; this.setMeasurements = setMeasurements;
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
  }

  _convert(_pair) { return [0, 0, -1]; }  // subclass: a degree pair → unit vector
  _azimuths() { return []; }              // subclass: azimuths for the rose
  get _axial() { return true; }

  dcos() { return this.measurements().map((m) => this._convert(m)); }

  // Layer-aware geometric contribution (shared by all item types).
  _net() {
    const L = this.layers(), st = this.style(), d = this.dcos(), out = [];
    const src = (i) => ({ item: this.id, datum: i });
    if (this.type === 'planes') {
      if (L.great) d.forEach((p, i) => out.push(greatCircle(p, st, src(i))));
      if (L.poles) d.forEach((p, i) => out.push(point(p, st, src(i))));
    } else if (L.points !== false) {
      d.forEach((p, i) => out.push(point(p, st, src(i))));
    }
    if (L.heatmap && d.length >= 3) out.push(heatmap(d, {}, st, { item: this.id }));
    if (L.contours && d.length >= 3) out.push(contour(d, {}, st, { item: this.id }));
    if (L.mean && d.length >= 1) out.push(point(meanVector(d), { ...st, size: (st.size || 4) + 3 }, { item: this.id, mean: true }));
    if (L.eigen && d.length >= 2) {
      principalAxes(d).eigenvectors.forEach((v, i) => {
        out.push(point(v, { ...st, size: 5 }, { item: this.id }));
        out.push(text(v, 'V' + (i + 1), { dx: 7, dy: -5, fontSize: 10, fill: st.color || '#333' }, { item: this.id }));
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
