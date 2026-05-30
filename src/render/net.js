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

const { Stereonet, conversions, mat3 } = bearing;

// The host injects a per-item stylesheet keyed on `ds-<id>` (see ui/app.js), so
// opacity, line-style (dash) and open/filled markers are CSS — SVG presentation
// attributes lose to a class rule, so the engine's fill/stroke get overridden.
const cls = (st, item) => [item && `ds-${item}`, st.class].filter(Boolean).join(' ') || undefined;
const pointStyle = (st, item) => ({ fill: st.color || st.fill, stroke: st.stroke, r: st.size, class: cls(st, item) });
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
    this.pickMode = false;
    this.onHover = null;
    this.onPick = null;
    this._proj = null;
    this._rebuild(project.projection());
  }

  get element() { return this._el; }

  _rebuild(projection) {
    this._proj = projection;
    const next = new Stereonet({ size: this._size, projection, classPrefix: 'osjs' });
    const el = next.element();
    if (this._el && this._el.parentNode) this._el.replaceWith(el);
    this.sn = next;
    this._el = el;
    this._wirePointer();
  }

  render() {
    const proj = this.project.projection();
    if (proj !== this._proj) this._rebuild(proj);
    const sn = this.sn;
    sn.clear();
    sn.clearContours();
    sn.clearHeatmap();
    for (const p of this.project.contribute('net')) this._draw(p);
    sn.render();
  }

  _draw(p) {
    const sn = this.sn, st = p.style || {}, item = p.source && p.source.item;
    switch (p.kind) {
      case 'point': { const [t, pl] = conversions.dcosToLine(p.dir); sn.line(t, pl, pointStyle(st, item)); break; }
      case 'greatCircle': { const [dd, dip] = conversions.dcosToPlane(p.pole); sn.plane(dd, dip, lineStyle(st, item)); break; }
      case 'smallCircle': { const [t, pl] = conversions.dcosToLine(p.axis); sn.cone(t, pl, p.angle, lineStyle(st, item)); break; }
      case 'text': { const [t, pl] = conversions.dcosToLine(p.dir); sn.text(t, pl, p.content, st); break; }
      case 'contour': sn.contour(p.dcos, { stroke: st.color || '#555', strokeWidth: 0.8, method: this.project.contourMethod(), ...p.opts }); break;
      case 'heatmap': sn.heatmap(p.dcos, { color: (t) => rgba(st.color, 0.1 + 0.8 * t), method: this.project.contourMethod(), ...p.opts }); break;
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
      if (cur) {                                   // dragging → arcball
        if (Math.hypot(p.x - cur.x, p.y - cur.y) > 1) moved = true;
        const arc = sn.arcball(cur.x, cur.y, p.x, p.y);
        sn.setRotation(mat3.orthonormalize(sn.rotation ? mat3.multiply(arc, sn.rotation) : arc));
        sn.updateContours(); sn.render();
        cur = p;
      } else if (this.onHover) {                   // hover → read-out
        this.onHover(sn.unproject(p.x, p.y));
      }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cur = toSvg(e); moved = false; el.setPointerCapture?.(e.pointerId); e.preventDefault();
    });
    el.addEventListener('pointerup', () => {
      if (cur && !moved && this.pickMode && this.onPick) {
        const d = sn.unproject(cur.x, cur.y);
        if (d) this.onPick(d);
      }
      cur = null;
    });
    el.addEventListener('pointerleave', () => { if (this.onHover) this.onHover(null); });
    this._syncCursor();
  }

  _syncCursor() { this._el.style.cursor = this.pickMode ? 'crosshair' : 'grab'; }
  setPickMode(on) { this.pickMode = on; this._syncCursor(); }
}
