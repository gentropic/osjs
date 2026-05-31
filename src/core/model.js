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
import { point, polyline, greatCircle, smallCircle, text, contour, heatmap } from './primitives.js';

const { conversions, statistics, color, fault, vec3, analysis } = bearing;
const { meanVector, principalAxes, fisherStats } = statistics;

// categorical palette for colour-by-class (distinct, print-friendly)
const CAT_PALETTE = ['#1aa39a', '#e8920c', '#cc3333', '#7a5cff', '#3a9a3a', '#c060c0', '#d4548a', '#5bb8d4', '#9a7a3a', '#6a6f78'];
const distinct = (vals) => [...new Set(vals.map((v) => String(v)))];

// per-element tuning (contour method/smoothing/levels, mean confidence cone,
// per-eigenvector display mode) — separate from on/off layers and from style.
const DEFAULT_PARAMS = {
  cMethod: 'fisher', cSigma: null, cLevels: 4,       // density: method, σ (auto if null), # levels
  cRamp: 'item',                                     // density fill colour: 'item' hue, or a named scale
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

    // layers — toggleable render-elements, defaulted per type (opts.layers overrides)
    this._lv = {};
    for (const L of this.constructor.LAYERS || []) this._lv[L.key] = !!L.default;
    if (opts.layers) this._lv = { ...this._lv, ...opts.layers };
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

  // Per-type primitive geometry (points / great circles / small circles).
  // Subclasses override; default plots each direction as a point marker.
  _geometry(out, L, dStyle, src, d) {
    if (L.points !== false) d.forEach((p, i) => out.push(point(p, dStyle(i), src(i))));
  }

  // Layer-aware geometric contribution (shared by all item types).
  _net() {
    const L = this.layers(), st = this.style(), P = this.params(), d = this.dcos(), out = [];
    const src = (i) => ({ item: this.id, datum: i });
    const colorFn = this._colorFn();
    const dStyle = (i) => (st.colorMode === 'ramp' || st.colorMode === 'categorical') ? { ...st, color: colorFn(i) } : st;
    this._geometry(out, L, dStyle, src, d);
    // density — method / smoothing / levels are tunable per item
    const dOpts = { method: P.cMethod };
    if (P.cSigma) dOpts.sigma = P.cSigma;
    if (L.heatmap && d.length >= 3) out.push(heatmap(d, { ...dOpts, ramp: P.cRamp }, st, { item: this.id }));
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
    if (d.length < 2) return null;
    return {
      ...principalAxes(d),
      fisher: statistics.fisherStats(d),
      bestFit: analysis.bestFitGreatCircle(d),   // girdle plane + fold (β) axis + girdle index
      uniformity: statistics.uniformityTest(d),  // spherical uniformity (small p ⇒ not random)
    };
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
  _geometry(out, L, dStyle, src, d) {
    if (L.great) d.forEach((p, i) => out.push(greatCircle(p, dStyle(i), src(i))));
    if (L.poles) d.forEach((p, i) => out.push(point(p, dStyle(i), src(i))));
  }
}
PlaneSet.kind = 'planes';
PlaneSet.GEOM = ['dip dir', 'dip'];
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
PoleSet.GEOM = ['dip dir', 'dip'];
PoleSet.LAYERS = [{ key: 'points', label: 'points', default: true }, ...COMMON_LAYERS];

export class LineSet extends DataItem {
  _convert([t, p]) { return conversions.lineToDcos(t, p); }
  _azimuths() { return this.measurements().map(([t]) => ((t % 360) + 360) % 360); }
}
LineSet.kind = 'lines';
LineSet.GEOM = ['trend', 'plunge'];
LineSet.LAYERS = [{ key: 'points', label: 'points', default: true }, ...COMMON_LAYERS];

// Small circles: each datum is [trend, plunge, aperture°] — an axis + a cone.
export class SmallCircleSet extends DataItem {
  _convert([t, p]) { return conversions.lineToDcos(t, p); }     // axis (aperture ignored)
  _azimuths() { return this.measurements().map(([t]) => ((t % 360) + 360) % 360); }
  _geometry(out, L, dStyle, src) {
    const d = this.dcos();
    if (L.axes) d.forEach((ax, i) => out.push(point(ax, dStyle(i), src(i))));
    if (L.circles) this.measurements().forEach(([t, p, a], i) => out.push(smallCircle(d[i], (a ?? 30), dStyle(i), src(i))));
  }
}
SmallCircleSet.kind = 'smallcircle';
SmallCircleSet.GEOM = ['trend', 'plunge', 'aperture'];
SmallCircleSet.LAYERS = [
  { key: 'axes', label: 'axes', default: true },
  { key: 'circles', label: 'small circles', default: true },
  ...COMMON_LAYERS,
];

// Faults: self-contained datum [dip dir, dip, rake, sense]. sense codes (numeric,
// passed straight to fault.resolveSense): 0 unknown · 1 reverse · 2 normal ·
// 3 dextral · 4 sinistral. dcos() = fault-plane poles (for fabric/eigen/density).
export class FaultSet extends DataItem {
  _convert([dd, dip]) { return conversions.planeToDcos(dd, dip); }
  _azimuths() { return this.measurements().map(([dd]) => (dd - 90 + 360) % 360); }

  // per-fault kinematics: normal, slickenline, resolved slip vector, P/T axes
  _faults() {
    return this.measurements().map(([dd, dip, rake, sense]) => {
      const normal = conversions.planeToDcos(dd, dip);
      const line = conversions.rakeToDcos(dd, dip, rake);
      const { slip, defined } = fault.resolveSense(normal, line, sense);
      const { p, t } = fault.ptAxes(normal, slip);
      return { normal, line, slip, defined, p, t };
    });
  }

  _geometry(out, L, dStyle, src) {
    const F = this._faults(), st = this.style();
    if (L.planes) F.forEach((f, i) => out.push(greatCircle(f.normal, dStyle(i), src(i))));
    // slip arrow: a short segment at the fault-plane pole, ±δ along the slip line,
    // head at cos δ·n − sin δ·s (OpenStereo convention), with a small arrowhead.
    if (L.slip) F.forEach((f, i) => {
      const n = f.normal[2] > 0 ? vec3.negate(f.normal) : f.normal, s = f.slip;
      const d = 9 * Math.PI / 180, c = Math.cos(d), e = Math.sin(d);
      const tail = vec3.normalize(vec3.add(vec3.scale(n, c), vec3.scale(s, e)));
      const head = vec3.normalize(vec3.sub(vec3.scale(n, c), vec3.scale(s, e)));
      out.push(polyline([tail, head], dStyle(i), { item: this.id, datum: i, slip: true }));
      const perp = vec3.normalize(vec3.cross(n, s)), back = vec3.normalize(vec3.sub(tail, head));
      const b1 = vec3.normalize(vec3.add(head, vec3.add(vec3.scale(back, 0.5 * e), vec3.scale(perp, 0.32 * e))));
      const b2 = vec3.normalize(vec3.add(head, vec3.sub(vec3.scale(back, 0.5 * e), vec3.scale(perp, 0.32 * e))));
      out.push(polyline([b1, head, b2], dStyle(i), { item: this.id, datum: i, slip: true }));
    });
    if (L.pt) F.forEach((f, i) => {
      out.push(point(f.p, { ...st, pointFill: 'filled', size: 4 }, { item: this.id, datum: i, axis: 'P' }));
      out.push(point(f.t, { ...st, pointFill: 'open', size: 4 }, { item: this.id, datum: i, axis: 'T' }));
    });
    if (L.michael) this._paleostress(out);
  }

  // Michael (1984) paleostress inversion — EXPERIMENTAL / not freshly validated.
  _paleostress(out) {
    const F = this._faults().filter((f) => f.defined);
    if (F.length < 4) return;                       // 5 unknowns; need enough faults
    const { stress } = fault.michael(F.map((f) => f.normal), F.map((f) => f.slip));
    const { axes } = fault.principalStresses(stress);   // σ1, σ2, σ3
    const cols = ['#cc3333', '#3a9a3a', '#3a6ea8'];
    axes.forEach((ax, k) => {
      out.push(point(ax, { ...this.style(), color: cols[k], size: 7 }, { item: this.id, stress: k }));
      out.push(text(ax, 'σ' + (k + 1), { dx: 7, dy: -5, fontSize: 11, fontWeight: 700, fill: cols[k] }, { item: this.id }));
    });
  }
}
FaultSet.kind = 'fault';
FaultSet.GEOM = ['dip dir', 'dip', 'rake', 'sense'];
FaultSet.LAYERS = [
  { key: 'planes', label: 'fault planes', default: true },
  { key: 'slip', label: 'slickenlines', default: true },
  { key: 'pt', label: 'P / T axes', default: false },
  { key: 'michael', label: 'paleostress σ (experimental)', default: false },
  ...COMMON_LAYERS,
];

export const ITEM_TYPES = { planes: PlaneSet, poles: PoleSet, lines: LineSet, smallcircle: SmallCircleSet, fault: FaultSet };

// ── tree: groups (nestable folders) hold data items and other groups ──
let _gseq = 0;
export const isGroup = (n) => !!n && n.kind === 'group';

export class Group {
  constructor(opts = {}) {
    this.kind = 'group'; this.type = 'group';
    this.id = opts.id || `group${++_gseq}`;
    this._nv = opts.name || 'group';
    const [name, setNameSig] = signal(this._nv);
    this.name = name; this.setName = (v) => { this._nv = v; setNameSig(v); }; this.currentName = () => this._nv;
    this._vv = opts.visible !== false;
    const [visible, setVisibleSig] = signal(this._vv);
    this.visible = visible; this.setVisible = (v) => { this._vv = v; setVisibleSig(v); }; this.currentVisible = () => this._vv;
    this._xv = opts.expanded !== false;
    const [expanded, setExpandedSig] = signal(this._xv);
    this.expanded = expanded; this.setExpanded = (v) => { this._xv = v; setExpandedSig(v); }; this.currentExpanded = () => this._xv;
    this._cv = opts.children || [];
    const [children, setChildrenSig] = signal(this._cv);
    this.children = children; this.setChildren = (v) => { this._cv = v; setChildrenSig(v); }; this.currentChildren = () => this._cv;
  }
}

// depth-first leaf items; the *visible* variant prunes hidden groups (cascade)
const leavesOf = (nodes) => nodes.flatMap((n) => (isGroup(n) ? leavesOf(n.children()) : [n]));
const visibleLeavesOf = (nodes) => nodes.flatMap((n) => (isGroup(n) ? (n.visible() ? visibleLeavesOf(n.children()) : []) : (n.visible() ? [n] : [])));

export class Project {
  constructor(opts = {}) {
    const [nodes, setNodes] = signal(opts.nodes || []);   // root of the layer tree
    this.nodes = nodes; this.setNodes = setNodes;
    this.items = () => leavesOf(this.nodes());             // all data items, depth-first (flat)
    this.visibleLeaves = () => visibleLeavesOf(this.nodes());
    const [projection, setProjection] = signal(opts.projection || 'equal-area');
    this.projection = projection; this.setProjection = setProjection;
    const mk = (key, def) => { const [g, s] = signal(opts[key] ?? def); this[key] = g; this['set' + key[0].toUpperCase() + key.slice(1)] = s; };
    mk('roseBinWidth', 10);
    mk('roseScale', 'area');        // 'count' (radius ∝ count) | 'area' (∝ √count, equal-area)
    mk('rosePetalStyle', 'petals'); // 'petals' | 'kite' | 'lines'
    mk('roseMean', false);          // draw each set's circular mean direction
    mk('gridSpacing', 10);          // net great/small-circle grid spacing (degrees)
    mk('hemisphere', 'lower');      // 'lower' | 'upper'
    mk('contourMethod', 'fisher');
  }

  get roseSettings() { return { binWidth: this.roseBinWidth(), scale: this.roseScale(), petal: this.rosePetalStyle(), mean: this.roseMean() }; }

  add(item) { this.setNodes([...this.nodes(), item]); return item; }
  addGroup(name) { const g = new Group({ name: name || 'group' }); this.setNodes([...this.nodes(), g]); return g; }

  // remove a node from anywhere in the tree (sets the affected list's signal)
  remove(node) {
    const rec = (list, set) => {
      if (list.includes(node)) { set(list.filter((n) => n !== node)); return true; }
      return list.some((n) => isGroup(n) && rec(n.children(), n.setChildren));
    };
    rec(this.nodes(), this.setNodes);
  }

  // parent Group of a node, or null if at root (undefined if absent)
  parentOf(node) {
    const rec = (list, parent) => {
      if (list.includes(node)) return parent;
      for (const n of list) if (isGroup(n)) { const r = rec(n.children(), n); if (r !== undefined) return r; }
      return undefined;
    };
    const r = rec(this.nodes(), null);
    return r === undefined ? null : r;
  }

  _contains(group, target) {
    return group.children().some((n) => n === target || (isGroup(n) && this._contains(n, target)));
  }

  // move `node` into `parent` (null = root) at `index`; guards against cycles
  move(node, parent, index) {
    if (node === parent || (isGroup(node) && parent && this._contains(node, parent))) return;
    this.remove(node);
    const list = parent ? parent.children() : this.nodes();
    const next = list.slice();
    next.splice(index == null ? next.length : index, 0, node);
    if (parent) parent.setChildren(next); else this.setNodes(next);
  }

  contribute(space) {
    const out = [];
    for (const it of this.visibleLeaves()) out.push(...it.contribute(space));
    return out;
  }
}

// ── data tools — derive a new item payload from existing one(s) ──
const r1 = (x) => Math.round(x * 10) / 10;
const backFn = (type) => (type === 'lines' ? conversions.dcosToLine : conversions.dcosToPlane);

/** Rotate an item's data about an axis (trend/plunge) by angle° → new payload. */
export function rotateItem(item, trend, plunge, angle) {
  const axis = conversions.lineToDcos(trend, plunge);
  const back = backFn(item.type);
  const measurements = conversions.rotateDcosArray(item.dcos(), axis, angle).map((d) => back(d).map(r1));
  return { type: item.type, name: `${item.currentName()} (rot ${angle}°)`, measurements, style: { ...item.currentStyle() } };
}

/** Concatenate two same-type items → new payload. */
export function mergeItems(a, b) {
  return { type: a.type, name: `${a.currentName()} + ${b.currentName()}`,
    measurements: [...a.currentMeasurements(), ...b.currentMeasurements()], style: { ...a.currentStyle() } };
}

/** All pairwise normalized difference vectors of an item → new lines payload. */
export function differenceVectors(item) {
  const d = item.dcos(), out = [];
  for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) {
    const v = vec3.normalize(vec3.sub(d[i], d[j]));
    if (Number.isFinite(v[0])) out.push(conversions.dcosToLine(v).map(r1));
  }
  return { type: 'lines', name: `${item.currentName()} (diff)`, measurements: out, style: { ...item.currentStyle(), size: 3 } };
}

