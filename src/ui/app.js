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
import { Project, ITEM_TYPES, serializeProject, loadProject, isGroup } from '../core/model.js';
import { NetRenderer } from '../render/net.js';
import { RoseRenderer } from '../render/rose.js';
import { FabricRenderer } from '../render/fabric.js';
import { parsePairs, parseTriples, parseTable, guessRoles, buildFromTable } from '../io/parse.js';

const { conversions, color } = bearing;
const RAMPS = ['viridis', 'magma', 'inferno', 'plasma', 'thermal', 'grayscale'];
const PALETTE = ['#1aa39a', '#e8920c', '#cc3333', '#7a5cff', '#3a9a3a', '#c060c0', '#d4548a', '#5bb8d4'];
const az = (x) => String(((Math.round(x) % 360) + 360) % 360).padStart(3, '0');
const p2 = (x) => String(Math.round(x)).padStart(2, '0');
const fmtNum = (x) => (Number.isInteger(x) ? String(x) : Math.abs(x) >= 100 ? String(Math.round(x)) : x.toFixed(2));

const LS_KEY = 'osjs-project';
const lsGet = (k) => { try { return typeof localStorage !== 'undefined' && localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch { /* opaque origin / disabled */ } };

function seed(project) {
  project.add(new ITEM_TYPES.planes({
    name: 'bedding', style: { color: PALETTE[0], width: 1 },
    measurements: [[120, 35], [125, 40], [118, 32], [130, 38], [122, 42], [127, 36], [115, 30], [124, 41]],
  }));
  project.add(new ITEM_TYPES.poles({
    name: 'joints', style: { color: PALETTE[1], size: 4 },
    measurements: [[210, 78], [214, 82], [206, 75], [218, 80], [203, 84], [212, 71]],
  }));
}

export function mountApp(root) {
  const project = new Project();
  // restore the last session if one was saved, else seed the demo data
  let restored = false;
  const saved = lsGet(LS_KEY);
  if (saved) { try { loadProject(project, JSON.parse(saved)); restored = project.items().length > 0; } catch { /* corrupt → seed */ } }
  if (!restored) seed(project);

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

  // ── persistence: autosave to localStorage; explicit save/open as a file ──
  const touchTree = (list) => list.forEach((n) => {
    n.name(); n.visible();
    if (isGroup(n)) { n.expanded(); touchTree(n.children()); }
    else { n.measurements(); n.style(); n.params(); n.layers(); n.columns(); }
  });
  effect(() => {
    touchTree(project.nodes());                              // subscribe to the whole tree
    project.projection(); project.roseBinWidth();
    lsSet(LS_KEY, JSON.stringify(serializeProject(project)));
  });
  const saveProject = () => {
    const blob = new Blob([JSON.stringify(serializeProject(project), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'project.osjs.json';
    a.click(); URL.revokeObjectURL(a.href);
  };
  const openInput = document.createElement('input');
  openInput.type = 'file'; openInput.accept = '.json,.osjs,application/json';
  openInput.onchange = async () => {
    const f = openInput.files && openInput.files[0]; if (!f) return;
    try { loadProject(project, JSON.parse(await f.text())); setSelected(project.items()[0] || null); }
    catch (e) { console.error('open project failed', e); }
    openInput.value = '';
  };

  // ── per-item stylesheet ──
  // Opacity, line-style and open/filled markers ride on CSS keyed to a `ds-<id>`
  // class the net renderer stamps on each element. SVG presentation attributes
  // lose to a class rule, so this overrides the engine's fill/stroke/width
  // without forking it — and these tweaks need no net re-render to take effect.
  const sheet = document.createElement('style');
  document.head.appendChild(sheet);
  const dash = (kind, w) => kind === 'dashed' ? `${w * 4} ${w * 3}` : kind === 'dotted' ? `${w} ${w * 2.4}` : 'none';
  function itemCSS(item) {
    // colour is on the SVG attribute (per-datum capable); CSS owns only what the
    // engine can't set per primitive — opacity, point edge-width, plane dash.
    const st = item.style(), c = `ds-${item.id}`;
    const op = st.opacity == null ? 1 : st.opacity;
    const ew = st.edgeWidth == null ? (st.pointFill === 'open' ? 1.2 : 0) : st.edgeWidth;
    const w = st.width || 1;
    return `.osjs-pole.${c},.osjs-line.${c}{stroke-width:${ew};opacity:${op};}\n`
         + `.osjs-plane.${c}{stroke-dasharray:${dash(st.lineStyle, w)};opacity:${op};}\n`;
  }
  effect(() => { sheet.textContent = project.items().map(itemCSS).join(''); });

  net.onHover = (d) => setCursor(d);
  net.onPick = (d) => {
    const it = selected();
    if (!it || isGroup(it)) return;
    const lineLike = it.type === 'lines' || it.type === 'smallcircle';
    const [a, b] = lineLike ? conversions.dcosToLine(d) : conversions.dcosToPlane(d);
    const datum = it.type === 'smallcircle' ? [Math.round(a), Math.round(b), 30] : [Math.round(a), Math.round(b)];
    it.setMeasurements([...it.measurements(), datum]);
  };
  effect(() => document.body.classList.toggle('theme-dark', theme() === 'dark'));

  // ── data tree (nestable groups + data items, HTML5 drag-drop) ──
  const checkbox = (checked, onToggle, stop) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!checked;
    cb.onchange = (e) => onToggle(e.target.checked);
    if (stop) cb.onclick = (e) => e.stopPropagation();
    return cb;
  };
  let dragNode = null;
  const reselectAfterRemove = (node) => { if (selected() === node) setSelected(project.items()[0] || null); };
  // wire a tree row as a drag source + drop target. dropInto=true → reparent into
  // a group; otherwise drop places the dragged node right after this one.
  const wireDnD = (el, node, dropInto) => {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => { dragNode = node; e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragover', (e) => { if (dragNode && dragNode !== node) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove('drop');
      const d = dragNode; dragNode = null;
      if (!d || d === node) return;
      if (dropInto) project.move(d, node, null);                         // into the group
      else { const p = project.parentOf(node); const list = p ? p.children() : project.nodes(); project.move(d, p, list.indexOf(node) + 1); }
    });
  };
  const nodeRow = (node) => (isGroup(node) ? groupRow(node) : itemRow(node));
  const renderNodes = (nodesFn) => each(nodesFn, nodeRow, (n) => n.id);
  function groupRow(group) {
    const vis = checkbox(group.currentVisible(), (v) => group.setVisible(v), true);
    const kidsWrap = h`<div class="kidswrap grp-kids">${renderNodes(group.children)}</div>`;
    effect(() => { kidsWrap.style.display = group.expanded() ? 'block' : 'none'; });
    const rowEl = h`<div class=${() => (selected() === group ? 'it grp-row sel' : 'it grp-row')} onclick=${() => setSelected(group)}>
        <button class="caret" onclick=${(e) => { e.stopPropagation(); group.setExpanded(!group.currentExpanded()); }}>${() => (group.expanded() ? '▾' : '▸')}</button>
        ${vis}<span class="folder">▣</span>
        <span class="nm">${() => group.name()}</span>
        <span class="ty">group</span>
        <button class="rm" title="remove group (keeps children at root)" onclick=${(e) => {
          e.stopPropagation(); const p = project.parentOf(group);
          group.currentChildren().slice().reverse().forEach((c) => project.move(c, p, 0));   // lift children out
          project.remove(group); reselectAfterRemove(group);
        }}>×</button>
      </div>`;
    wireDnD(rowEl, group, true);
    return h`<div class="ds">${rowEl}${kidsWrap}</div>`;
  }
  function itemRow(item) {
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
    const rowEl = h`<div class=${() => (selected() === item ? 'it sel' : 'it')} onclick=${() => setSelected(item)}>
        <button class="caret" onclick=${(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>${() => (expanded() ? '▾' : '▸')}</button>
        ${vis}
        <span class="sw" style=${() => ({ background: item.style().color || '#888' })}></span>
        <span class="nm">${() => item.name()}</span>
        <span class="ty">${item.type}</span>
        <button class="rm" title="remove" onclick=${(e) => { e.stopPropagation(); project.remove(item); reselectAfterRemove(item); }}>×</button>
      </div>`;
    wireDnD(rowEl, item, false);
    return h`<div class="ds">${rowEl}${kidsWrap}</div>`;
  }
  const list = renderNodes(project.nodes);

  // ── add-data ──
  const [adding, setAdding] = signal(false);
  const addHost = document.createElement('div');
  effect(() => { addHost.replaceChildren(adding() ? addForm() : addButton()); });
  function addButton() { return h`<button class="add" onclick=${() => setAdding(true)}>+ add data</button>`; }
  // an imperative column <select> (value is an IDL property, not an attribute)
  function colSelect(cols, selected, allowNone, onChange) {
    const s = document.createElement('select');
    if (allowNone) { const o = document.createElement('option'); o.value = '-1'; o.textContent = '— none —'; s.appendChild(o); }
    cols.forEach((c, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = c.name; s.appendChild(o); });
    s.value = String(selected);
    s.onchange = () => onChange(parseInt(s.value, 10));
    return s;
  }
  function addForm() {
    const type = signal('planes');
    const [table, setTable] = signal(null);
    const map = { azIdx: 0, dipIdx: 1, colorBy: -1 };  // read at commit time
    const ta = h`<textarea class="ta" rows="5" placeholder="paste pairs (120 35) or CSV/TSV with a header row"></textarea>`;
    const nm = h`<input class="ni" placeholder="name">`;
    const typeSel = h`<select onchange=${(e) => type[1](e.target.value)}>
        <option value="planes">planes (great circles)</option>
        <option value="poles">poles</option><option value="lines">lines</option>
        <option value="smallcircle">small circles (t/p/aperture)</option></select>`;
    const fileIn = document.createElement('input');
    fileIn.type = 'file'; fileIn.accept = '.csv,.tsv,.txt,.dat'; fileIn.className = 'file';
    fileIn.onchange = async () => {
      const f = fileIn.files && fileIn.files[0]; if (!f) return;
      ta.value = await f.text();
      if (!nm.value) nm.value = f.name.replace(/\.[^.]+$/, '');
      detect();
    };
    const detect = () => {
      const tbl = parseTable(ta.value);
      if (tbl.columns.length > 2) Object.assign(map, guessRoles(tbl.columns), { colorBy: -1 });
      setTable(tbl);
    };
    ta.addEventListener('input', detect);

    // column-mapping UI, shown only for multi-column tables
    const mapHost = document.createElement('div');
    effect(() => {
      const tbl = table();
      if (!tbl || tbl.columns.length <= 2 || type[0]() === 'smallcircle') { mapHost.replaceChildren(); return; }
      const fld = (label, sel) => h`<label class="mrow"><span class="fk">${label}</span>${sel}</label>`;
      mapHost.replaceChildren(h`<div class="mapping">
        <div class="mhint">${tbl.columns.length} columns · ${tbl.rows.length} rows</div>
        ${fld('azimuth', colSelect(tbl.columns, map.azIdx, false, (v) => { map.azIdx = v; }))}
        ${fld('dip / plunge', colSelect(tbl.columns, map.dipIdx, false, (v) => { map.dipIdx = v; }))}
        ${fld('color by', colSelect(tbl.columns, map.colorBy, true, (v) => { map.colorBy = v; }))}
      </div>`);
    });

    const commit = () => {
      const Cls = ITEM_TYPES[type[0]()] || ITEM_TYPES.planes;
      const color = PALETTE[project.items().length % PALETTE.length];
      const tbl = table();
      let payload;
      if (type[0]() === 'smallcircle') {
        const triples = parseTriples(ta.value);
        if (!triples.length) { setAdding(false); return; }
        payload = { measurements: triples, style: { color, width: 1, size: 4 } };
      } else if (tbl && tbl.columns.length > 2) {
        const built = buildFromTable(tbl, map);
        if (!built.measurements.length) { setAdding(false); return; }
        const style = { color, width: 1, size: 4 };
        if (map.colorBy >= 0) {
          const vals = built.columns[map.colorBy].values;
          const numeric = vals.some((v) => v !== '' && Number.isFinite(parseFloat(v)))
            && vals.every((v) => v === '' || Number.isFinite(parseFloat(v)));
          style.colorMode = numeric ? 'ramp' : 'categorical';
          style.colorBy = map.colorBy;
          if (numeric) style.colorRamp = 'viridis';
        }
        payload = { measurements: built.measurements, columns: built.columns, style };
      } else {
        const pairs = parsePairs(ta.value);
        if (!pairs.length) { setAdding(false); return; }
        payload = { measurements: pairs, style: { color, width: 1, size: 4 } };
      }
      payload.name = nm.value || type[0]();
      setSelected(project.add(new Cls(payload)));
      setAdding(false);
    };
    return h`<div class="form"><div class="frow">${typeSel}${nm}</div>
      ${fileIn}${ta}${mapHost}
      <div class="frow"><button class="go" onclick=${commit}>add</button>
      <button onclick=${() => setAdding(false)}>cancel</button></div></div>`;
  }

  // ── reactive inspector building blocks ──
  // All are `function` declarations (hoisted): the props effect below runs
  // synchronously on creation and reaches these before their line — a `const`
  // arrow would be in its TDZ. Each returns nodes whose class/state bindings
  // read item signals, so they stay live WITHOUT rebuilding propsFor (which
  // would steal focus from number inputs).
  function seg(cur, set, opts) {
    return h`<span class="grp small">${opts.map(([v, l]) =>
      h`<button class=${() => (cur() === v ? 'seg on' : 'seg')} onclick=${() => set(v)}>${l}</button>`)}</span>`;
  }
  function styleSeg(item, key, def, opts) {
    return seg(() => item.style()[key] ?? def, (v) => item.setStyle({ ...item.currentStyle(), [key]: v }), opts);
  }
  function paramSeg(item, key, def, opts) {
    return seg(() => item.params()[key] ?? def, (v) => item.setParams({ [key]: v }), opts);
  }
  function chip(label, on, onClick) {
    return h`<button class=${() => (on() ? 'chip on' : 'chip')} onclick=${onClick}>${label}</button>`;
  }
  function layerChip(item, key, label) {
    return chip(label, () => item.layers()[key], () => item.toggleLayer(key));
  }
  // IMPORTANT: each section must return a SINGLE root node, and `field`'s control
  // arg must be a SINGLE node — sideact's `h` mis-orders/drops nodes when a
  // multi-root fragment is interpolated. Sections wrap in one <div class="psec">
  // (display:contents) and rows go through field() for a uniform 2-column grid.
  function field(key, control, readout) {
    // readout (optional) is a single node, right-aligned after the control —
    // both are single-node interpolations, so sideact orders them fine.
    return h`<label><span class="fk">${key}</span><span class="fv">${control}${readout ?? ''}</span></label>`;
  }
  // a reactive trend/plunge (or text) read-out; `fn` reads item signals so it
  // updates live as data changes, without rebuilding the inputs in propsFor.
  function readout(fn) { return h`<span class="ro">${fn}</span>`; }
  const tp = (dcos) => { const [t, p] = conversions.dcosToLine(dcos); return `${az(t)}/${p2(p)}`; };
  function chips(...nodes) { return h`<span class="chips">${nodes}</span>`; }
  function num(value, min, max, step, onInput, placeholder) {
    return h`<input type="number" min=${min} max=${max} step=${step} placeholder=${placeholder ?? null} value=${value} oninput=${onInput}>`;
  }
  function plotSection(item) {
    if (item.type !== 'planes') return '';
    return h`<div class="psec"><div class="istit">plot as</div>
      ${field('elements', chips(layerChip(item, 'great', 'great circles'), layerChip(item, 'poles', 'poles')))}</div>`;
  }
  function densitySection(item) {
    const P = item.currentParams();
    const mode = () => { const L = item.layers(); return L.heatmap && L.contours ? 'both' : L.contours ? 'lines' : L.heatmap ? 'fill' : 'off'; };
    const setMode = (m) => { item.setLayer('contours', m === 'lines' || m === 'both'); item.setLayer('heatmap', m === 'fill' || m === 'both'); };
    return h`<div class="psec"><div class="istit">density / contours</div>
      ${field('show', seg(mode, setMode, [['off', 'off'], ['lines', 'lines'], ['fill', 'fill'], ['both', 'both']]))}
      ${field('method', paramSeg(item, 'cMethod', 'fisher', [['fisher', 'Fisher'], ['kamb', 'Kamb']]))}
      ${field('smoothing σ', num(P.cSigma ?? '', 2, 40, 1, (e) => item.setParams({ cSigma: +e.target.value || null }), 'auto'))}
      ${field('levels', num(P.cLevels, 1, 8, 1, (e) => item.setParams({ cLevels: Math.max(1, +e.target.value || 1) })))}</div>`;
  }
  function meanSection(item) {
    const meanRO = readout(() => { const s = item.stats(); return s ? tp(s.fisher.mean) : '—'; });
    const coneRO = readout(() => { const s = item.stats(); return s && s.fisher.alpha95 > 0 ? `${s.fisher.alpha95.toFixed(1)}°` : '—'; });
    return h`<div class="psec"><div class="istit">mean / confidence</div>
      ${field('mean vector', chips(layerChip(item, 'mean', 'show')), meanRO)}
      ${field('α₉₅ cone', chips(chip('show', () => item.params().meanCone, () => item.setParams({ meanCone: !item.currentParams().meanCone }))), coneRO)}</div>`;
  }
  function eigenSection(item) {
    const cell = (i, key, label) => chip(label, () => item.params()[key][i], () => {
      const a = item.currentParams()[key].slice(); a[i] = !a[i]; item.setParams({ [key]: a });
    });
    const eigRO = (i) => readout(() => { const s = item.stats(); return s ? tp(s.eigenvectors[i]) : '—'; });
    return h`<div class="psec"><div class="istit">eigenvectors</div>
      ${field('show', chips(layerChip(item, 'eigen', 'on')))}
      ${[0, 1, 2].map((i) => field('V' + (i + 1), chips(cell(i, 'eigPole', 'pole'), cell(i, 'eigPlane', 'great circle')), eigRO(i)))}</div>`;
  }
  function symbolSection(item) {
    const st = item.currentStyle();
    const set = (patch) => item.setStyle({ ...item.currentStyle(), ...patch });
    const opacityPct = Math.round((st.opacity == null ? 1 : st.opacity) * 100);
    const out = h`<span class="rngval">${opacityPct}%</span>`;
    const colorCtl = h`<input type="color" value=${st.color || '#888888'} oninput=${(e) => set({ color: e.target.value })}>`;
    const opacityCtl = h`<span class="rngwrap"><input class="rng" type="range" min="10" max="100" step="5" value=${opacityPct}
        oninput=${(e) => { out.textContent = `${e.target.value}%`; set({ opacity: +e.target.value / 100 }); }}>${out}</span>`;
    // Two whole single-root templates (vs interpolating a multi-label fragment).
    if (item.type === 'planes') {
      return h`<div class="psec"><div class="istit">lines / poles</div>
        ${field('color', colorCtl)}
        ${field('line width', num(st.width ?? 1, 0.2, 4, 0.2, (e) => set({ width: +e.target.value })))}
        ${field('line style', styleSeg(item, 'lineStyle', 'solid', [['solid', 'solid'], ['dashed', 'dashed'], ['dotted', 'dotted']]))}
        ${field('opacity', opacityCtl)}</div>`;
    }
    if (item.type === 'smallcircle') {
      return h`<div class="psec"><div class="istit">axes / circles</div>
        ${field('color', colorCtl)}
        ${field('axis size', num(st.size ?? 4, 1, 12, 0.5, (e) => set({ size: +e.target.value })))}
        ${field('line width', num(st.width ?? 1, 0.2, 4, 0.2, (e) => set({ width: +e.target.value })))}
        ${field('line style', styleSeg(item, 'lineStyle', 'solid', [['solid', 'solid'], ['dashed', 'dashed'], ['dotted', 'dotted']]))}
        ${field('opacity', opacityCtl)}</div>`;
    }
    return h`<div class="psec"><div class="istit">symbols</div>
      ${field('color', colorCtl)}
      ${field('point size', num(st.size ?? 4, 1, 12, 0.5, (e) => set({ size: +e.target.value })))}
      ${field('marker', styleSeg(item, 'pointFill', 'filled', [['filled', 'filled'], ['open', 'open']]))}
      ${field('edge width', num(st.edgeWidth ?? 0, 0, 3, 0.2, (e) => set({ edgeWidth: +e.target.value })))}
      ${field('opacity', opacityCtl)}</div>`;
  }
  function colorBySection(item) {
    const cols = item.currentColumns();
    if (!cols.length) return '';
    const st = item.currentStyle();
    const setS = (patch) => item.setStyle({ ...item.currentStyle(), ...patch });
    const colSel = colSelect(cols, st.colorBy ?? 0, false, (v) => setS({ colorBy: v }));
    const rampSel = h`<select onchange=${(e) => setS({ colorRamp: e.target.value })}>
      ${RAMPS.map((r) => h`<option value=${r} ${(st.colorRamp || 'viridis') === r ? 'selected' : null}>${r}</option>`)}</select>`;
    const rev = chip('reverse', () => item.style().rampReverse, () => setS({ rampReverse: !item.currentStyle().rampReverse }));
    return h`<div class="psec"><div class="istit">color by</div>
      ${field('mode', styleSeg(item, 'colorMode', 'single', [['single', 'single'], ['categorical', 'class'], ['ramp', 'ramp']]))}
      ${field('column', colSel)}
      ${field('ramp', rampSel)}
      ${field('reverse', chips(rev))}</div>`;
  }
  function statsSection(item) {
    const s = item.stats();
    if (!s) return h`<div class="muted">${item.measurements().length} measurement(s) — need ≥2 for stats</div>`;
    const [mt, mp] = conversions.dcosToLine(s.fisher.mean);
    const k = (s.eigenvalues[0] - s.eigenvalues[1]) || 0, e2 = (s.eigenvalues[1] - s.eigenvalues[2]) || 0;
    const srow = (key, v) => h`<div class="srow"><span>${key}</span><b>${v}</b></div>`;
    return h`<div class="stats">
      ${srow('S₁ S₂ S₃', s.eigenvalues.map((v) => v.toFixed(3)).join('  '))}
      ${srow('strength (S₁−S₂, S₂−S₃)', `${k.toFixed(3)}  ${e2.toFixed(3)}`)}
      ${srow('Woodcock K · C', `${s.K.toFixed(2)} · ${s.C.toFixed(2)}`)}
      ${srow('Vollmer P G R', `${s.P.toFixed(2)} ${s.G.toFixed(2)} ${s.R.toFixed(2)}`)}
      ${srow('fabric', s.K > 1 ? 'cluster' : s.K < 1 ? 'girdle' : 'uniform')}
      ${srow('Fisher mean', `${az(mt)}/${p2(mp)}`)}
      ${srow('κ · α₉₅ · n', `${s.fisher.kappa.toFixed(1)} · ${s.fisher.alpha95.toFixed(1)}° · ${s.fisher.n}`)}
    </div>`;
  }

  // ── properties (rich, per render-element) ──
  const propsHost = document.createElement('div');
  propsHost.className = 'props';
  effect(() => { propsHost.replaceChildren(propsFor(selected())); });
  function propsFor(item) {
    if (!item) return h`<div class="muted">no dataset selected</div>`;
    if (isGroup(item)) {
      return h`<div class="pbody">
        <input class="nameedit" value=${item.currentName()} oninput=${(e) => item.setName(e.target.value)}>
        <div class="ptype">group · ${() => item.children().length} layers</div>
        ${field('visible', chips(chip('show', () => item.visible(), () => item.setVisible(!item.currentVisible()))))}
        <div class="muted">Drag layers onto a group to nest them; the group's visibility gates everything inside.</div>
      </div>`;
    }
    return h`<div class="pbody">
      <input class="nameedit" value=${item.currentName()} oninput=${(e) => item.setName(e.target.value)}>
      <div class="ptype">${item.type} · ${item.measurements().length} measurements</div>
      ${plotSection(item)}
      ${symbolSection(item)}
      ${colorBySection(item)}
      ${densitySection(item)}
      ${meanSection(item)}
      ${eigenSection(item)}
      <div class="istit">statistics</div>
      ${statsSection(item)}
    </div>`;
  }

  // ── settings (global, plot-level) ──
  const settings = h`<div class="settings">
    <label>rose bin <select onchange=${(e) => project.setRoseBinWidth(+e.target.value)}>
      ${[5, 10, 15, 20, 30].map((w) => h`<option value=${w} ${w === 10 ? 'selected' : null}>${w}°</option>`)}
    </select></label>
    <label>fabric <select onchange=${(e) => fabric.setMode(e.target.value)}>
      <option value="woodcock">Woodcock</option><option value="vollmer">Vollmer</option>
    </select></label>
  </div>`;

  // ── tabbed plots ──
  const tab = (key, label) => h`<button class=${() => (activeTab() === key ? 'tab on' : 'tab')} onclick=${() => setActiveTab(key)}>${label}</button>`;
  // live legend overlay on the net: a swatch / class list / ramp bar per visible item
  const legendHost = document.createElement('div');
  legendHost.className = 'netlegend';
  function rampBar(lg) {
    const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => color.sampleScale(lg.ramp, lg.reverse ? 1 - t : t));
    return h`<div class="lgramp"><span class="lgname">${lg.column}</span>
      <span class="lgbar" style=${{ background: `linear-gradient(to right, ${stops.join(',')})` }}></span>
      <span class="lgrange">${fmtNum(lg.min)} – ${fmtNum(lg.max)}</span></div>`;
  }
  function legendRow(item) {
    const lg = item.colorLegend();
    if (lg && lg.type === 'categorical') {
      return h`<div class="lgitem"><span class="lgname">${item.name()}</span><span class="lgcats">${
        lg.entries.slice(0, 8).map(([v, c]) => h`<span class="lgcat"><span class="sw" style=${{ background: c }}></span>${v || '∅'}</span>`)
      }</span></div>`;
    }
    if (lg && lg.type === 'ramp') {
      return h`<div class="lgitem"><span class="lgname">${item.name()}</span>${rampBar(lg)}</div>`;
    }
    return h`<div class="lgitem"><span class="sw" style=${{ background: item.style().color || '#888' }}></span><span>${item.name()}</span></div>`;
  }
  effect(() => {
    const vis = project.visibleLeaves();
    if (vis.length) legendHost.replaceChildren(h`<div class="lg">${vis.map(legendRow)}</div>`);
    else legendHost.replaceChildren();
  });
  // ── data table (selected item) with toggleable edit mode ──
  const [tableEdit, setTableEdit] = signal(false);
  const [tableVer, setTableVer] = signal(0);
  const bumpTable = () => setTableVer((v) => v + 1);
  const tableHost = document.createElement('div');
  // Rebuilds on selection / edit-mode / structural change only — cell edits write
  // through to the model (read untracked here) so they don't rebuild + lose focus.
  effect(() => { tableVer(); const it = selected(); tableHost.replaceChildren(it && !isGroup(it) ? dataTable(it, tableEdit()) : h`<div class="muted">${() => (isGroup(selected()) ? 'groups have no data table' : 'no dataset selected')}</div>`); });
  function dataTable(item, edit) {
    const geom = item.constructor.GEOM || ['a', 'b'];
    const cols = item.currentColumns();
    const meas = item.currentMeasurements();
    const setMeas = (i, k, v) => { const n = parseFloat(v); if (!Number.isFinite(n)) return; const m = item.currentMeasurements().map((r) => r.slice()); m[i][k] = n; item.setMeasurements(m); };
    const setCell = (ci, i, v) => { const c = item.currentColumns().map((co) => ({ name: co.name, values: co.values.slice() })); c[ci].values[i] = v; item.setColumns(c); };
    const renameCol = (ci, v) => { const c = item.currentColumns().map((co) => ({ name: co.name, values: co.values })); c[ci].name = v; item.setColumns(c); };
    const addRow = () => { item.setMeasurements([...item.currentMeasurements(), geom.map(() => 0)]); item.setColumns(item.currentColumns().map((co) => ({ name: co.name, values: [...co.values, ''] }))); bumpTable(); };
    const addCol = () => { const n = item.currentColumns().length + 1; item.setColumns([...item.currentColumns(), { name: `col${n}`, values: item.currentMeasurements().map(() => '') }]); bumpTable(); };
    const delRow = (i) => { item.setMeasurements(item.currentMeasurements().filter((_, j) => j !== i)); item.setColumns(item.currentColumns().map((co) => ({ name: co.name, values: co.values.filter((_, j) => j !== i) }))); bumpTable(); };
    const cell = (val, onInput) => edit ? h`<input class="tc" value=${val} oninput=${(e) => onInput(e.target.value)}>` : h`<span>${val}</span>`;

    // A real <table> can't be built via the template (HTML foster-parenting
    // hoists interpolated <tr>s out of the table); use a CSS-grid of <div>s, and
    // emit every cell in ONE array (adjacent array interpolations would collide).
    const cells = [
      h`<div class="th rownum">#</div>`,
      ...geom.map((g) => h`<div class="th">${g}</div>`),
      ...cols.map((c, ci) => h`<div class="th">${edit ? h`<input class="thi" value=${c.name} oninput=${(e) => renameCol(ci, e.target.value)}>` : h`<span>${c.name}</span>`}</div>`),
      ...(edit ? [h`<div class="th tdel"></div>`] : []),
    ];
    meas.forEach((m, i) => {
      cells.push(h`<div class="td rownum">${i + 1}</div>`);
      geom.forEach((g, k) => cells.push(h`<div class="td">${cell(m[k], (v) => setMeas(i, k, v))}</div>`));
      cols.forEach((c, ci) => cells.push(h`<div class="td">${cell(c.values[i] ?? '', (v) => setCell(ci, i, v))}</div>`));
      if (edit) cells.push(h`<div class="td tdel"><button class="rm" title="delete row" onclick=${() => delRow(i)}>×</button></div>`);
    });
    const grid = `44px repeat(${geom.length + cols.length}, minmax(72px, 1fr))${edit ? ' 34px' : ''}`;
    return h`<div class="tablebox">
      <div class="thead-row"><span class="tcount">${meas.length} rows · ${cols.length} columns</span>
        ${edit ? h`<span class="ttoolbar"><button class="mini" onclick=${addRow}>+ row</button><button class="mini" onclick=${addCol}>+ column</button></span>` : ''}
        <button class=${() => (tableEdit() ? 'btn on' : 'btn')} onclick=${() => setTableEdit((v) => !v)}>edit</button></div>
      <div class="tscroll"><div class="dtable" style=${{ gridTemplateColumns: grid }}>${cells}</div></div>
    </div>`;
  }

  const wraps = {
    net: h`<div class="plotwrap">${net.element}${legendHost}</div>`,
    rose: h`<div class="plotwrap">${rose.element}</div>`,
    fabric: h`<div class="plotwrap">${fabric.element}</div>`,
    table: h`<div class="plotwrap tablewrap">${tableHost}</div>`,
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
      <div class="grp">
        <button class="seg" title="open an OSJS project file" onclick=${() => openInput.click()}>open</button>
        <button class="seg" title="save the project to a file" onclick=${saveProject}>save</button>
      </div>
      <div class="grp">
        <button class="seg" onclick=${() => net.sn.download('stereonet.svg')}>SVG</button>
        <button class="seg" onclick=${() => net.sn.downloadPNG('stereonet.png', { scale: 2, background: '#ffffff' })}>PNG</button>
      </div>
      <button class="btn icon" title="toggle theme" onclick=${() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>${() => (theme() === 'dark' ? '☀' : '☾')}</button>
    </header>
    <div class="body">
      <aside class="side">
        <div class="sect">data <span class="count">${() => project.items().length}</span>
          <button class="sectbtn" title="add a group" onclick=${() => setSelected(project.addGroup('group'))}>＋ group</button></div>
        <div class="list" ondragover=${(e) => { if (dragNode) e.preventDefault(); }} ondrop=${(e) => { e.preventDefault(); if (dragNode) { project.move(dragNode, null, project.nodes().length); dragNode = null; } }}>${list}</div>
        ${addHost}
      </aside>
      <main class="main">
        <div class="tabs">${tab('net', 'projection')}${tab('rose', 'rose')}${tab('fabric', 'fabric')}${tab('table', 'table')}</div>
        <div class="plotarea">${wraps.net}${wraps.rose}${wraps.fabric}${wraps.table}</div>
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
