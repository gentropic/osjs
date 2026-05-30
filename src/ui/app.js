/**
 * @module ui/app — the OSJS shell (reactive workspace).
 *
 * Header (projection · pick · export · theme), a sidebar (layered data tree +
 * add-data + properties), three plot panels (net · rose · fabric), and a status
 * footer with a live cursor→attitude read-out — all reactive off one Project via
 * sideact. The net is interactive: drag to rotate, and in pick mode click to add
 * a measurement to the selected dataset.
 *
 * Note: sideact's attribute binding replaces the whole attribute, so a dynamic
 * class must return the FULL class string (no static prefix in the template).
 */

import { signal, effect } from '../../vendor/sideact/signals.js';
import { h } from '../../vendor/sideact/dom.js';
import { each } from '../../vendor/sideact/render.js';
import * as bearing from '../../vendor/bearing.mjs';
import { Project, ITEM_TYPES } from '../core/model.js';
import { NetRenderer } from '../render/net.js';
import { RoseRenderer } from '../render/rose.js';
import { FabricRenderer } from '../render/fabric.js';
import { parsePairs } from '../io/parse.js';

const { conversions } = bearing;
const PALETTE = ['#1aa39a', '#e8920c', '#cc3333', '#7a5cff', '#3a9a3a', '#c060c0', '#d4548a', '#5bb8d4'];
const pad = (x) => String(((Math.round(x) % 360) + 360) % 360).padStart(3, '0');
const pad2 = (x) => String(Math.round(x)).padStart(2, '0');

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
  const [theme, setTheme] = signal('light');
  const [pick, setPick] = signal(false);
  const [cursor, setCursor] = signal(null);

  // ── plots ──
  const net = new NetRenderer(project, { size: 520 });
  const rose = new RoseRenderer(project, { size: 260 });
  const fabric = new FabricRenderer(project, { mode: 'woodcock', size: 260 });
  effect(() => { net.render(); rose.render(); fabric.render(); });

  net.onHover = (d) => setCursor(d);
  net.onPick = (d) => {
    const it = selected();
    if (!it) return;
    const pair = it.type === 'lines' ? conversions.dcosToLine(d) : conversions.dcosToPlane(d);
    it.setMeasurements([...it.measurements(), [Math.round(pair[0]), Math.round(pair[1])]]);
  };
  effect(() => document.body.classList.toggle('theme-dark', theme() === 'dark'));

  // ── data tree ──
  const checkbox = (checked, onToggle, stop) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!checked;
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
      <div class=${() => (selected() === item ? 'it sel' : 'it')} onclick=${() => setSelected(item)}>
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

  // ── add-data ──
  const [adding, setAdding] = signal(false);
  const addHost = document.createElement('div');
  effect(() => { addHost.replaceChildren(adding() ? addForm() : addButton()); });
  function addButton() { return h`<button class="add" onclick=${() => setAdding(true)}>+ add data</button>`; }
  function addForm() {
    const type = signal('planes'), name = signal('');
    const ta = h`<textarea class="ta" rows="5" placeholder="120 35\n125 40\n…  dip dir / dip  ·  or trend / plunge"></textarea>`;
    const sel = h`<select onchange=${(e) => type[1](e.target.value)}>
        <option value="planes">planes (great circles)</option>
        <option value="poles">poles</option><option value="lines">lines</option></select>`;
    const nm = h`<input class="ni" placeholder="name" oninput=${(e) => name[1](e.target.value)}>`;
    const commit = () => {
      const pairs = parsePairs(ta.value);
      if (pairs.length) {
        const Cls = ITEM_TYPES[type[0]()] || ITEM_TYPES.planes;
        const color = PALETTE[project.items().length % PALETTE.length];
        setSelected(project.add(new Cls({ name: name[0]() || type[0](), style: { color, width: 1, size: 4 }, measurements: pairs })));
      }
      setAdding(false);
    };
    return h`<div class="form"><div class="frow">${sel}${nm}</div>${ta}
      <div class="frow"><button class="go" onclick=${commit}>add</button>
      <button onclick=${() => setAdding(false)}>cancel</button></div></div>`;
  }

  // ── properties ──
  const propsHost = document.createElement('div');
  propsHost.className = 'props';
  effect(() => { propsHost.replaceChildren(propsFor(selected())); });
  function propsFor(item) {
    if (!item) return h`<div class="muted">no selection</div>`;
    const st = item.currentStyle();
    const set = (patch) => item.setStyle({ ...item.currentStyle(), ...patch });
    const sizeCtl = item.type === 'planes'
      ? h`<label>width <input type="number" min="0.2" max="4" step="0.2" value=${st.width ?? 1} oninput=${(e) => set({ width: +e.target.value })}></label>`
      : h`<label>size <input type="number" min="1" max="10" step="0.5" value=${st.size ?? 4} oninput=${(e) => set({ size: +e.target.value })}></label>`;
    const s = item.stats();
    const stat = s ? `S₁ ${s.eigenvalues[0].toFixed(3)} · K ${s.K.toFixed(2)} · C ${s.C.toFixed(2)} · n ${s.fisher.n}`
      : `${item.measurements().length} measurement(s)`;
    return h`<div class="pbody">
      <div class="phead">${item.name} <span class="ty">${item.type}</span></div>
      <label>colour <input type="color" value=${st.color || '#888888'} oninput=${(e) => set({ color: e.target.value })}></label>
      ${sizeCtl}
      <div class="stat">${stat}</div></div>`;
  }

  // ── header / footer ──
  const seg = (proj, label) => h`<button class=${() => (project.projection() === proj ? 'seg on' : 'seg')}
      onclick=${() => project.setProjection(proj)}>${label}</button>`;
  const fabricToggle = h`<select class="fmode" onchange=${(e) => fabric.setMode(e.target.value)}>
      <option value="woodcock">Woodcock</option><option value="vollmer">Vollmer</option></select>`;

  const cursorText = () => {
    const d = cursor();
    if (!d) return '';
    const [t, p] = conversions.dcosToLine(d);
    const [dd, dip] = conversions.dcosToPlane(d);
    return `line ${pad(t)}/${pad2(p)}  ·  plane ${pad(dd)}/${pad2(dip)}`;
  };
  const countText = () => {
    let n = 0; for (const it of project.items()) n += it.measurements().length;
    return `${project.items().length} sets · ${n} measurements · ${project.projection()}, lower hemisphere`;
  };

  const app = h`<div class="osjs-app">
    <header class="topbar">
      <div class="brand"><span class="glyph">⌖</span><span class="name">OSJS</span><span class="sub">OpenStereo · web edition</span></div>
      <span class="spacer"></span>
      <div class="grp">${seg('equal-area', 'equal-area')}${seg('equal-angle', 'equal-angle')}</div>
      <button class=${() => (pick() ? 'btn on' : 'btn')} title="click the net to add a measurement to the selected set"
        onclick=${() => { const v = !pick(); setPick(v); net.setPickMode(v); }}>pick</button>
      <button class="btn" onclick=${() => net.sn.download('stereonet.svg')}>SVG</button>
      <button class="btn" onclick=${() => net.sn.downloadPNG('stereonet.png', { scale: 2, background: '#ffffff' })}>PNG</button>
      <button class="btn icon" title="toggle theme" onclick=${() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>${() => (theme() === 'dark' ? '☀' : '☾')}</button>
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
    <footer class="statusbar">
      <span class="cur">${() => cursorText()}</span>
      <span class="spacer"></span>
      <span class="cnt">${() => countText()}</span>
    </footer>
  </div>`;

  root.replaceChildren(app);
  return { project, net, rose, fabric, select: setSelected };
}
