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

const { Stereonet, conversions, mat3, color, vec3, curves, fault } = bearing;
const DEG = 180 / Math.PI;

// diverging colour for right-dihedra: compression (t<0) blue ↔ extension (t>0) red
function dihedraColor(t) {
  const x = Math.max(-1, Math.min(1, t));
  if (x >= 0) { const g = Math.round(60 + 195 * (1 - x)); return `rgba(210,${g},${g},0.72)`; }
  const g = Math.round(60 + 195 * (1 + x)); return `rgba(${g},${g},210,0.72)`;
}

// Colour rides on the SVG attribute (so it can vary per measurement for
// colour-by-data); the host's injected `ds-<id>` stylesheet (see ui/app.js)
// owns only the per-item bits the engine can't set per primitive — opacity,
// plane dash, point edge-width. A class rule beats a presentation attribute,
// so the two never fight over colour.
const cls = (st, item) => [item && `ds-${item}`, st.class].filter(Boolean).join(' ') || undefined;
// walk up from a hit element to the owning data item id (the `ds-<id>` class the
// renderer stamps on every primitive), so a click can select that layer.
function dsId(el, root) {
  for (let n = el; n && n !== root; n = n.parentNode) {
    const c = n.getAttribute && n.getAttribute('class');
    const m = c && /(?:^|\s)ds-([^\s]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}
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
    this.mode = 'select';         // 'select' | 'measure' | 'rotate' | 'pick'
    this._measure = null;         // { a:dcos, b:dcos|null } two-click angle measurement
    this.onHover = null;
    this.onPick = null;
    this.onMeasure = null;
    this.onSelect = null;         // (itemId|null) — select mode: click a layer / empty to deselect
    this.onIdentify = null;       // (dcos, itemId|null) — select click: linked identify (flash nearest datum's row)
    this.onContextMenu = null;    // ({clientX, clientY, dcos, id}) — right-click on the net
    this._vp = { tx: 0, ty: 0, scale: 1 };   // viewport: CSS pan/zoom over the net (rect-based, so overlays follow)
    this.onViewport = null;       // (vp) — fired on any pan/zoom change (for a zoom read-out)
    this.onRotate = null;         // (mat3|null) — fired when the net orientation changes (for persistence)
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
    this._applyViewport(true);     // re-apply across rebuilds, silently
  }

  // numeric view: bring a trend/plunge to the centre, or reset to default
  setView(trend, plunge) { this.sn.setCenter(trend, plunge); this.sn.updateContours(); this.sn.render(); this.onAfterRender?.(); this.onRotate?.(this.sn.rotation); }
  resetView() { this.sn.setRotation(null); this.sn.updateContours(); this.sn.render(); this.onAfterRender?.(); this.onRotate?.(this.sn.rotation); }
  // restore a saved orientation without echoing through onRotate
  applyRotation(m) { this.sn.setRotation(m || null); this.sn.updateContours(); this.sn.render(); this.onAfterRender?.(); }

  // ── viewport (pan/zoom over the net, via a CSS transform on the SVG) ──
  // Overlay positioning is rect-based, so transforming the SVG and re-running the
  // overlay reposition (onAfterRender) keeps everything aligned — no projection or
  // bearing change. transform-origin 0 0 keeps the zoom-to-cursor math simple.
  _applyViewport(silent) {
    const v = this._vp;
    if (this._el) {
      this._el.style.transformOrigin = '0 0';
      this._el.style.transform = (v.tx || v.ty || v.scale !== 1) ? `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})` : '';
    }
    this.onAfterRender?.();
    if (!silent) this.onViewport?.(v);            // silent = programmatic (e.g. restore) → don't echo back
  }
  // set an absolute zoom level, keeping a focal point fixed (defaults to net centre)
  setZoom(scale, clientX, clientY) {
    const r = this._el.getBoundingClientRect();
    this.zoomAt(scale / this._vp.scale, clientX ?? (r.left + r.width / 2), clientY ?? (r.top + r.height / 2));
  }
  // restore a saved viewport without echoing through onViewport (avoids a write-back loop)
  setViewport(vp) {
    if (!vp) return;
    this._vp = { tx: vp.tx || 0, ty: vp.ty || 0, scale: Math.max(0.1, Math.min(8, vp.scale || 1)) };
    this._applyViewport(true);
  }
  zoomAt(mult, clientX, clientY) {
    const r = this._el.getBoundingClientRect();
    const s = Math.max(0.1, Math.min(8, this._vp.scale * mult)), m = s / this._vp.scale;   // clamp, then real multiplier
    const fx = clientX - r.left, fy = clientY - r.top;          // cursor px from the net's current top-left
    this._vp.tx += fx * (1 - m); this._vp.ty += fy * (1 - m);   // keep the point under the cursor fixed
    this._vp.scale = s; this._applyViewport();
  }
  panBy(dx, dy) { this._vp.tx += dx; this._vp.ty += dy; this._applyViewport(); }
  resetViewport() { this._vp = { tx: 0, ty: 0, scale: 1 }; this._applyViewport(); }
  get viewport() { return this._vp; }

  // place a coord in the net → CSS px relative to the SVG top-left (for overlays);
  // 'attitude' [trend,plunge] follows rotation, 'figure' [u,v] is normalised (−1..1
  // about the centre, fixed under rotation). locate() is the inverse, for dragging.
  _k() { return (this._el.getBoundingClientRect().width || this.sn.size) / this.sn.size; }
  place(space, a, b) {
    const k = this._k();
    if (space === 'figure') { const L = this.sn.layout; return { x: (L.center + a * L.radius) * k, y: (L.center - b * L.radius) * k, hidden: false }; }
    const p = this.sn.project(conversions.lineToDcos(a, b));
    return { x: p.x * k, y: p.y * k, hidden: !!p.upper };
  }
  // project a direction-cosine straight through (no trend/plunge round-trip, which
  // would fold the upper hemisphere onto the lower and lose the `upper` flag — so
  // small circles spanning both hemispheres can be drawn/clipped correctly).
  placeDcos(d) { const k = this._k(), p = this.sn.project(d); return { x: p.x * k, y: p.y * k, hidden: !!p.upper }; }
  locate(space, x, y) {
    const k = this._k(), sx = x / k, sy = y / k;
    if (space === 'figure') { const L = this.sn.layout; return [(sx - L.center) / L.radius, (L.center - sy) / L.radius]; }
    const d = this.sn.unproject(sx, sy);
    return d ? conversions.dcosToLine(d) : null;
  }

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
    this.onAfterRender?.();
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
      case 'polyline': sn.curve(p.points, { stroke: st.color || st.stroke || '#000', strokeWidth: st.width || 1.5, class: cls(st, item) }); break;
      case 'text': { const [t, pl] = conversions.dcosToLine(p.dir); sn.text(t, pl, p.content, st); break; }
      case 'contour': sn.contour(p.dcos, { stroke: st.color || '#555', strokeWidth: 0.8, ...p.opts }); break;
      case 'heatmap': {
        if (p.opts.dihedra) {   // right-dihedra: a precomputed P/T grid through the same rasteriser
          const R = sn.rotation, rot = (v) => (R ? mat3.transformVec3(R, v) : v);
          const planes = p.dcos.map(rot), slips = (p.opts.slips || []).map(rot);
          if (!planes.length) break;
          const g = fault.dihedraGrid(planes, slips, { projection: this._proj, gridSize: 44 });
          let m = 0; for (const v of g.grid) if (!Number.isNaN(v) && Math.abs(v) > m) m = Math.abs(v);
          sn.heatmap(planes, { grid: g, max: m || 1, threshold: -2, color: dihedraColor });
          break;
        }
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
        if (this.mode === 'rotate' || this._rotKey) {   // drag (or Alt-drag in any mode) → arcball spin
          const arc = sn.arcball(cur.x, cur.y, p.x, p.y);
          sn.setRotation(mat3.orthonormalize(sn.rotation ? mat3.multiply(arc, sn.rotation) : arc));
          sn.updateContours(); sn.render();
          this.onAfterRender?.();
          this.onRotate?.(sn.rotation);
          cur = p;
        } else if (this.mode === 'measure' && moved && this._measure) {  // drag → measure A→B
          const b = sn.unproject(p.x, p.y);
          if (b) { this._measure.b = b; this.render(); if (this.onMeasure) this.onMeasure(this.measure()); }
        }
      } else {
        if (e.altKey) el.style.cursor = 'grab';                  // Alt anywhere → rotate affordance
        else if (this.mode === 'select') el.style.cursor = dsId(e.target, el) ? 'pointer' : 'default';
        if (this.onHover) this.onHover(sn.unproject(p.x, p.y));   // hover → read-out
      }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cur = toSvg(e); moved = false; this._downEl = e.target; this._rotKey = e.altKey;  // Alt held → temporary rotate
      el.setPointerCapture?.(e.pointerId); e.preventDefault();
      if (this.mode === 'rotate' || this._rotKey) el.style.cursor = 'grabbing';
      else if (this.mode === 'measure') { const a = sn.unproject(cur.x, cur.y); this._measure = a ? { a, b: null } : null; this.render(); }
    });
    el.addEventListener('pointerup', () => {
      const d = (cur && !moved) ? sn.unproject(cur.x, cur.y) : null;
      const wasClick = !moved, rotKey = this._rotKey;
      cur = null; this._rotKey = false;
      if (rotKey) { /* temporary rotate — no tool action */ }
      else if (this.mode === 'pick' && d && this.onPick) this.onPick(d);
      else if (this.mode === 'measure' && wasClick) { this._measure = null; this.render(); }  // click (no drag) cancels
      else if (this.mode === 'select' && wasClick) {
        const id = dsId(this._downEl, el);
        if (this.onSelect) this.onSelect(id);             // null = empty → deselect
        if (this.onIdentify && id && d) this.onIdentify(d, id);   // flash the nearest datum's table row
      }
      this._syncCursor();
    });
    el.addEventListener('pointerleave', () => { if (this.onHover) this.onHover(null); });
    el.addEventListener('contextmenu', (e) => {
      if (!this.onContextMenu) return;
      e.preventDefault();
      const p = toSvg(e);
      this.onContextMenu({ clientX: e.clientX, clientY: e.clientY, dcos: sn.unproject(p.x, p.y), id: dsId(e.target, el) });
    });
    this._syncCursor();
  }

  // GIS-like per-mode affordance: arrow to select, grab to spin, crosshair to measure, copy to pick-add
  _syncCursor() { this._el.style.cursor = this.mode === 'select' ? 'default' : this.mode === 'rotate' ? 'grab' : this.mode === 'pick' ? 'copy' : 'crosshair'; }
  setMode(m) { this.mode = m; this._syncCursor(); }
}
