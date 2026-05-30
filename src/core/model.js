/**
 * @module core/model — the reactive domain model.
 *
 * A Project holds typed DataItems. Each item is a PURE source of plot primitives
 * via contribute(space) — no DOM, no UI coupling (unlike OpenStereo's PyQt
 * DataItem, which inherited from a tree widget). measurements / visibility /
 * style are sideact signals, so renderers and UI react with fine granularity:
 * reading dcos()/style()/visible() inside an effect tracks them automatically.
 *
 * Item hierarchy mirrors OpenStereo (modernised): AttitudeData → PlaneSet /
 * PoleSet / LineSet, with SmallCircleSet / FaultSet to follow. New data type =
 * new subclass returning the right primitives; renderers stay closed.
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

  _convert(_pair) { return [0, 0, -1]; }   // subclass: a degree pair → unit vector
  contribute(_space) { return []; }        // subclass: → Primitive[]

  /** Measurements as direction cosines (reactive: tracks the measurements signal). */
  dcos() { return this.measurements().map((m) => this._convert(m)); }

  /** Orientation statistics (eigen/fabric + Fisher), or null for <2 data. */
  stats() {
    const d = this.dcos();
    return d.length >= 2
      ? { ...statistics.principalAxes(d), fisher: statistics.fisherStats(d) }
      : null;
  }
}

/** A set of planes — drawn as great circles (and optionally their poles). */
export class PlaneSet extends DataItem {
  _convert([dd, dip]) { return conversions.planeToDcos(dd, dip); }
  contribute(space) {
    if (space !== 'net') return [];
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

/** Poles to planes — drawn as points. */
export class PoleSet extends DataItem {
  _convert([dd, dip]) { return conversions.planeToDcos(dd, dip); }
  contribute(space) {
    if (space !== 'net') return [];
    const st = this.style();
    return this.dcos().map((d, i) => point(d, st, { item: this.id, datum: i }));
  }
}
PoleSet.kind = 'poles';

/** Lineations — drawn as points. */
export class LineSet extends DataItem {
  _convert([t, p]) { return conversions.lineToDcos(t, p); }
  contribute(space) {
    if (space !== 'net') return [];
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

  /** Aggregate primitives for a plot space from all visible items. */
  contribute(space) {
    const out = [];
    for (const it of this.items()) if (it.visible()) out.push(...it.contribute(space));
    return out;
  }
}