const PROJECT_FORMAT = 'osjs-project';

function serializeNode(n) {
  if (isGroup(n)) {
    return { kind: 'group', name: n.currentName(), visible: n.currentVisible(), expanded: n.currentExpanded(), children: n.currentChildren().map(serializeNode) };
  }
  return {
    type: n.type, name: n.currentName(), visible: n.currentVisible(),
    measurements: n.currentMeasurements(), columns: n.currentColumns(),
    style: n.currentStyle(), params: n.currentParams(), layers: n.currentLayers(),
  };
}

/** Full project state (the layer tree + settings) → a plain JSON-able object. */
export function serializeProject(project) {
  return {
    format: PROJECT_FORMAT, version: 2,
    projection: project.projection(),
    roseBinWidth: project.roseBinWidth(),
    roseScale: project.roseScale(),
    rosePetalStyle: project.rosePetalStyle(),
    roseMean: project.roseMean(),
    gridSpacing: project.gridSpacing(),
    hemisphere: project.hemisphere(),
    items: project.nodes().map(serializeNode),
  };
}

// reverse of serializeNode; a missing `kind` means a (v1, flat) data item
function buildNode(d) {
  if (d.kind === 'group') return new Group({ name: d.name, visible: d.visible, expanded: d.expanded, children: (d.children || []).map(buildNode) });
  return new (ITEM_TYPES[d.type] || PlaneSet)({
    name: d.name, visible: d.visible, measurements: d.measurements,
    columns: d.columns, style: d.style, params: d.params, layers: d.layers,
  });
}

/** Rebuild a project's tree + settings from serializeProject() output (loads v1 flat files too). */
export function loadProject(project, data) {
  if (!data || data.format !== PROJECT_FORMAT) throw new Error('not an OSJS project file');
  if (data.projection) project.setProjection(data.projection);
  if (data.roseBinWidth) project.setRoseBinWidth(data.roseBinWidth);
  if (data.roseScale) project.setRoseScale(data.roseScale);
  if (data.rosePetalStyle) project.setRosePetalStyle(data.rosePetalStyle);
  if (data.roseMean != null) project.setRoseMean(data.roseMean);
  if (data.gridSpacing) project.setGridSpacing(data.gridSpacing);
  if (data.hemisphere) project.setHemisphere(data.hemisphere);
  const nodes = (data.items || []).map(buildNode);
  project.setNodes(nodes);
  return nodes;
}
