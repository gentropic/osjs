/**
 * @module render/rose — the rose-diagram plot space.
 *
 * Each visible item contributes one 'rose' descriptor ({ azimuths, axial }); this
 * renderer bins each (bearing's roseBins) and overlays petals per item, scaled to
 * a SHARED maximum so sets are comparable. Binning + normalisation are plot-level
 * concerns and live here, not in the item. Rotation-independent.
 */

import * as bearing from '../../vendor/bearing.mjs';

const { rose, circular, SvgBuilder } = bearing;
const r2 = (x) => Math.round(x * 100) / 100;
const RAD = Math.PI / 180;
// azimuth (deg, clockwise from north) → svg point at radius r about (cx,cy)
const pt = (cx, cy, r, az) => [cx + r * Math.sin(az * RAD), cy - r * Math.cos(az * RAD)];

export class RoseRenderer {
  constructor(project, opts = {}) {
    this.project = project;
    this.size = opts.size || 320;
    this._el = document.createElement('div');
  }

  get element() { return this._el; }

  render() {
    const size = this.size, pad = 22, cx = size / 2, cy = size / 2, radius = (size - 2 * pad) / 2;
    const { binWidth, scale, petal, mean } = this.project.roseSettings;
    const lenScale = scale === 'count' ? 'linear' : 'sqrt';
    const svg = new SvgBuilder(size, size);
    svg.circle(cx, cy, radius, { fill: 'none', stroke: '#999', 'stroke-width': 1 });

    // bin each item; share the max count so sets are comparable
    const sets = this.project.contribute('rose').map((c) => ({
      color: (c.style && (c.style.color || c.style.fill)) || '#e8920c',
      axial: c.axial, azimuths: c.azimuths,
      b: rose.roseBins(c.azimuths, { binWidth, axial: c.axial }),
    }));
    const gmax = Math.max(1, ...sets.map((s) => s.b.maxCount));
    const frac = (count) => (lenScale === 'sqrt' ? Math.sqrt(count / gmax) : count / gmax);

    for (const s of sets) {
      if (petal === 'kite') {
        const ring = s.b.bins.map((bin) => pt(cx, cy, radius * frac(bin.count), (bin.startDeg + bin.endDeg) / 2));
        svg.path('M' + ring.map(([x, y]) => `${r2(x)},${r2(y)}`).join('L') + 'Z', { fill: s.color, 'fill-opacity': 0.18, stroke: s.color, 'stroke-width': 1.1 });
      } else if (petal === 'lines') {
        for (const bin of s.b.bins) {
          if (bin.count <= 0) continue;
          const [x, y] = pt(cx, cy, radius * frac(bin.count), (bin.startDeg + bin.endDeg) / 2);
          svg.line(cx, cy, r2(x), r2(y), { stroke: s.color, 'stroke-width': 1.4 });
        }
      } else { // filled petals
        s.b.maxCount = gmax;
        for (const p of rose.rosePetals(s.b, { cx, cy, radius, scale: lenScale })) {
          svg.path('M' + p.points.map(([x, y]) => `${r2(x)},${r2(y)}`).join('L') + 'Z', { fill: s.color, 'fill-opacity': 0.5, stroke: s.color, 'stroke-width': 0.6 });
        }
      }
      // circular mean direction (+ its 180° partner for axial data)
      if (mean && s.azimuths.length) {
        const m = circular.circularMean(s.azimuths, { axial: s.axial });
        if (!Number.isFinite(m)) continue;
        for (const a of (s.axial ? [m, m + 180] : [m])) {
          const [x, y] = pt(cx, cy, radius, a);
          svg.line(cx, cy, r2(x), r2(y), { stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': '4 3' });
        }
      }
    }
    this._el.innerHTML = svg.toString();
  }
}
