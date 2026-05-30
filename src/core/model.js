/**
 * @module core/model — the reactive domain model.
 *
 * A Project holds typed DataItems. Each item is a PURE source of plot
 * contributions via contribute(space) — no DOM, no UI coupling. measurements /
 * visibility / style are sideact signals, so renderers and UI react with fine
 * granularity (reading dcos()/style()/visible() inside an effect tracks them).
 *
 * Contribution shapes are per-space:
 *   - 'net'    → geometric primitives (the closed vocabulary in primitives.js)
 *   - 'rose'   → one { kind:'rose', azimuths, axial, … } per item (renderer bins)
 *   - 'fabric' → one { kind:'fabric', dcos, … } per item (renderer computes coords)
 * Geometric variety lives in the net's closed vocabulary; the statistical plots
 * (rose, fabric) are aggregates the renderer composes, so the item just hands
 * over the data it has.
 */

import { signal } from '../../vendor/sideact-signals.js';
import * as bearing from '../../vendor/bearing.mjs';
import { point, greatCircle } from './primitives.js';

const { conversions, statistics } = bearing;

let _seq = 0;
const uid = (p) => `${p || 'item'}${++_seq}`;

export class DataItem {
  constructor(opts = {}) {
    this.type = this.constructor.kind;
    this.id = opts.id || uid(this.type);
    this.name = opts.name || this.id;
    const [measurements, setMeasurements] = signal(opts.measurements || []); // raw degree pairs
    this.measurements = measurements; this.setMeasurements = setMeasurements;
    const [visible, setVisible] = signal(opts.visible !== false);
    this.visible = visible; this.setVisible = setVisible;
    const [style, setStyle] = signal(opts.style || {});
    this.style = style; this.setStyle = setStyle;
  }

  _convert(_pair) { return [0, 0, -1]; }  // subclass: a degree pair → unit vector
  _net() { return []; }                   // subclass: geometric primitives
  _azimuths() { return []; }              // subclass: azimuths for the rose
  get _axial() { return true; }           // most structural data is axial

  /** Measurements as direction cosines (reactive: tracks the measurements signal). */
  dcos() { return this.measurements().map((m) => this._convert(m)); }

  contribute(space) {
    if (space === 'net') return this._net();
    if (space === 'rose') {
      const az = this._azimuths();
      return az.length
        ? [{ kind: 'rose', azimuths: az, axial: this._axial, style: this.style(), label: this.name, source: { item: this.id } }]
        : [];
    }
    if (space === 'fabric') {
      const d = this.dcos();
      return d.length >= 2
        ? [{ kind: 'fabric', dcos: d, style: this.style(), label: this.name, source: { item: this.id } }]
        : [];
    }
    return [];
  }

  /** Orientation statistics (eigen/fabric + Fisher), or null for <2 data. */
  stats() {
    const d = this.dcos();
    return d.length >= 2
      ? { ...statistics.principalAxes(d), fisher: statistics.fisherStats(d) }
      : null;
  }
}

/** A set of planes — great circles on the net; strikes on the rose. */
export class PlaneSet extends DataItem {
  _convert([dd, dip]) { return conversions.planeToDcos(dd, dip); }
  _azimuths() { return this.measurements().map(([dd]) => (dd - 90 + 360) % 360); } // strike (RHR)
  _net() {
    const st = this.style();
    const out = [];
    this.dcos().forEach((d, i) => {
      out.push(greatCircle(d, st, { item: this.id, datum: i }));
      if (st.showPoles) out.push(point(d, st, { item: this.id, datum: i }));
    });
    return out;
  }
}
PlaneSet.kind = 'planes';

/** Poles to planes — points on the net; strikes on the rose. */
export class PoleSet extends DataItem {
  _convert([dd, dip]) { return conversions.planeToDcos(dd, dip); }
  _azimuths() { return this.measurements().map(([dd]) => (dd - 90 + 360) % 360); }
  _net() {
    const st = this.style();
    return this.dcos().map((d, i) => point(d, st, { item: this.id, datum: i }));
  }
}
PoleSet.kind = 'poles';

/** Lineations — points on the net; trends on the rose. */
export class LineSet extends DataItem {
  _convert([t, p]) { return conversions.lineToDcos(t, p); }
  _azimuths() { return this.measurements().map(([t]) => ((t % 360) + 360) % 360); }
  _net() {
    const st = this.style();
    return this.dcos().map((d, i) => point(d, st, { item: this.id, datum: i }));
  }
}
LineSet.kind = 'lines';

export const ITEM_TYPES = { planes: PlaneSet, poles: PoleSet, lines: LineSet };

export class Project {
  constructor(opts = {}) {
    const [items, setItems] = signal([]);
    this.items = items; this.setItems = setItems;
    const [projection, setProjection] = signal(opts.projection || 'equal-area');
    this.projection = projection; this.setProjection = setProjection;
  }

  add(item) { this.setItems([...this.items(), item]); return item; }
  remove(item) { this.setItems(this.items().filter((i) => i !== item)); }

  /** Aggregate contributions for a plot space from all visible items. */
  contribute(space) {
    const out = [];
    for (const it of this.items()) if (it.visible()) out.push(...it.contribute(space));
    return out;
  }
}
