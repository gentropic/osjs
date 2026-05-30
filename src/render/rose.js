/**
 * @module render/rose — the rose-diagram plot space.
 *
 * Each visible item contributes one 'rose' descriptor ({ azimuths, axial }); this
 * renderer bins each (bearing's roseBins) and overlays petals per item, scaled to
 * a SHARED maximum so sets are comparable. Binning + normalisation are plot-level
 * concerns and live here, not in the item. Rotation-independent.
 */

import * as bearing from '../../vendor/bearing.mjs';

const { rose, SvgBuilder } = bearing;
const r2 = (x) => Math.round(x * 100) / 100;

export class RoseRenderer {
  constructor(project, opts = {}) {
    this.project = project;
    this.size = opts.size || 320;
    this.binWidth = opts.binWidth || 10;
    this._el = document.createElement('div');
  }

  get element() { return this._el; }

  setBinWidth(w) { this.binWidth = w; this.render(); }

  render() {
    const size = this.size, pad = 22, cx = size / 2, cy = size / 2, radius = (size - 2 * pad) / 2;
    const svg = new SvgBuilder(size, size);
    svg.circle(cx, cy, radius, { fill: 'none', stroke: '#999', 'stroke-width': 1 });

    // Bin each item; share the max count so petal lengths are comparable.
    const binned = this.project.contribute('rose').map((c) => ({
      color: (c.style && (c.style.color || c.style.fill)) || '#e8920c',
      b: rose.roseBins(c.azimuths, { binWidth: this.binWidth, axial: c.axial }),
    }));
    const gmax = Math.max(1, ...binned.map((x) => x.b.maxCount));

    for (const { color, b } of binned) {
      b.maxCount = gmax; // scale this set against the shared maximum
      for (const p of rose.rosePetals(b, { cx, cy, radius, scale: 'sqrt' })) {
        const d = 'M' + p.points.map(([x, y]) => `${r2(x)},${r2(y)}`).join('L') + 'Z';
        svg.path(d, { fill: color, 'fill-opacity': 0.55, stroke: color, 'stroke-width': 0.6 });
      }
    }
    this._el.innerHTML = svg.toString();
  }
}
