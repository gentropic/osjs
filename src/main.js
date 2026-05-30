/**
 * @module main — wires the smallest working vertical slice of OSJS.
 *
 * Project (reactive model) → NetRenderer (one plot space) → mounted element,
 * with an effect() re-rendering the net whenever items / visibility / style
 * change. This is the architecture proving itself end to end; the rails
 * workspace, properties panels, rose/fabric spaces, and io adapters build out
 * from here without touching the core seam.
 */

import { effect } from '../vendor/sideact-signals.js';
import { Project, PlaneSet, PoleSet } from './core/model.js';
import { NetRenderer } from './render/net.js';

export function mount(el) {
  const project = new Project();
  project.add(new PlaneSet({
    name: 'bedding',
    style: { color: '#1aa39a', showPoles: false, width: 1 },
    measurements: [[120, 35], [125, 40], [118, 32], [130, 38], [122, 42], [127, 36]],
  }));
  project.add(new PoleSet({
    name: 'fault',
    style: { color: '#cc3333', size: 5 },
    measurements: [[210, 65]],
  }));

  const net = new NetRenderer(project);
  el.appendChild(net.element);
  effect(() => net.render()); // reactive: any model change re-renders the net

  return { project, net };
}

if (typeof document !== 'undefined') {
  const target = document.getElementById('osjs') || document.body;
  window.osjs = mount(target);
}
