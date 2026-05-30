/**
 * @module ui/app — the OSJS shell (reactive workspace).
 *
 * Layout: header (projection · pick · export · theme) · data tree · tabbed plot
 * area (projection / rose / fabric, one at a time) · inspector (rich properties
 * + global settings) · status footer (live cursor→attitude read-out). All
 * reactive off one Project via sideact. Net is interactive: drag to rotate, and
 * in pick mode click to add a measurement to the selected dataset.
 *
 * Note: sideact replaces the whole attribute on a binding, so a dynamic class
 * must return the FULL class string (no static prefix in the template).
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
const az = (x) => String(((Math.round(x) % 360) + 360) % 360).padStart(3, '0');
const p2 = (x) => String(Math.round(x)).padStart(2, '0');

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
  const [activeTab, setActiveTab] = signal('net');

  // ── plots ──
  const net = new NetRenderer(project, { size: 540 });
  const rose = new RoseRenderer(project, { size: 300 });
  const fabric = new FabricRenderer(project, { mode: 'woodcock', size: 300 });
  effect(() => { net.render(); rose.render(); fabric.render(); });

  // ── per-item stylesheet ──
  // Opacity, line-style and open/filled markers ride on CSS keyed to a `ds-<id>`
  // class the net renderer stamps on each element. SVG presentation attributes
  // lose to a class rule, so this overrides the engine's fill/stroke/width
  // without forking it — and these tweaks need no net re-render to take effect.
  const sheet = document.createElement('style');
  document.head.appendChild(sheet);
  const dash = (kind, w) => kind === 'dashed' ? `${w * 4} ${w * 3}` : kind === 'dotted' ? `${w} ${w * 2.4}` : 'none';
  function itemCSS(item) {
    const st = item.style(), c = `ds-${item.id}`, color = st.color || '#888';
    const op = st.opacity == null ? 1 : st.opacity;
    const open = st.pointFill === 'open';
    const ew = st.edgeWidth == null ? (open ? 1.2 : 0) : st.edgeWidth;
    const w = st.width || 1;
    return `.osjs-pole.${c},.osjs-line.${c}{fill:${open ? 'none' : color};stroke:${open || ew > 0 ? color : 'none'};stroke-width:${ew};opacity:${op};}\n`
         + `.osjs-plane.${c}{stroke:${color};stroke-dasharray:${dash(st.lineStyle, w)};opacity:${op};}\n`;
  }
  effect(() => { sheet.textContent = project.items().map(itemCSS).join(''); });

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
        <span class="nm">${() => item.name()}</span>
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

  // ── properties (rich) ──
  const propsHost = document.createElement('div');
  propsHost.className = 'props';
  effect(() => { propsHost.replaceChildren(propsFor(selected())); });
  // a segmented (radio-like) control over style; reads the live snapshot
  const styleSeg = (item, key, def, opts) => {
    const cur = () => item.style()[key] ?? def;
    const set = (v) => item.setStyle({ ...item.currentStyle(), [key]: v });
    return h`<span class="grp small">${opts.map(([v, l]) =>
      h`<button class=${() => (cur() === v ? 'seg on' : 'seg')} onclick=${() => set(v)}>${l}</button>`)}</span>`;
  };
  function propsFor(item) {
    if (!item) return h`<div class="muted">no dataset selected</div>`;
    const st = item.currentStyle();
    const set = (patch) => item.setStyle({ ...item.currentStyle(), ...patch });
    const opacityPct = Math.round((st.opacity == null ? 1 : st.opacity) * 100);

    // geometry controls differ per item type
    const geom = item.type === 'planes'
      ? h`<label>line width <input type="number" min="0.2" max="4" step="0.2" value=${st.width ?? 1} oninput=${(e) => set({ width: +e.target.value })}></label>
          <label>line style ${styleSeg(item, 'lineStyle', 'solid', [['solid', 'solid'], ['dashed', 'dashed'], ['dotted', 'dotted']])}</label>`
      : h`<label>point size <input type="number" min="1" max="12" step="0.5" value=${st.size ?? 4} oninput=${(e) => set({ size: +e.target.value })}></label>
          <label>marker ${styleSeg(item, 'pointFill', 'filled', [['filled', 'filled'], ['open', 'open']])}</label>
          <label>edge width <input type="number" min="0" max="3" step="0.2" value=${st.edgeWidth ?? 0} oninput=${(e) => set({ edgeWidth: +e.target.value })}></label>`;

    const s = item.stats();
    let statsNode;
    if (s) {
      const [mt, mp] = conversions.dcosToLine(s.fisher.mean);
      const k = (s.eigenvalues[0] - s.eigenvalues[1]) || 0, e2 = (s.eigenvalues[1] - s.eigenvalues[2]) || 0;
      const srow = (key, v) => h`<div class="srow"><span>${key}</span><b>${v}</b></div>`;
      statsNode = h`<div class="stats">
        ${srow('S₁ S₂ S₃', s.eigenvalues.map((v) => v.toFixed(3)).join('  '))}
        ${srow('strength (S₁−S₂, S₂−S₃)', `${k.toFixed(3)}  ${e2.toFixed(3)}`)}
        ${srow('Woodcock K · C', `${s.K.toFixed(2)} · ${s.C.toFixed(2)}`)}
        ${srow('Vollmer P G R', `${s.P.toFixed(2)} ${s.G.toFixed(2)} ${s.R.toFixed(2)}`)}
        ${srow('fabric', s.K > 1 ? 'cluster' : s.K < 1 ? 'girdle' : 'uniform')}
        ${srow('Fisher mean', `${az(mt)}/${p2(mp)}`)}
        ${srow('κ · α₉₅ · n', `${s.fisher.kappa.toFixed(1)} · ${s.fisher.alpha95.toFixed(1)}° · ${s.fisher.n}`)}
      </div>`;
    } else {
      statsNode = h`<div class="muted">${item.measurements().length} measurement(s) — need ≥2 for stats</div>`;
    }
    return h`<div class="pbody">
      <input class="nameedit" value=${item.currentName()} oninput=${(e) => item.setName(e.target.value)}>
      <div class="ptype">${item.type} · ${item.measurements().length} measurements</div>
      <div class="istit">style</div>
      <label>color <input type="color" value=${st.color || '#888888'} oninput=${(e) => set({ color: e.target.value })}></label>
      ${geom}
      ${(() => {
        const out = h`<span class="rngval">${opacityPct}%</span>`;
        return h`<label>opacity <input class="rng" type="range" min="10" max="100" step="5" value=${opacityPct}
          oninput=${(e) => { out.textContent = `${e.target.value}%`; set({ opacity: +e.target.value / 100 }); }}>${out}</label>`;
      })()}
      <div class="istit">statistics</div>
      ${statsNode}
    </div>`;
  }

  // ── settings (global) ──
  const methodSeg = (m, label) => h`<button class=${() => (project.contourMethod() === m ? 'seg on' : 'seg')} onclick=${() => project.setContourMethod(m)}>${label}</button>`;
  const settings = h`<div class="settings">
    <label>density <span class="grp small">${methodSeg('fisher', 'Fisher')}${methodSeg('kamb', 'Kamb')}</span></label>
    <label>rose bin <select onchange=${(e) => project.setRoseBinWidth(+e.target.value)}>
      ${[5, 10, 15, 20, 30].map((w) => h`<option value=${w} ${w === 10 ? 'selected' : null}>${w}°</option>`)}
    </select></label>
    <label>fabric <select onchange=${(e) => fabric.setMode(e.target.value)}>
      <option value="woodcock">Woodcock</option><option value="vollmer">Vollmer</option>
    </select></label>
  </div>`;

  // ── tabbed plots ──
  const tab = (key, label) => h`<button class=${() => (activeTab() === key ? 'tab on' : 'tab')} onclick=${() => setActiveTab(key)}>${label}</button>`;
  const wraps = {
    net: h`<div class="plotwrap">${net.element}</div>`,
    rose: h`<div class="plotwrap">${rose.element}</div>`,
    fabric: h`<div class="plotwrap">${fabric.element}</div>`,
  };
  effect(() => { for (const k in wraps) wraps[k].style.display = activeTab() === k ? 'flex' : 'none'; });

  // ── header / footer ──
  const projSeg = (proj, label) => h`<button class=${() => (project.projection() === proj ? 'seg on' : 'seg')} onclick=${() => project.setProjection(proj)}>${label}</button>`;
  const cursorText = () => {
    const d = cursor();
    if (!d) return '';
    const [t, p] = conversions.dcosToLine(d);
    const [dd, dip] = conversions.dcosToPlane(d);
    return `line ${az(t)}/${p2(p)}  ·  plane ${az(dd)}/${p2(dip)}`;
  };
  const countText = () => {
    let n = 0; for (const it of project.items()) n += it.measurements().length;
    return `${project.items().length} sets · ${n} measurements · ${project.projection()}, lower hemisphere`;
  };

  const app = h`<div class="osjs-app">
    <header class="topbar">
      <div class="brand"><span class="glyph">⌖</span><span class="name">OSJS</span><span class="sub">OpenStereo · web edition</span></div>
      <span class="spacer"></span>
      <div class="grp">${projSeg('equal-area', 'equal-area')}${projSeg('equal-angle', 'equal-angle')}</div>
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
      </aside>
      <main class="main">
        <div class="tabs">${tab('net', 'projection')}${tab('rose', 'rose')}${tab('fabric', 'fabric')}</div>
        <div class="plotarea">${wraps.net}${wraps.rose}${wraps.fabric}</div>
      </main>
      <aside class="inspector">
        <div class="sect">properties</div>
        ${propsHost}
        <div class="sect">settings</div>
        ${settings}
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
