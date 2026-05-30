/**
 * @module main — the smallest working vertical slice of OSJS.
 *
 * One reactive Project drives THREE plot spaces at once — net (interactive),
 * rose, and fabric — each a renderer consuming the same model via
 * contribute(space). A single effect() re-renders all three on any data/style
 * change; rotating the net (arcball) updates only the net, since rose/fabric are
 * rotation-independent. This is the "one model, many spaces" design proving out.
 */

import { effect } from '../vendor/sideact-signals.js';
import { Project, PlaneSet, PoleSet } from './core/model.js';
import { NetRenderer } from './render/net.js';
import { RoseRenderer } from './render/rose.js';
import { FabricRenderer } from './render/fabric.js';

export function mount(el) {
  const project = new Project();
  project.add(new PlaneSet({
    name: 'bedding',
    style: { color: '#1aa39a', showPoles: false, width: 1 },
    measurements: [[120, 35], [125, 40], [118, 32], [130, 38], [122, 42], [127, 36], [115, 30], [124, 41]],
  }));
  project.add(new PoleSet({
    name: 'joints',
    style: { color: '#e8920c', size: 4 },
    measurements: [[210, 78], [214, 82], [206, 75], [218, 80], [203, 84], [212, 71]],
  }));

  const net = new NetRenderer(project, { size: 540 });
  const rose = new RoseRenderer(project, { size: 300 });
  const fabric = new FabricRenderer(project, { mode: 'woodcock', size: 300 });

  el.style.display = 'flex';
  el.style.gap = '20px';
  el.style.alignItems = 'flex-start';
  const side = document.createElement('div');
  side.style.cssText = 'display:flex;flex-direction:column;gap:16px';
  el.append(net.element, side);
  side.append(rose.element, fabric.element);

  effect(() => { net.render(); rose.render(); fabric.render(); });

  return { project, net, rose, fabric };
}

if (typeof document !== 'undefined') {
  const target = document.getElementById('osjs') || document.body;
  window.osjs = mount(target);
}
