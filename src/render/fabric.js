/**
 * @module render/fabric — the fabric-diagram plot space (Woodcock or Vollmer).
 *
 * Each visible item contributes one 'fabric' descriptor ({ dcos, style, label });
 * this renderer turns the set into a single overlaid diagram via bearing's
 * fabricplot (which already plots one point per dataset). Rotation-independent,
 * so it doesn't re-render on net drags — only on data/style changes.
 */

import * as bearing from '../../vendor/bearing.mjs';

const { fabricplot } = bearing;

export class FabricRenderer {
  constructor(project, opts = {}) {
    this.project = project;
    this.mode = opts.mode || 'woodcock'; // 'woodcock' | 'vollmer'
    this.size = opts.size || 320;
    this._el = document.createElement('div');
  }

  get element() { return this._el; }

  setMode(mode) { this.mode = mode; this.render(); }

  render() {
    const datasets = this.project.contribute('fabric').map((c) => ({
      dcos: c.dcos,
      color: c.style && (c.style.color || c.style.fill),
      label: c.label,
    }));
    const svg = this.mode === 'vollmer'
      ? fabricplot.vollmerSVG(datasets, { size: this.size })
      : fabricplot.woodcockSVG(datasets, { size: this.size });
    this._el.innerHTML = svg;
  }
}
