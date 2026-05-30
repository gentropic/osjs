/**
 * @module render/net — the stereonet renderer (one plot space).
 *
 * Consumes the Project's `contribute('net')` primitives and draws them with
 * @gcu/bearing. Bearing's Stereonet already keeps a retained item scene that
 * diffs to the DOM, so we delegate diffing to it — we do NOT reimplement a
 * scene graph here. Arcball drag rotates the live element with no full redraw.
 *
 * v0: rebuilds bearing's item list each render() (bearing still diffs within
 * render). A later pass can map primitives → persistent bearing items keyed by
 * primitive.source for finer incrementality.
 */

import * as bearing from '../../vendor/bearing.mjs';

const { Stereonet, conversions, mat3 } = bearing;

const pointStyle = (st) => ({ fill: st.color || st.fill, stroke: st.stroke, r: st.size, class: st.class });
const lineStyle = (st) => ({ stroke: st.color || st.stroke, 'stroke-width': st.width, class: st.class });

export class NetRenderer {
  constructor(project, opts = {}) {
    this.project = project;
    this.sn = new Stereonet({ size: opts.size || 540, projection: project.projection(), classPrefix: 'osjs' });
    this._el = this.sn.element();
    this._wireArcball();
  }

  get element() { return this._el; }

  render() {
    const sn = this.sn;
    sn.clear();
    sn.clearContours();
    for (const p of this.project.contribute('net')) this._draw(p);
    sn.render();
  }

  _draw(p) {
    const sn = this.sn, st = p.style || {};
    switch (p.kind) {
      case 'point': {
        const [t, pl] = conversions.dcosToLine(p.dir);
        sn.line(t, pl, pointStyle(st)); break;
      }
      case 'greatCircle': {
        const [dd, dip] = conversions.dcosToPlane(p.pole);
        sn.plane(dd, dip, lineStyle(st)); break;
      }
      case 'smallCircle': {
        const [t, pl] = conversions.dcosToLine(p.axis);
        sn.cone(t, pl, p.angle, lineStyle(st)); break;
      }
      case 'text': {
        const [t, pl] = conversions.dcosToLine(p.dir);
        sn.text(t, pl, p.content, st); break;
      }
      case 'contour': {
        // bearing holds a single contour layer, so the last contour primitive
        // wins if multiple datasets enable contours (a known v0 limitation).
        sn.contour(p.dcos, { stroke: st.color || '#555', strokeWidth: 0.8, ...p.opts });
        break;
      }
      // polyline / fill / raster: TODO — motivates a couple of primitive-level
      // methods on bearing (point-at-dcos, polyline3d) so it's a cleaner backend.
      default: break;
    }
  }

  // Pointer-event arcball — the lesson learned in bearing's demo.
  _wireArcball() {
    const el = this._el, sn = this.sn;
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    let cur = null;
    const toSvg = (e) => {
      const r = el.getBoundingClientRect();
      const k = sn.size / r.width;
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    };
    el.addEventListener('pointerdown', (e) => {
      cur = toSvg(e); el.setPointerCapture?.(e.pointerId); el.style.cursor = 'grabbing'; e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!cur) return;
      const n = toSvg(e);
      const arc = sn.arcball(cur.x, cur.y, n.x, n.y);
      sn.setRotation(mat3.orthonormalize(sn.rotation ? mat3.multiply(arc, sn.rotation) : arc));
      sn.updateContours(); sn.render();
      cur = n;
    });
    const end = () => { cur = null; el.style.cursor = 'grab'; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}
