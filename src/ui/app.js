/**
 * @module ui/app — the OSJS shell (reactive workspace).
 *
 * Sidebar (data items + add-data + properties) driving three plot panels (net,
 * rose, fabric) off one reactive Project. Built with sideact: `each` for the
 * keyed item list, reactive `${() => …}` bindings for row state, and
 * effect()+replaceChildren for single-node swaps (properties, add-form). The
 * plots re-render via one effect on any data/style change; the net's arcball
 * drag stays net-only.
 *
 * Layout is a simple CSS grid for now; @gcu/rails docking is the next pass.
 */

import { signal, effect } from '../../vendor/sideact/signals.js';
import { h } from '../../vendor/sideact/dom.js';
import { each } from '../../vendor/sideact/render.js';
import { Project, ITEM_TYPES } from '../core/model.js';
import { NetRenderer } from '../render/net.js';
import { RoseRenderer } from '../render/rose.js';
import { FabricRenderer } from '../render/fabric.js';
import { parsePairs } from '../io/parse.js';

const PALETTE = ['#1aa39a', '#e8920c', '#cc3333', '#7a5cff', '#3a9a3a', '#c060c0', '#d4548a', '#5bb8d4'];

export function mountApp(root) {
  const project = new Project();
  project.add(new ITEM_TYPES.planes({
    name: 'bedding', style: { color: PALETTE[0], width: 1 },
    measurements: [[120, 35], [125, 40], [118, 32], [130, 38], [122, 42], [127, 36], [115, 30], [124, 41]],
  }));
  project.add(new ITEM_TYPES.poles({
    name: 'joints', style: { color: PALETTE[1], size: 4 },
    measurements: [[210, 78], [214, 82], [206, 75], [218, 80], [203, 84], [212, 71]],
  }));

  const [selected, setSelected] = signal(project.items()[0] || null);

  // ── plots ──
  const net = new NetRenderer(project, { size: 520 });
  const rose = new RoseRenderer(project, { size: 260 });
  const fabric = new FabricRenderer(project, { mode: 'woodcock', size: 260 });
  effect(() => { net.render(); rose.render(); fabric.render(); });

  // ── data tree (datasets expand into toggleable layers) ──
  const checkbox = (checked, onToggle, stop) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!checked;        // .checked PROPERTY (not attribute)
    cb.onchange = (e) => onToggle(e.target.checked);
    if (stop) cb.onclick = (e) => e.stopPropagation();
    return cb;
  };

  const row = (item) => {
    const [expanded, setExpanded] = signal(false);
    const vis = checkbox(item.currentVisible(), (v) => item.setVisible(v), true);

    const kids = document.createElement('div');
    kids.className = 'kids';
    for (const L of item.constructor.LAYERS || []) {
      const cb = checkbox(item.currentLayers()[L.key], () => item.toggleLayer(L.key));
      kids.append(h`<label class="layer">${cb}<span>${L.label}</span></label>`);
    }
    const kidsWrap = h`<div class="kidswrap">${kids}</div>`;
    effect(() => { kidsWrap.style.display = expanded() ? 'block' : 'none'; });

    return h`<div class="ds">
      <div class="it ${() => (selected() === item ? 'sel' : '')}" onclick=${() => setSelected(item)}>
        <button class="caret" onclick=${(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>${() => (expanded() ? '▾' : '▸')}</button>
        ${vis}
        <span class="sw" style=${() => ({ background: item.style().color || '#888' })}></span>
        <span class="nm">${() => item.name}</span>
        <span class="ty">${item.type}</span>
        <button class="rm" title="remove" onclick=${(e) => {
          e.stopPropagation(); project.remove(item);
          if (selected() === item) setSelected(project.items()[0] || null);
        }}>×</button>
      </div>
      ${kidsWrap}
    </div>`;
  };
  const list = each(project.items, row, (it) => it.id);

  // ── add-data form (toggled) ──
  const [adding, setAdding] = signal(false);
  const addHost = document.createElement('div');
  effect(() => { addHost.replaceChildren(adding() ? addForm() : addButton()); });

  function addButton() {
    return h`<button class="add" onclick=${() => setAdding(true)}>+ add data</button>`;
  }
  function addForm() {
    const type = signal('planes');
    const name = signal('');
    const ta = h`<textarea class="ta" rows="5" placeholder="120 35\n125 40\n…  (dip dir / dip, or trend / plunge)"></textarea>`;
    const sel = h`<select onchange=${(e) => type[1](e.target.value)}>
        <option value="planes">planes (great circles)</option>
        <option value="poles">poles</option>
        <option value="lines">lines</option>
      </select>`;
    const nm = h`<input class="ni" placeholder="name" oninput=${(e) => name[1](e.target.value)}>`;
    const commit = () => {
      const pairs = parsePairs(ta.value);
      if (pairs.length) {
        const Cls = ITEM_TYPES[type[0]()] || ITEM_TYPES.planes;
        const color = PALETTE[project.items().length % PALETTE.length];
        const it = project.add(new Cls({ name: name[0]() || type[0](), style: { color, width: 1, size: 4 }, measurements: pairs }));
        setSelected(it);
      }
      setAdding(false);
    };
    return h`<div class="form">
      <div class="frow">${sel}${nm}</div>
      ${ta}
      <div class="frow">
        <button class="go" onclick=${commit}>add</button>
        <button onclick=${() => setAdding(false)}>cancel</button>
      </div>
    </div>`;
  }

  // ── properties (swaps with selection) ──
  const propsHost = document.createElement('div');
  propsHost.className = 'props';
  effect(() => { propsHost.replaceChildren(propsFor(selected())); });

  function propsFor(item) {
    if (!item) return h`<div class="muted">no selection</div>`;
    const st = item.currentStyle();                       // untracked: props rebuilds on selection only
    const set = (patch) => item.setStyle({ ...item.currentStyle(), ...patch });
    const sizeCtl = item.type === 'planes'
      ? h`<label>width <input type="number" min="0.2" max="4" step="0.2" value=${st.width ?? 1} oninput=${(e) => set({ width: +e.target.value })}></label>`
      : h`<label>size <input type="number" min="1" max="10" step="0.5" value=${st.size ?? 4} oninput=${(e) => set({ size: +e.target.value })}></label>`;
    const s = item.stats();
    const statline = s
      ? `S₁ ${s.eigenvalues[0].toFixed(3)} · K ${s.K.toFixed(2)} · C ${s.C.toFixed(2)} · n ${s.fisher.n}`
      : `${item.measurements().length} measurement(s)`;
    return h`<div class="pbody">
      <div class="phead">${item.name} <span class="ty">${item.type}</span></div>
      <label>colour <input type="color" value=${st.color || '#888888'} oninput=${(e) => set({ color: e.target.value })}></label>
      ${sizeCtl}
      <div class="stat">${statline}</div>
    </div>`;
  }

  // fabric mode toggle
  const fabricToggle = h`<select class="fmode" onchange=${(e) => fabric.setMode(e.target.value)}>
      <option value="woodcock">Woodcock</option>
      <option value="vollmer">Vollmer</option>
    </select>`;

  // ── layout ──
  const app = h`<div class="osjs-app">
    <header class="topbar">
      <div class="brand">
        <span class="glyph">⌖</span><span class="name">OSJS</span>
        <span class="sub">OpenStereo · web edition</span>
      </div>
      <span class="spacer"></span>
    </header>
    <div class="body">
      <aside class="side">
        <div class="sect">data <span class="count">${() => project.items().length}</span></div>
        <div class="list">${list}</div>
        ${addHost}
        <div class="sect">properties</div>
        ${propsHost}
      </aside>
      <main class="main">${net.element}</main>
      <aside class="aux">
        <div class="panel"><div class="sect">rose</div><div class="panel-body">${rose.element}</div></div>
        <div class="panel"><div class="sect">fabric ${fabricToggle}</div><div class="panel-body">${fabric.element}</div></div>
      </aside>
    </div>
  </div>`;

  root.replaceChildren(app);
  return { project, net, rose, fabric, select: setSelected };
}
