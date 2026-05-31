/**
 * @module render/net — the stereonet renderer (one plot space).
 *
 * Consumes the Project's contribute('net') primitives and draws them with
 * @gcu/bearing, delegating DOM diffing to bearing's retained scene. Rebuilds the
 * Stereonet when the projection changes. Pointer handling distinguishes hover
 * (→ onHover, for the cursor read-out), drag (arcball rotation), and click
 * (→ onPick when pickMode is on, for click-to-add measurements).
 *
 * Hooks set by the host: net.onHover(dcos|null), net.onPick(dcos), net.pickMode.
 */

import * as bearing from '../../vendor/bearing.mjs';

const { Stereonet, conversions, mat3, color, vec3, curves } = bearing;
const DEG = 180 / Math.PI;

// Colour rides on the SVG attribute (so it can vary per measurement for
// colour-by-data); the host's injected `ds-<id>` stylesheet (see ui/app.js)
// owns only the per-item bits the engine can't set per primitive — opacity,
// plane dash, point edge-width. A class rule beats a presentation attribute,
// so the two never fight over colour.
const cls = (st, item) => [item && `ds-${item}`, st.class].filter(Boolean).join(' ') || undefined;
const pointStyle = (st, item) => {
  const open = st.pointFill === 'open';
  const color = st.color || st.fill || '#888888';
  return { fill: open ? 'none' : color, stroke: open ? color : (st.stroke || color), r: st.size, class: cls(st, item) };
};
const lineStyle = (st, item) => ({ stroke: st.color || st.stroke, 'stroke-width': st.width, class: cls(st, item) });

// hex "#rrggbb" → "rgba(r,g,b,a)"
function rgba(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#888888');
  const [r, g, b] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [136, 136, 136];
  return `rgba(${r},${g},${b},${a})`;
}

export class NetRenderer {
  constructor(project, opts = {}) {
    this.project = project;
    this._size = opts.size || 540;
    this.mode = 'measure';        // 'measure' | 'rotate' | 'pick'
    this._measure = null;         // { a:dcos, b:dcos|null } two-click angle measurement
    this.onHover = null;
    this.onPick = null;
    this.onMeasure = null;
    this._proj = null;
    this._rebuild(project.projection());
  }

  get element() { return this._el; }

  _rebuild(projection) {
    const prevRot = this.sn ? this.sn.rotation : null;     // keep the view across rebuilds
    this._proj = projection;
    this._grid = this.project.gridSpacing();
    this._hemi = this.project.hemisphere();
    const next = new Stereonet({ size: this._size, projection, classPrefix: 'osjs', gridSpacing: this._grid, hemisphere: this._hemi });
    if (prevRot) next.setRotation(prevRot);
    const el = next.element();
    if (this._el && this._el.parentNode) this._el.replaceWith(el);
    this.sn = next;
    this._el = el;
    this._wirePointer();
  }

  // numeric view: bring a trend/plunge to the centre, or reset to default
  setView(trend, plunge) { this.sn.setCenter(trend, plunge); this.sn.updateContours(); this.sn.render(); }
  resetView() { this.sn.setRotation(null); this.sn.updateContours(); this.sn.render(); }

  render() {
    const proj = this.project.projection();
    if (proj !== this._proj || this.project.gridSpacing() !== this._grid || this.project.hemisphere() !== this._hemi) this._rebuild(proj);
    const sn = this.sn;
    sn.clear();
    sn.clearContours();
    sn.clearHeatmap();
    for (const p of this.project.contribute('net')) this._draw(p);
    this._drawMeasure();
    sn.render();
  }

  // two-click measurement overlay: the picked point(s), the great circle through
  // them, and (host-side) the angle between them — drawn on top of the data.
  _drawMeasure() {
    const m = this._measure; if (!m) return;
    const C = '#0e7d75';
    const mark = (d, r) => { const [t, pl] = conversions.dcosToLine(d); this.sn.line(t, pl, { fill: C, stroke: '#fff', r: r || 4, class: 'osjs-measure' }); };
    mark(m.a);
    if (m.b) {
      let pole = vec3.normalize(vec3.cross(m.a, m.b));
      if (Number.isFinite(pole[0]) && vec3.length(vec3.cross(m.a, m.b)) > 1e-6) {
        if (pole[2] > 0) pole = vec3.negate(pole);   // use the pole in view (lower hemisphere)
        const [dd, dip] = conversions.dcosToPlane(pole);
        this.sn.plane(dd, dip, { stroke: C, 'stroke-width': 1, 'stroke-dasharray': '2 3', class: 'osjs-measure' });   // full great circle
        // spherical triangle A–B–pole: the measured arc + the two arcs to the pole
        this.sn.curve(curves.arc(m.a, m.b), { stroke: C, strokeWidth: 2, class: 'osjs-measure' });
        this.sn.curve(curves.arc(m.a, pole), { stroke: C, strokeWidth: 1, strokeDasharray: '4 3', class: 'osjs-measure' });
        this.sn.curve(curves.arc(m.b, pole), { stroke: C, strokeWidth: 1, strokeDasharray: '4 3', class: 'osjs-measure' });
        mark(pole, 3);   // the pole to the common plane
      }
      mark(m.b);
    }
  }

  measure() {
    const m = this._measure; if (!m || !m.b) return null;
    const angle = Math.acos(Math.max(-1, Math.min(1, vec3.dot(vec3.normalize(m.a), vec3.normalize(m.b))))) * DEG;
    const pole = vec3.normalize(vec3.cross(m.a, m.b));
    return { a: m.a, b: m.b, angle, pole };
  }
  clearMeasure() { this._measure = null; this.render(); }

  _draw(p) {
    const sn = this.sn, st = p.style || {}, item = p.source && p.source.item;
    switch (p.kind) {
      case 'point': { const [t, pl] = conversions.dcosToLine(p.dir); sn.line(t, pl, pointStyle(st, item)); break; }
      case 'greatCircle': { const [dd, dip] = conversions.dcosToPlane(p.pole); sn.plane(dd, dip, lineStyle(st, item)); break; }
      case 'smallCircle': { const [t, pl] = conversions.dcosToLine(p.axis); sn.cone(t, pl, p.angle, { ...lineStyle(st, item), fill: 'none', 'stroke-dasharray': '5 4' }); break; }
      case 'text': { const [t, pl] = conversions.dcosToLine(p.dir); sn.text(t, pl, p.content, st); break; }
      case 'contour': sn.contour(p.dcos, { stroke: st.color || '#555', strokeWidth: 0.8, ...p.opts }); break;
      case 'heatmap': {
        const ramp = p.opts.ramp;
        const colorFn = ramp && ramp !== 'item' ? (t) => color.sampleScale(ramp, t) : (t) => rgba(st.color, 0.1 + 0.8 * t);
        sn.heatmap(p.dcos, { ...p.opts, color: colorFn });
        break;
      }
      // polyline / fill / raster: TODO (bearing primitive-level methods would help).
      default: break;
    }
  }

  _wirePointer() {
    const el = this._el, sn = this.sn;
    el.style.touchAction = 'none';
    let cur = null, moved = false;
    const toSvg = (e) => {
      const r = el.getBoundingClientRect();
      const k = sn.size / r.width;
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    };
    el.addEventListener('pointermove', (e) => {
      const p = toSvg(e);
      if (cur) {
        if (Math.hypot(p.x - cur.x, p.y - cur.y) > 1) moved = true;
        if (this.mode === 'rotate') {              // drag → arcball spin
          const arc = sn.arcball(cur.x, cur.y, p.x, p.y);
          sn.setRotation(mat3.orthonormalize(sn.rotation ? mat3.multiply(arc, sn.rotation) : arc));
          sn.updateContours(); sn.render();
          cur = p;
        } else if (this.mode === 'measure' && moved && this._measure) {  // drag → measure A→B
          const b = sn.unproject(p.x, p.y);
          if (b) { this._measure.b = b; this.render(); if (this.onMeasure) this.onMeasure(this.measure()); }
        }
      } else if (this.onHover) {                   // hover → read-out
        this.onHover(sn.unproject(p.x, p.y));
      }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cur = toSvg(e); moved = false; el.setPointerCapture?.(e.pointerId); e.preventDefault();
      if (this.mode === 'measure') { const a = sn.unproject(cur.x, cur.y); this._measure = a ? { a, b: null } : null; this.render(); }
    });
    el.addEventListener('pointerup', () => {
      const d = (cur && !moved) ? sn.unproject(cur.x, cur.y) : null;
      const wasClick = !moved;
      cur = null;
      if (this.mode === 'pick' && d && this.onPick) this.onPick(d);
      else if (this.mode === 'measure' && wasClick) { this._measure = null; this.render(); }  // click (no drag) cancels
    });
    el.addEventListener('pointerleave', () => { if (this.onHover) this.onHover(null); });
    this._syncCursor();
  }

  _syncCursor() { this._el.style.cursor = this.mode === 'rotate' ? 'grab' : 'crosshair'; }
  setMode(m) { this.mode = m; this._syncCursor(); }
}
