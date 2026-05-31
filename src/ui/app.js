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
import { Project, ITEM_TYPES, serializeProject, loadProject, isGroup, rotateItem, mergeItems, differenceVectors, unfoldItem, commonMean } from '../core/model.js';
import { NetRenderer } from '../render/net.js';
import { openMenu } from './contextmenu.js';
import { RoseRenderer } from '../render/rose.js';
import { FabricRenderer } from '../render/fabric.js';
import { parsePairs, parseTriples, parseFaults, parseTable, guessRoles, buildFromTable } from '../io/parse.js';
import { unzip, looksLikeZip } from '../io/zip.js';
import { parseOpenStereo } from '../io/openstereo.js';

const { conversions, color } = bearing;
const RAMPS = ['viridis', 'magma', 'inferno', 'plasma', 'thermal', 'grayscale'];
const PALETTE = ['#1aa39a', '#e8920c', '#cc3333', '#7a5cff', '#3a9a3a', '#c060c0', '#d4548a', '#5bb8d4'];

// built-in example projects (serializeProject shape → flow straight through loadProject)
const SAMPLES = [
  { label: 'bedding & joints', project: { format: 'osjs-project', version: 2, projection: 'equal-area', items: [
    { type: 'planes', name: 'bedding', style: { color: PALETTE[0], width: 1 }, measurements: [[120, 35], [125, 40], [118, 32], [130, 38], [122, 42], [127, 36], [115, 30], [124, 41]] },
    { type: 'poles', name: 'joints', style: { color: PALETTE[1], size: 4 }, measurements: [[210, 78], [214, 82], [206, 75], [218, 80], [203, 84], [212, 71]] },
  ] } },
  { label: 'folded bedding', project: { format: 'osjs-project', version: 2, projection: 'equal-area', items: [
    { type: 'planes', name: 'folded bedding', style: { color: PALETTE[3], width: 1 },
      layers: { great: true, poles: true, eigen: true }, params: { eigPole: [true, true, true], eigPlane: [false, false, true] },
      measurements: [[10, 60], [30, 55], [50, 48], [70, 40], [90, 35], [110, 40], [130, 48], [150, 55], [170, 62], [350, 65], [330, 58], [310, 50]] },
  ] } },
  { label: 'fault-slip', project: { format: 'osjs-project', version: 2, projection: 'equal-area', items: [
    { type: 'fault', name: 'faults', style: { color: PALETTE[2], width: 1 }, layers: { planes: true, slip: true },
      measurements: [[120, 60, 80, 2], [125, 55, 75, 2], [300, 50, 30, 1], [295, 48, 35, 1], [210, 70, 90, 3], [205, 72, 85, 3]] },
  ] } },
];
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
  const addPayload = (payload) => { if (payload.measurements.length) setSelected(project.add(new (ITEM_TYPES[payload.type] || ITEM_TYPES.planes)(payload))); };
  const [theme, setTheme] = signal('light');
  const [mode, setMode] = signal('select');   // net interaction: select | measure | rotate | pick
  const [measure, setMeasure] = signal(null);   // last two-click measurement
  const [cursor, setCursor] = signal(null);
  const [activeTab, setActiveTab] = signal('net');

  // ── plots ──
  const net = new NetRenderer(project, { size: 540 });
  const rose = new RoseRenderer(project, { size: 300 });
  const fabric = new FabricRenderer(project, { mode: 'woodcock', size: 300 });
  effect(() => { net.render(); rose.render(); fabric.render(); });

  // ── persistence + undo/redo history ──
  // The reactive effect below fires on any project change; it autosaves and, after
  // a short debounce (so a slider drag = one step), pushes a snapshot onto an
  // undo stack. serializeProject already captures full state, so history is just
  // a stack of those + a pointer; undo/redo restore via loadProject.
  const touchTree = (list) => list.forEach((n) => {
    n.name(); n.visible();
    if (isGroup(n)) { n.expanded(); touchTree(n.children()); }
    else { n.measurements(); n.style(); n.params(); n.layers(); n.columns(); }
  });
  const history = [JSON.stringify(serializeProject(project))];
  let histIndex = 0, snapTimer = null;
  const [histVer, setHistVer] = signal(0);
  const canUndo = () => { histVer(); return histIndex > 0; };
  const canRedo = () => { histVer(); return histIndex < history.length - 1; };
  const recordSnapshot = () => {
    const snap = JSON.stringify(serializeProject(project));
    if (snap === history[histIndex]) return;                 // no real change
    history.splice(histIndex + 1);                            // drop the redo branch
    history.push(snap);
    if (history.length > 100) history.shift();
    histIndex = history.length - 1;
    setHistVer((v) => v + 1);
  };
  const flushSnapshot = () => { if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; recordSnapshot(); } };
  const restore = () => {
    flushSnapshot();
    loadProject(project, JSON.parse(history[histIndex]));
    setSelected(project.items()[0] || null);
    setHistVer((v) => v + 1);
  };
  const undo = () => { flushSnapshot(); if (histIndex <= 0) return; histIndex--; restore(); };
  const redo = () => { if (histIndex >= history.length - 1) return; histIndex++; restore(); };
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;  // leave native text undo
    const z = e.key === 'z' || e.key === 'Z';
    if (z && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (e.key === 'y' || e.key === 'Y' || (z && e.shiftKey)) { e.preventDefault(); redo(); }
  });
  // GIS-style quick mode swap: bare m/r/p switch the net tool; 0 resets orientation
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 's') setMode('select'); else if (k === 'm') setMode('measure'); else if (k === 'r') setMode('rotate'); else if (k === 'p') setMode('pick');
    else if (k === '0') net.resetView();
    else if (k === 'escape') setSelected(null);
  });
  effect(() => {
    touchTree(project.nodes());                              // subscribe to the whole tree
    const json = JSON.stringify(serializeProject(project));
    lsSet(LS_KEY, json);
    if (json !== history[histIndex]) { clearTimeout(snapTimer); snapTimer = setTimeout(recordSnapshot, 350); }
  });
  const saveProject = () => {
    const blob = new Blob([JSON.stringify(serializeProject(project), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'project.osjs.json';
    a.click(); URL.revokeObjectURL(a.href);
  };
  const [notice, setNotice] = signal('');
  // Open a set of dropped/picked files. For an unpacked .openstereo, select its
  // data files alongside it — external paths resolve by basename against the set.
  async function openFiles(fileList) {
    const arr = [...(fileList || [])]; if (!arr.length) return;
    const sib = {};
    for (const f of arr) sib[f.name] = new Uint8Array(await f.arrayBuffer());
    const zipFile = arr.find((f) => /\.openstereo$/i.test(f.name) || looksLikeZip(sib[f.name]));
    try {
      if (zipFile) {
        const merged = { ...sib, ...(await unzip(sib[zipFile.name])) };   // in-zip entries win over loose siblings
        const data = parseOpenStereo(merged);
        loadProject(project, data);
        setNotice(data.skipped.length ? `imported · skipped ${data.skipped.length}: ${data.skipped.join('; ')}` : 'OpenStereo project imported');
      } else {
        const j = arr.find((f) => /\.(json|osjs)$/i.test(f.name)) || arr[0];
        loadProject(project, JSON.parse(new TextDecoder().decode(sib[j.name])));
        setNotice('');
      }
      setSelected(project.items()[0] || null);
    } catch (e) { console.error('open failed', e); setNotice(`could not open: ${e.message}`); }
  }
  const openInput = document.createElement('input');
  openInput.type = 'file'; openInput.multiple = true;
  openInput.accept = '.json,.osjs,.openstereo,.txt,.csv,.tsv,application/json,application/zip';
  openInput.onchange = () => { openFiles(openInput.files); openInput.value = ''; };
  const loadSample = (s) => { loadProject(project, s.project); setSelected(project.items()[0] || null); setNotice(''); };

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
  net.onMeasure = (m) => setMeasure(m);
  net.onSelect = (id) => setSelected(id ? (project.items().find((x) => x.id === id) || null) : null);  // click a layer / empty → deselect
  net.onPick = (d) => {
    const it = selected();
    if (!it || isGroup(it) || it.type === 'fault' || it.type === 'annotation') return;   // faults need rake+sense → use the form
    const lineLike = it.type === 'lines' || it.type === 'smallcircle';
    const [a, b] = lineLike ? conversions.dcosToLine(d) : conversions.dcosToPlane(d);
    const datum = it.type === 'smallcircle' ? [Math.round(a), Math.round(b), 30] : [Math.round(a), Math.round(b)];
    it.setMeasurements([...it.measurements(), datum]);
  };
  effect(() => net.setMode(mode()));
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
      if (e.dataTransfer.files && e.dataTransfer.files.length) return;   // file drop → let it bubble to app
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
    rowEl.dataset.node = group.id;
    rowEl.oncontextmenu = (e) => { e.preventDefault(); setSelected(group); openMenu(e.clientX, e.clientY, groupMenu(group)); };
    rowEl.querySelector('.nm').addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(group, e.currentTarget); });
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
    rowEl.dataset.node = item.id;
    rowEl.oncontextmenu = (e) => { e.preventDefault(); setSelected(item); openMenu(e.clientX, e.clientY, itemMenu(item)); };
    rowEl.querySelector('.nm').addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(item, e.currentTarget); });
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
  const segSig = (sig, opts) => h`<span class="grp small">${opts.map(([v, l]) =>
    h`<button class=${() => (sig[0]() === v ? 'seg on' : 'seg')} onclick=${() => sig[1](v)}>${l}</button>`)}</span>`;
  function addForm() {
    const type = signal('planes');
    const conv = signal('dd');         // planes/poles: azimuth is dip-direction vs strike (RHR)
    const lineInput = signal('tp');    // lines: trend/plunge vs rake-on-plane
    const [table, setTable] = signal(null);
    const map = { azIdx: 0, dipIdx: 1, colorBy: -1 };  // read at commit time
    const ta = h`<textarea class="ta" rows="5" placeholder="paste pairs (120 35) or CSV/TSV with a header row"></textarea>`;
    const nm = h`<input class="ni" placeholder="name">`;
    const typeSel = h`<select onchange=${(e) => type[1](e.target.value)}>
        <option value="planes">planes (great circles)</option>
        <option value="poles">poles</option><option value="lines">lines</option>
        <option value="smallcircle">small circles (t/p/aperture)</option>
        <option value="fault">faults (dd/dip/rake/sense)</option></select>`;
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

    // attitude-convention options (per type)
    const optsHost = document.createElement('div');
    optsHost.className = 'formopts';
    effect(() => {
      const t = type[0]();
      if (t === 'planes' || t === 'poles') optsHost.replaceChildren(h`<label class="mrow"><span class="fk">azimuth is</span>${segSig(conv, [['dd', 'dip dir'], ['strike', 'strike (RHR)']])}</label>`);
      else if (t === 'lines') optsHost.replaceChildren(h`<label class="mrow"><span class="fk">line as</span>${segSig(lineInput, [['tp', 'trend/plunge'], ['rake', 'rake on plane']])}</label>`);
      else optsHost.replaceChildren();
    });

    // column-mapping UI, shown only for multi-column tables
    const mapHost = document.createElement('div');
    effect(() => {
      const tbl = table(), t = type[0]();
      const positional = t === 'smallcircle' || t === 'fault' || (t === 'lines' && lineInput[0]() === 'rake');
      if (!tbl || tbl.columns.length <= 2 || positional) { mapHost.replaceChildren(); return; }
      const fld = (label, sel) => h`<label class="mrow"><span class="fk">${label}</span>${sel}</label>`;
      mapHost.replaceChildren(h`<div class="mapping">
        <div class="mhint">${tbl.columns.length} columns · ${tbl.rows.length} rows</div>
        ${fld('azimuth', colSelect(tbl.columns, map.azIdx, false, (v) => { map.azIdx = v; }))}
        ${fld('dip / plunge', colSelect(tbl.columns, map.dipIdx, false, (v) => { map.dipIdx = v; }))}
        ${fld('color by', colSelect(tbl.columns, map.colorBy, true, (v) => { map.colorBy = v; }))}
      </div>`);
    });

    const commit = () => {
      const t = type[0]();
      const Cls = ITEM_TYPES[t] || ITEM_TYPES.planes;
      const color = PALETTE[project.items().length % PALETTE.length];
      const tbl = table();
      const toDipDir = (m) => (((t === 'planes' || t === 'poles') && conv[0]() === 'strike') ? m.map(([a, d]) => [(a + 90) % 360, d]) : m);
      let payload;
      if (t === 'smallcircle') {
        const triples = parseTriples(ta.value);
        if (!triples.length) { setAdding(false); return; }
        payload = { measurements: triples, style: { color, width: 1, size: 4 } };
      } else if (t === 'fault') {
        const rows = parseFaults(ta.value);
        if (!rows.length) { setAdding(false); return; }
        payload = { measurements: rows, style: { color, width: 1, size: 4 } };
      } else if (t === 'lines' && lineInput[0]() === 'rake') {
        const tr = parseTriples(ta.value);   // [dip dir, dip, rake] → trend/plunge
        if (!tr.length) { setAdding(false); return; }
        const r1 = (x) => Math.round(x * 10) / 10;
        const meas = tr.map(([dd, dip, rk]) => conversions.rakeToLine(dd, dip, rk).map(r1));
        payload = { measurements: meas, style: { color, width: 1, size: 4 } };
      } else if (tbl && tbl.columns.length > 2) {
        const built = buildFromTable(tbl, map);
        if (!built.measurements.length) { setAdding(false); return; }
        const style = { color, width: 1, size: 4 };
        if (map.colorBy >= 0) {
          const vals = built.columns[map.colorBy].values;
          const numeric = vals.some((v) => v !== '' && Number.isFinite(parseFloat(v)))
            && vals.every((v) => v === '' || Number.isFinite(parseFloat(v)));
          style.colorMode = numeric ? 'ramp' : 'categorical';
          // colorBy indexes colorColumns() = geometry columns + data columns
          style.colorBy = (Cls.GEOM || []).length + map.colorBy;
          if (numeric) style.colorRamp = 'viridis';
        }
        payload = { measurements: toDipDir(built.measurements), columns: built.columns, style };
      } else {
        const pairs = parsePairs(ta.value);
        if (!pairs.length) { setAdding(false); return; }
        payload = { measurements: toDipDir(pairs), style: { color, width: 1, size: 4 } };
      }
      payload.name = nm.value || t;
      setSelected(project.add(new Cls(payload)));
      setAdding(false);
    };
    return h`<div class="form"><div class="frow">${typeSel}${nm}</div>
      ${fileIn}${ta}${optsHost}${mapHost}
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
      ${field('levels', num(P.cLevels, 1, 8, 1, (e) => item.setParams({ cLevels: Math.max(1, +e.target.value || 1) })))}
      ${field('fill colormap', h`<select onchange=${(e) => item.setParams({ cRamp: e.target.value })}>
        ${['item', ...RAMPS].map((r) => h`<option value=${r} ${(P.cRamp || 'item') === r ? 'selected' : null}>${r}</option>`)}</select>`)}</div>`;
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
    if (item.type === 'fault') {
      return h`<div class="psec"><div class="istit">fault elements</div>
        ${field('color', colorCtl)}
        ${field('line width', num(st.width ?? 1, 0.2, 4, 0.2, (e) => set({ width: +e.target.value })))}
        ${field('point size', num(st.size ?? 4, 1, 12, 0.5, (e) => set({ size: +e.target.value })))}
        ${field('opacity', opacityCtl)}
        <div class="muted">sense codes: 0 unknown · 1 reverse · 2 normal · 3 dextral · 4 sinistral. Paleostress σ (in the layer list) is the Michael 1984 inversion — <b>experimental, treat as unvalidated</b>.</div></div>`;
    }
    return h`<div class="psec"><div class="istit">symbols</div>
      ${field('color', colorCtl)}
      ${field('point size', num(st.size ?? 4, 1, 12, 0.5, (e) => set({ size: +e.target.value })))}
      ${field('marker', styleSeg(item, 'pointFill', 'filled', [['filled', 'filled'], ['open', 'open']]))}
      ${field('edge width', num(st.edgeWidth ?? 0, 0, 3, 0.2, (e) => set({ edgeWidth: +e.target.value })))}
      ${field('opacity', opacityCtl)}</div>`;
  }
  function colorBySection(item) {
    const cols = item.colorColumns();   // geometry columns (dip dir, dip, …) + imported ones
    const st = item.currentStyle();
    const setS = (patch) => item.setStyle({ ...item.currentStyle(), ...patch });
    const colCtl = colSelect(cols, st.colorBy ?? 0, false, (v) => setS({ colorBy: v }));
    const rampSel = h`<select onchange=${(e) => setS({ colorRamp: e.target.value })}>
      ${RAMPS.map((r) => h`<option value=${r} ${(st.colorRamp || 'viridis') === r ? 'selected' : null}>${r}</option>`)}</select>`;
    const rev = chip('reverse', () => item.style().rampReverse, () => setS({ rampReverse: !item.currentStyle().rampReverse }));
    return h`<div class="psec"><div class="istit">color by</div>
      ${field('mode', styleSeg(item, 'colorMode', 'single', [['single', 'single'], ['categorical', 'class'], ['ramp', 'ramp'], ['rgb', 'rgb']]))}
      ${field('column', colCtl)}
      ${field('ramp', rampSel)}
      ${field('reverse', chips(rev))}
      ${classHost}${rampHost}</div>`;
  }
  function toolsSection(item) {
    if (!['planes', 'poles', 'lines'].includes(item.type)) return '';   // derived ops need pair attitudes
    const rot = { t: 0, p: 90, a: 30 };                                  // axis trend/plunge, angle
    const unf = { dd: 0, dip: 0 };                                       // unfold reference plane
    const others = project.items().filter((i) => i !== item && i.type === item.type);
    const itemSelect = () => { const s = document.createElement('select'); others.forEach((it, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = it.name(); s.appendChild(o); }); return s; };
    const mergeSel = others.length ? itemSelect() : null, cmpSel = others.length ? itemSelect() : null;
    const mergeCtl = mergeSel ? h`<span class="fv">${mergeSel}<button class="mini" onclick=${() => addPayload(mergeItems(item, others[+mergeSel.value || 0]))}>merge</button></span>` : h`<span class="muted">no compatible layer</span>`;
    const cmpCtl = cmpSel ? h`<span class="fv">${cmpSel}<button class="mini" onclick=${() => { const o = others[+cmpSel.value || 0]; const r = commonMean(item, o); setNotice(`common mean vs ${o.name()}: p=${r.p < 0.001 ? '<0.001' : r.p.toFixed(3)} (${r.p < 0.05 ? 'differ' : 'share'}), F=${r.F.toFixed(2)}`); }}>test</button></span>` : h`<span class="muted">no compatible layer</span>`;
    return h`<div class="psec"><div class="istit">tools</div>
      ${field('rotate axis', h`<span class="fv">${num(rot.t, 0, 360, 1, (e) => { rot.t = +e.target.value; })}${num(rot.p, 0, 90, 1, (e) => { rot.p = +e.target.value; })}</span>`)}
      ${field('by angle', h`<span class="fv">${num(rot.a, -360, 360, 1, (e) => { rot.a = +e.target.value; })}<button class="mini" onclick=${() => addPayload(rotateItem(item, rot.t, rot.p, rot.a))}>rotate →</button></span>`)}
      ${field('unfold (dd/dip)', h`<span class="fv">${num(unf.dd, 0, 360, 1, (e) => { unf.dd = +e.target.value; })}${num(unf.dip, 0, 90, 1, (e) => { unf.dip = +e.target.value; })}<button class="mini" onclick=${() => addPayload(unfoldItem(item, unf.dd, unf.dip))}>unfold →</button></span>`)}
      ${field('difference', h`<span class="fv"><button class="mini" onclick=${() => addPayload(differenceVectors(item))}>vectors →</button></span>`)}
      ${field('merge with', mergeCtl)}
      ${field('common mean', cmpCtl)}</div>`;
  }
  function statsSection(item) {
    const s = item.stats();
    if (!s) return h`<div class="muted">${item.measurements().length} measurement(s) — need ≥2 for stats</div>`;
    const [mt, mp] = conversions.dcosToLine(s.fisher.mean);
    const k = (s.eigenvalues[0] - s.eigenvalues[1]) || 0, e2 = (s.eigenvalues[1] - s.eigenvalues[2]) || 0;
    const [bd, bdip] = s.bestFit.plane, [ft, fp] = s.bestFit.axis;
    const up = s.uniformity.p;
    const srow = (key, v) => h`<div class="srow"><span>${key}</span><b>${v}</b></div>`;
    return h`<div class="stats">
      ${srow('S₁ S₂ S₃', s.eigenvalues.map((v) => v.toFixed(3)).join('  '))}
      ${srow('strength (S₁−S₂, S₂−S₃)', `${k.toFixed(3)}  ${e2.toFixed(3)}`)}
      ${srow('Woodcock K · C', `${s.K.toFixed(2)} · ${s.C.toFixed(2)}`)}
      ${srow('Vollmer P G R', `${s.P.toFixed(2)} ${s.G.toFixed(2)} ${s.R.toFixed(2)}`)}
      ${srow('fabric', s.K > 1 ? 'cluster' : s.K < 1 ? 'girdle' : 'uniform')}
      ${srow('Fisher mean', `${az(mt)}/${p2(mp)}`)}
      ${srow('κ · α₉₅ · n', `${s.fisher.kappa.toFixed(1)} · ${s.fisher.alpha95.toFixed(1)}° · ${s.fisher.n}`)}
      ${srow('best-fit plane', `${az(bd)}/${p2(bdip)}`)}
      ${srow('fold axis (β)', `${az(ft)}/${p2(fp)}  ·  girdle ${s.bestFit.girdle.toFixed(2)}`)}
      ${srow('uniformity p', `${up < 0.001 ? '<0.001' : up.toFixed(3)}  (${up < 0.05 ? 'non-random' : 'random'})`)}
    </div>`;
  }

  // ── properties (rich, per render-element) ──
  const propsHost = document.createElement('div');
  propsHost.className = 'props';
  const collapsed = new Set();   // collapsed section titles (persist across rebuilds)
  propsHost.addEventListener('click', (e) => {
    const istit = e.target.closest('.istit'); const sec = istit && istit.parentElement;
    if (!sec || !sec.classList.contains('psec')) return;
    if (sec.classList.toggle('collapsed')) collapsed.add(istit.textContent.trim()); else collapsed.delete(istit.textContent.trim());
  });
  // QGIS-style class table for categorical colour-by: editable swatch · value · count.
  // Declared before the props effect (colorBySection embeds classHost / rampHost).
  const classHost = document.createElement('div');
  const rampHost = document.createElement('div');
  const toHex = (c) => {
    if (!c) return '#000000';
    if (c[0] === '#') return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c.slice(0, 7);
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    return m ? '#' + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, '0')).join('') : '#000000';
  };
  effect(() => {
    propsHost.replaceChildren(propsFor(selected()));
    for (const sec of propsHost.querySelectorAll('.psec')) {     // re-apply collapse state
      if (collapsed.has(sec.querySelector('.istit')?.textContent.trim())) sec.classList.add('collapsed');
    }
  });
  effect(() => {
    const it = selected();
    const lg = it && !isGroup(it) && it.type !== 'annotation' && it.style().colorMode === 'categorical' ? it.colorLegend() : null;
    if (!lg || lg.type !== 'categorical') { classHost.replaceChildren(); return; }
    const col = it.colorColumns()[it.style().colorBy];
    const counts = {}; col.values.forEach((v) => { counts[String(v)] = (counts[String(v)] || 0) + 1; });
    const setCat = (v, c) => it.setStyle({ ...it.currentStyle(), catColors: { ...(it.currentStyle().catColors || {}), [v]: c } });
    const rows = lg.entries.map(([v, c]) => h`<label class="classrow">
      <input type="color" value=${toHex(c)} onchange=${(e) => setCat(v, e.target.value)}>
      <span class="cval">${v || '∅'}</span><span class="ccount">${counts[v] || 0}</span></label>`);
    const rampClasses = () => {
      const vals = lg.entries.map(([v]) => v), ramp = it.style().colorRamp || 'viridis';
      const cc = {}; vals.forEach((v, i) => { cc[v] = color.sampleScale(ramp, vals.length > 1 ? i / (vals.length - 1) : 0); });
      it.setStyle({ ...it.currentStyle(), catColors: cc });
    };
    const reset = () => { const s = { ...it.currentStyle() }; delete s.catColors; it.setStyle(s); };
    classHost.replaceChildren(h`<div class="classtable">
      <div class="classhead"><span>classes · ${lg.entries.length}</span>
        <button class="mini" title="colour the classes along the ramp" onclick=${rampClasses}>ramp</button>
        <button class="mini" onclick=${reset}>reset</button></div>
      ${rows}</div>`);
  });

  // ramp preview + clamp (symmetric to the class table; shown in ramp mode)
  effect(() => {
    const it = selected();
    const lg = it && !isGroup(it) && it.type !== 'annotation' && it.style().colorMode === 'ramp' ? it.colorLegend() : null;
    if (!lg || lg.type !== 'ramp') { rampHost.replaceChildren(); return; }
    const setS = (patch) => it.setStyle({ ...it.currentStyle(), ...patch });
    const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => color.sampleScale(lg.ramp, lg.reverse ? 1 - t : t));
    const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
    const reset = () => { const s = { ...it.currentStyle() }; delete s.rampMin; delete s.rampMax; it.setStyle(s); };
    rampHost.replaceChildren(h`<div class="ramptable">
      <span class="rampbar" style=${{ background: `linear-gradient(to right, ${stops.join(',')})` }}></span>
      <label class="mrow"><span class="fk">clamp</span><span class="fv">
        <input type="number" step="any" value=${r3(lg.min)} onchange=${(e) => setS({ rampMin: e.target.value === '' ? null : +e.target.value })}>
        <input type="number" step="any" value=${r3(lg.max)} onchange=${(e) => setS({ rampMax: e.target.value === '' ? null : +e.target.value })}>
        <button class="mini" onclick=${reset}>reset</button></span></label>
    </div>`);
  });
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
    if (item.type === 'annotation') {
      const st = item.currentStyle();
      const set = (patch) => item.setStyle({ ...item.currentStyle(), ...patch });
      const a = [...(st.anchor || [0, 90])], setA = (k, v) => { a[k] = +v; set({ anchor: [...a] }); };
      const l = [...(st.leader || st.anchor || [0, 90])], setL = (k, v) => { l[k] = +v; set({ leader: [...l] }); };
      // switch a coordinate space, converting the point so it stays put visually
      const setSpace = (key, coordKey, v) => {
        const cs = item.currentStyle(), old = cs[key] || 'attitude', cur = cs[coordKey];
        if (old !== v && cur) { const p = net.place(old, cur[0], cur[1]); const nc = net.locate(v, p.x, p.y); item.setStyle({ ...cs, [key]: v, ...(nc ? { [coordKey]: nc } : {}) }); }
        else item.setStyle({ ...cs, [key]: v });
      };
      const spaceSeg = (key, coordKey) => seg(() => item.style()[key] || 'attitude', (v) => setSpace(key, coordKey, v), [['attitude', 'attitude'], ['figure', 'figure']]);
      return h`<div class="pbody">
        <input class="nameedit" value=${item.currentName()} oninput=${(e) => item.setName(e.target.value)}>
        <div class="ptype">annotation · drag it on the net to place</div>
        <div class="istit">text</div>
        ${field('label', h`<input class="ni" value=${st.text || ''} oninput=${(e) => set({ text: e.target.value })}>`)}
        ${field('color', h`<input type="color" value=${st.color || '#1d2733'} oninput=${(e) => set({ color: e.target.value })}>`)}
        ${field('size', num(st.fontSize ?? 13, 8, 36, 1, (e) => set({ fontSize: +e.target.value })))}
        ${field('bold', chips(chip('bold', () => !!item.style().bold, () => set({ bold: !item.currentStyle().bold }))))}
        <div class="istit">background</div>
        ${field('box', chips(chip('show', () => !!item.style().box, () => set({ box: !item.currentStyle().box }))))}
        ${field('fill', h`<input type="color" value=${st.bgColor || '#ffffff'} oninput=${(e) => set({ bgColor: e.target.value })}>`)}
        <div class="istit">anchor</div>
        ${field('space', spaceSeg('anchorSpace', 'anchor'))}
        ${field('at', h`<span class="fv">${num(a[0], -360, 360, 0.1, (e) => setA(0, e.target.value))}${num(a[1], -90, 90, 0.1, (e) => setA(1, e.target.value))}</span>`)}
        ${field('lock', chips(chip('lock', () => !!item.style().anchorLock, () => set({ anchorLock: !item.currentStyle().anchorLock }))))}
        <div class="istit">leader</div>
        ${field('show', chips(chip('show', () => !!item.style().leader, () => set({ leader: item.currentStyle().leader ? null : [...(item.currentStyle().anchor || [0, 90])] }))))}
        ${field('space', spaceSeg('leaderSpace', 'leader'))}
        ${field('to', h`<span class="fv">${num(l[0], -360, 360, 0.1, (e) => setL(0, e.target.value))}${num(l[1], -90, 90, 0.1, (e) => setL(1, e.target.value))}</span>`)}
        ${field('arrow', chips(chip('arrow', () => !!item.style().leaderArrow, () => set({ leaderArrow: !item.currentStyle().leaderArrow }))))}
        ${field('lock', chips(chip('lock', () => !!item.style().leaderLock, () => set({ leaderLock: !item.currentStyle().leaderLock }))))}
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
      ${toolsSection(item)}
      <div class="psec"><div class="istit">statistics</div>${statsSection(item)}</div>
    </div>`;
  }

  // ── settings (global, plot-level) ──
  const projSegBtn = (get, set, v, label) => h`<button class=${() => (get() === v ? 'seg on' : 'seg')} onclick=${() => set(v)}>${label}</button>`;
  const view = { t: 0, p: 90 };   // numeric net view (trend/plunge to centre)
  const viewCtl = h`<span class="fv">${num(view.t, 0, 360, 1, (e) => { view.t = +e.target.value; })}${num(view.p, 0, 90, 1, (e) => { view.p = +e.target.value; })}<button class="mini" onclick=${() => net.setView(view.t, view.p)}>view</button><button class="mini" onclick=${() => net.resetView()}>reset</button></span>`;
  const settings = h`<div class="settings">
    <div class="istit">net</div>
    <label>hemisphere <span class="grp small">${projSegBtn(project.hemisphere, project.setHemisphere, 'lower', 'lower')}${projSegBtn(project.hemisphere, project.setHemisphere, 'upper', 'upper')}</span></label>
    <label>grid <select onchange=${(e) => project.setGridSpacing(+e.target.value)}>
      ${[5, 10, 15, 20, 30].map((w) => h`<option value=${w} ${w === project.gridSpacing() ? 'selected' : null}>${w}°</option>`)}
    </select></label>
    <label>view (t/p) ${viewCtl}</label>
    <div class="istit">rose diagram</div>
    <label>bin width <select onchange=${(e) => project.setRoseBinWidth(+e.target.value)}>
      ${[5, 10, 15, 20, 30].map((w) => h`<option value=${w} ${w === project.roseBinWidth() ? 'selected' : null}>${w}°</option>`)}
    </select></label>
    <label>scale <span class="grp small">${projSegBtn(project.roseScale, project.setRoseScale, 'count', 'count')}${projSegBtn(project.roseScale, project.setRoseScale, 'area', 'equal-area')}</span></label>
    <label>petals <span class="grp small">${projSegBtn(project.rosePetalStyle, project.setRosePetalStyle, 'petals', 'filled')}${projSegBtn(project.rosePetalStyle, project.setRosePetalStyle, 'kite', 'kite')}${projSegBtn(project.rosePetalStyle, project.setRosePetalStyle, 'lines', 'lines')}</span></label>
    <label>mean <span class="chips">${chip('show', () => project.roseMean(), () => project.setRoseMean(!project.roseMean()))}</span></label>
    <div class="istit">fabric</div>
    <label>diagram <select onchange=${(e) => fabric.setMode(e.target.value)}>
      <option value="woodcock">Woodcock</option><option value="vollmer">Vollmer</option>
    </select></label>
  </div>`;

  // ── tabbed plots ──
  const tab = (key, label) => h`<button class=${() => (activeTab() === key ? 'tab on' : 'tab')} onclick=${() => setActiveTab(key)}>${label}</button>`;
  // overlay layers — declared up here because the legend/decor effect just below
  // runs synchronously on creation and positions into them (sideact effect TDZ).
  const annoLayer = document.createElement('div'); annoLayer.className = 'annolayer';
  const panelLayer = document.createElement('div'); panelLayer.className = 'panellayer';
  const brushLayer = document.createElement('div'); brushLayer.className = 'brushlayer';
  let overlayDragging = false;                          // suppress rebuilds while an overlay element is dragged

  // composition decorations (draggable legend + title), figure-space, over the net
  const decorLayer = document.createElement('div'); decorLayer.className = 'decorlayer';
  const legendHost = document.createElement('div');
  legendHost.className = 'netlegend';
  legendHost.addEventListener('pointerdown', (e) => dragDecor(e, 'legendPos', legendHost));
  legendHost.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, decorMenu()); });
  decorLayer.append(legendHost);
  function rampBar(lg) {
    const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => color.sampleScale(lg.ramp, lg.reverse ? 1 - t : t));
    return h`<div class="lgramp"><span class="lgname">${lg.column}</span>
      <span class="lgbar" style=${{ background: `linear-gradient(to right, ${stops.join(',')})` }}></span>
      <span class="lgrange">${fmtNum(lg.min)} – ${fmtNum(lg.max)}</span></div>`;
  }
  function densityBar(item) {
    const ramp = item.params().cRamp || 'item', c = item.style().color || '#888';
    const grad = ramp === 'item'
      ? `linear-gradient(to right, color-mix(in srgb, ${c} 12%, transparent), ${c})`
      : `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((t) => color.sampleScale(ramp, t)).join(',')})`;
    return h`<div class="lgitem"><span class="lgname">${item.name()}</span>
      <span class="lgbar" style=${{ background: grad }}></span><span class="lgrange">density</span></div>`;
  }
  function legendRow(item) {
    if (item.layers().heatmap) return densityBar(item);   // showing filled density → show its scale
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
    const vis = project.visibleLeaves().filter((it) => it.type !== 'annotation');
    legendHost.replaceChildren(...(vis.length ? [h`<div class="lg">${vis.map(legendRow)}</div>`] : []));
    project.legendShow(); project.legendPos();   // subscribe → reposition on change
    repositionDecor();
  });
  // ── data table (selected item) with toggleable edit mode ──
  // edit mode is PER TABLE (tab + each floating panel toggle independently),
  // keyed by item id so toggling one doesn't flip the rest
  const [editSet, setEditSet] = signal(new Set());
  const isEditing = (id) => editSet().has(id);
  const toggleEditing = (id) => { const s = new Set(editSet()); s.has(id) ? s.delete(id) : s.add(id); setEditSet(s); };
  const [tableVer, setTableVer] = signal(0);
  const bumpTable = () => setTableVer((v) => v + 1);
  const tableHost = document.createElement('div');
  // Rebuilds on selection / edit-mode / structural change only — cell edits write
  // through to the model (read untracked here) so they don't rebuild + lose focus.
  effect(() => { tableVer(); const it = selected(); const tabular = it && !isGroup(it) && it.type !== 'annotation'; tableHost.replaceChildren(tabular ? dataTable(it, isEditing(it.id)) : h`<div class="muted">${() => { const s = selected(); return isGroup(s) ? 'groups have no data table' : s && s.type === 'annotation' ? 'annotations have no data table' : 'no dataset selected'; }}</div>`); });
  function dataTable(item, edit, inPanel) {
    const geom = item.constructor.GEOM || ['a', 'b'];
    const cols = item.currentColumns();
    const meas = item.currentMeasurements();
    const setMeas = (i, k, v) => { const n = parseFloat(v); if (!Number.isFinite(n)) return; const m = item.currentMeasurements().map((r) => r.slice()); m[i][k] = n; item.setMeasurements(m); };
    const setCell = (ci, i, v) => { const c = item.currentColumns().map((co) => ({ name: co.name, values: co.values.slice() })); c[ci].values[i] = v; item.setColumns(c); };
    const renameCol = (ci, v) => { const c = item.currentColumns().map((co) => ({ name: co.name, values: co.values })); c[ci].name = v; item.setColumns(c); };
    const addRow = () => { item.setMeasurements([...item.currentMeasurements(), geom.map(() => 0)]); item.setColumns(item.currentColumns().map((co) => ({ name: co.name, values: [...co.values, ''] }))); bumpTable(); };
    const addCol = () => { const n = item.currentColumns().length + 1; item.setColumns([...item.currentColumns(), { name: `col${n}`, values: item.currentMeasurements().map(() => '') }]); bumpTable(); };
    const delRow = (i) => { item.setMeasurements(item.currentMeasurements().filter((_, j) => j !== i)); item.setColumns(item.currentColumns().map((co) => ({ name: co.name, values: co.values.filter((_, j) => j !== i) }))); bumpTable(); };
    const delCol = (ci) => { item.setColumns(item.currentColumns().filter((_, j) => j !== ci)); bumpTable(); };
    const cell = (val, onInput) => edit ? h`<input class="tc" value=${val} oninput=${(e) => onInput(e.target.value)}>` : h`<span>${val}</span>`;

    // per-column widths (px, by slot index over geom+data cols) live in params so
    // they persist; absent = a flexible default track. Build the grid from them.
    const dataCols = geom.length + cols.length;
    const work = (item.currentParams().tableColW || []).slice();
    const trackFor = (arr, i) => (arr[i] ? `${arr[i]}px` : 'minmax(72px, 1fr)');
    const buildGrid = (arr, ov, ovVal) => `44px ${Array.from({ length: dataCols }, (_, i) => (i === ov ? ovVal : trackFor(arr, i))).join(' ')}${edit ? ' 34px' : ''}`;
    const colResize = (e, slot) => {            // drag a header grip → set that column's width
      if (e.button !== 0) return; e.preventDefault();
      const grip = e.currentTarget, dtable = grip.closest('.dtable'), th = grip.closest('.th'); if (!dtable || !th) return;
      const startW = th.offsetWidth, x0 = e.clientX; let moved = false;
      grip.setPointerCapture?.(e.pointerId); overlayDragging = true;
      const move = (ev) => { if (!moved && Math.abs(ev.clientX - x0) < 3) return; moved = true; work[slot] = Math.max(40, Math.round(startW + (ev.clientX - x0))); dtable.style.gridTemplateColumns = buildGrid(work); };
      // commit only on an actual drag — a no-move click must NOT rebuild, or the
      // grip element is replaced between the two clicks and dblclick never fires
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); overlayDragging = false; if (moved) { item.setParams({ tableColW: work.slice() }); bumpTable(); } };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
    };
    const autosizeCol = (e, slot) => {          // double-click a header → fit the widest cell
      if (e.target.closest('input, button')) return;   // not while renaming / deleting
      const dtable = e.currentTarget.closest('.dtable'); if (!dtable) return;
      dtable.style.gridTemplateColumns = buildGrid(work, slot, 'max-content');   // let the track shrink to content
      const th = dtable.querySelector(`.th[data-col="${slot}"]`);
      work[slot] = th ? Math.max(40, Math.ceil(th.getBoundingClientRect().width) + 2) : 80;
      item.setParams({ tableColW: work.slice() }); bumpTable();
    };
    const grip = (slot) => h`<span class="colgrip" title="drag to resize" onpointerdown=${(e) => colResize(e, slot)}></span>`;
    // a header cell: double-click anywhere (but the inputs/buttons) to auto-fit
    const thCell = (slot, inner) => h`<div class="th" data-col=${slot} ondblclick=${(e) => autosizeCol(e, slot)}>${inner}${grip(slot)}</div>`;

    // A real <table> can't be built via the template (HTML foster-parenting
    // hoists interpolated <tr>s out of the table); use a CSS-grid of <div>s, and
    // emit every cell in ONE array (adjacent array interpolations would collide).
    const cells = [
      h`<div class="th rownum">#</div>`,
      ...geom.map((g, k) => thCell(k, h`<span class="thtext">${g}</span>`)),
      ...cols.map((c, ci) => thCell(geom.length + ci, edit
        ? h`<span class="te-grp"><input class="thi" value=${c.name} oninput=${(e) => renameCol(ci, e.target.value)}><button class="thdel" title="delete column" onclick=${() => delCol(ci)}>×</button></span>`
        : h`<span class="thtext">${c.name}</span>`)),
      ...(edit ? [h`<div class="th tdel"></div>`] : []),
    ];
    meas.forEach((m, i) => {
      cells.push(h`<div class="td rownum" data-row=${i}>${i + 1}</div>`);
      geom.forEach((g, k) => cells.push(h`<div class="td" data-row=${i} data-col=${k}>${cell(m[k], (v) => setMeas(i, k, v))}</div>`));
      cols.forEach((c, ci) => cells.push(h`<div class="td" data-row=${i} data-col=${geom.length + ci}>${cell(c.values[i] ?? '', (v) => setCell(ci, i, v))}</div>`));
      if (edit) cells.push(h`<div class="td tdel" data-row=${i}><button class="rm" title="delete row" onclick=${() => delRow(i)}>×</button></div>`);
    });
    // hover a row → brush its datum on the net (delegated; leaves clear the ring)
    const rowHover = (e) => { const r = e.target.closest('[data-row]'); if (r) highlightPoint(item, +r.dataset.row); else clearHighlight(); };
    return h`<div class="tablebox">
      <div class="thead-row">
        <span class="tcount">${meas.length} rows · ${cols.length} columns</span>
        <span class="thead-actions">
          ${edit ? h`<span class="te-grp"><button class="mini" onclick=${addRow}>＋ row</button><button class="mini" onclick=${addCol}>＋ col</button></span>` : ''}
          ${inPanel ? '' : h`<button class="btn" title="float this table over the plot" onclick=${() => { item.setParams({ tableOpen: true }); setActiveTab('net'); bumpTable(); }}>float ⧉</button>`}
          <button class=${() => (isEditing(item.id) ? 'btn on' : 'btn')} onclick=${() => toggleEditing(item.id)}>edit</button>
        </span></div>
      <div class="tscroll"><div class="dtable" data-item=${item.id} onpointermove=${rowHover} onpointerleave=${clearHighlight} style=${{ gridTemplateColumns: buildGrid(work) }}>${cells}</div></div>
    </div>`;
  }

  // guided empty state — shown over the plot area when there is no data
  const emptyState = h`<div class="emptystate"><div class="es-card">
    <div class="es-glyph">⌖</div>
    <div class="es-title">An empty net.</div>
    <div class="es-sub">Add measurements, open a project, or start from a sample —</div>
    <div class="es-samples">${SAMPLES.map((s) => h`<button class="btn" onclick=${() => loadSample(s)}>${s.label}</button>`)}</div>
    <div class="es-hint">tip — press <b>m</b> to measure: drag between two points for the angle + their common plane</div>
  </div></div>`;
  effect(() => { emptyState.style.display = project.items().length ? 'none' : 'flex'; });

  // ── composition overlay (layer over the net) ──
  // Draggable elements positioned over the net SVG, repositioned on rotation/resize
  // via net.onAfterRender. Two element kinds today: annotations (labels + leaders,
  // attitude/figure space) and floating data tables (figure space, rotation-fixed).
  const annoLeaders = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); annoLeaders.setAttribute('class', 'anno-leaders');
  const brushRing = document.createElement('div'); brushRing.className = 'brushring'; brushRing.style.display = 'none';
  brushLayer.append(brushRing);
  const px = (v) => parseFloat(v) || 0;
  const arrowD = (tx, ty, ex, ey) => {                  // triangle at the target, pointing along the leader
    const dx = tx - ex, dy = ty - ey, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const bx = tx - ux * 8, by = ty - uy * 8, nx = -uy * 4, ny = ux * 4;
    return `M${tx},${ty} L${bx + nx},${by + ny} L${bx - nx},${by - ny} Z`;
  };
  // Recompute one annotation's leader (line + arrow) — the single source of the
  // edge-attach math, reused by full render, reposition, and live drag. Reads the
  // LIVE label/handle positions from the DOM; label half-size is cached (_half) on
  // the element at build time so this stays reflow-free in the per-frame path.
  function refreshLeader(a) {
    const line = annoLeaders.querySelector(`line[data-anno="${a.id}"]`);
    const label = annoLayer.querySelector(`[data-anno-label="${a.id}"]`);
    if (!line || !label) return;
    const ax = px(label.style.left), ay = px(label.style.top);
    const handle = annoLayer.querySelector(`[data-anno-handle="${a.id}"]`);
    let tx, ty;
    if (handle) { tx = px(handle.style.left); ty = px(handle.style.top); }
    else { const st = a.style(); const t = net.place(st.leaderSpace || 'attitude', st.leader[0], st.leader[1]); tx = t.x; ty = t.y; }
    const half = label._half || [(label.offsetWidth || 20) / 2 + 2, (label.offsetHeight || 16) / 2 + 2];
    const dx = tx - ax, dy = ty - ay, s = Math.min(1, 1 / Math.max(Math.abs(dx) / half[0], Math.abs(dy) / half[1], 1e-6));
    const ex = ax + dx * s, ey = ay + dy * s;            // attach at the label edge
    line.setAttribute('x1', tx); line.setAttribute('y1', ty); line.setAttribute('x2', ex); line.setAttribute('y2', ey);
    const arrow = annoLeaders.querySelector(`path[data-arrow="${a.id}"]`);
    if (arrow) arrow.setAttribute('d', arrowD(tx, ty, ex, ey));
  }
  // drag the anchor (which='anchor', moves the label) or the leader target
  // (which='leader', moves the handle). Locked endpoints don't drag; commits the
  // coord on release. refreshLeader keeps line + arrow following the moved end.
  function dragPoint(e, a, el, which) {
    const st = a.style();
    if (e.button !== 0 || el.isContentEditable || (which === 'anchor' ? st.anchorLock : st.leaderLock)) return;
    e.preventDefault(); e.stopPropagation(); el.setPointerCapture?.(e.pointerId);
    overlayDragging = true;                                 // freeze rebuilds so this captured element isn't replaced mid-drag
    const space = (which === 'anchor' ? st.anchorSpace : st.leaderSpace) || 'attitude'; let coords = null;
    const move = (ev) => {
      const sr = net.element.getBoundingClientRect();
      const mx = ev.clientX - sr.left, my = ev.clientY - sr.top;
      const c = net.locate(space, mx, my); if (!c) return;
      coords = c; el.style.left = `${mx}px`; el.style.top = `${my}px`;
      if (st.leader) refreshLeader(a);
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      overlayDragging = false;                              // before setStyle, so the resulting effect rebuilds cleanly
      if (coords) a.setStyle({ ...a.currentStyle(), [which]: coords });
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  }
  const visibleAnnos = () => project.visibleLeaves().filter((it) => it.type === 'annotation');
  const tabularItems = () => project.items().filter((it) => it.type !== 'annotation');   // leaves with a data table
  // size both overlay layers to sit exactly over the net SVG; returns false if not laid out
  function fitOverlay() {
    const svg = net.element, wrap = annoLayer.parentElement; if (!svg || !wrap) return false;
    const sr = svg.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    if (!sr.width) return false;                                       // hidden tab / headless
    const box = `left:${sr.left - wr.left}px;top:${sr.top - wr.top}px;width:${sr.width}px;height:${sr.height}px;`;
    annoLayer.style.cssText = box; panelLayer.style.cssText = box; brushLayer.style.cssText = box; decorLayer.style.cssText = box;
    return true;
  }
  // drag a decoration (legend/title) in figure space; commits its [u,v] to project
  function dragDecor(e, posKey, el) {
    if (e.button !== 0) return; e.preventDefault();
    el.setPointerCapture?.(e.pointerId); overlayDragging = true;
    const r0 = net.element.getBoundingClientRect();
    const offX = e.clientX - r0.left - px(el.style.left), offY = e.clientY - r0.top - px(el.style.top);
    let coords = null;
    const move = (ev) => { const r = net.element.getBoundingClientRect(); const x = ev.clientX - r.left - offX, y = ev.clientY - r.top - offY; el.style.left = `${x}px`; el.style.top = `${y}px`; coords = net.locate('figure', x, y); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); overlayDragging = false; if (coords) project[`set${posKey[0].toUpperCase()}${posKey.slice(1)}`](coords); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  }
  // position legend + title from their figure-space anchors; toggle by show/empty
  function repositionDecor() {
    if (overlayDragging || !fitOverlay()) return;
    const showLeg = project.legendShow() && project.visibleLeaves().some((it) => it.type !== 'annotation');
    legendHost.style.display = showLeg ? '' : 'none';
    if (showLeg) { const p = net.place('figure', ...project.legendPos()); legendHost.style.left = `${p.x}px`; legendHost.style.top = `${p.y}px`; }
  }
  // ── linked identify / brushing (table ⇄ plot) ──
  // hover a row → ring on the net at that datum; click a datum → flash its row(s).
  function highlightPoint(item, i) {
    const v = item.dcos()[i]; if (!v || !fitOverlay()) { clearHighlight(); return; }
    const [t, p] = conversions.dcosToLine(v);
    const pt = net.place('attitude', t, p);
    brushRing.style.left = `${pt.x}px`; brushRing.style.top = `${pt.y}px`;
    brushRing.classList.toggle('back', !!pt.hidden);
    brushRing.style.display = '';
  }
  function clearHighlight() { brushRing.style.display = 'none'; }
  // nearest plotted datum to a clicked direction (great-circle distance for planes,
  // angular distance for point-like items); returns its row index or -1.
  function nearestDatum(item, dcos) {
    const ds = item.dcos(); let best = -1, bestAng = Infinity;
    for (let i = 0; i < ds.length; i++) {
      const v = ds[i], dot = Math.min(1, Math.abs(dcos[0] * v[0] + dcos[1] * v[1] + dcos[2] * v[2]));
      const a = Math.acos(dot), dist = item.type === 'planes' ? Math.abs(Math.PI / 2 - a) : a;
      if (dist < bestAng) { bestAng = dist; best = i; }
    }
    return bestAng < 6 * Math.PI / 180 ? best : -1;                    // within ~6°
  }
  function flashDatum(item, i) {
    highlightPoint(item, i); setTimeout(clearHighlight, 1300);
    for (const dt of root.querySelectorAll(`.dtable[data-item="${item.id}"]`)) {
      const cells = dt.querySelectorAll(`[data-row="${i}"]`);
      cells.forEach((c) => { c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1300); });
      cells[0]?.scrollIntoView?.({ block: 'nearest' });
    }
  }
  net.onIdentify = (dcos, id) => {
    const item = project.items().find((x) => x.id === id);
    if (!item || item.type === 'annotation') return;
    const i = nearestDatum(item, dcos); if (i >= 0) flashDatum(item, i);
  };

  // ── context menus (data tree + plot) ──
  const copyText = (s) => { try { navigator.clipboard && navigator.clipboard.writeText && navigator.clipboard.writeText(s); } catch { /* clipboard blocked */ } setNotice(`copied: ${s}`); };
  const tabular = (n) => !isGroup(n) && n.type !== 'annotation';
  // inline rename in the tree (no browser dialog): edit the .nm span in place
  function startRename(node, nm) {
    const row = nm.closest('.it'); const wasDrag = row && row.draggable; if (row) row.draggable = false;
    nm.contentEditable = 'true'; nm.classList.add('editing'); nm.focus();
    if (typeof getSelection === 'function') { try { const r = document.createRange(); r.selectNodeContents(nm); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch { /* no selection api */ } }
    const finish = (commit) => {
      nm.removeEventListener('blur', onBlur); nm.removeEventListener('keydown', onKey);
      nm.contentEditable = 'false'; nm.classList.remove('editing'); if (row) row.draggable = wasDrag;
      const v = nm.textContent.trim();
      if (commit && v) node.setName(v); else nm.textContent = node.currentName();
    };
    const onBlur = () => finish(true);
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    nm.addEventListener('blur', onBlur); nm.addEventListener('keydown', onKey);
  }
  function renameNode(node) {
    const nm = list.querySelector(`[data-node="${node.id}"] .nm`);
    if (nm) startRename(node, nm);
  }
  function duplicateItem(node) {
    const copy = new node.constructor({
      name: `${node.currentName()} copy`,
      measurements: node.currentMeasurements().map((r) => (Array.isArray(r) ? r.slice() : r)),
      columns: node.currentColumns().map((c) => ({ name: c.name, values: c.values.slice() })),
      style: { ...node.currentStyle() }, params: { ...node.currentParams(), tableOpen: false }, layers: { ...node.currentLayers() },
    });
    project.add(copy);
    const parent = project.parentOf(node), sibs = parent ? parent.children() : project.nodes();
    project.move(copy, parent, sibs.indexOf(node) + 1);
    setSelected(copy);
  }
  function addAnnotationAt(t, p) {
    const a = project.add(new ITEM_TYPES.annotation({ name: 'note', style: { color: '#1d2733', fontSize: 13, text: 'note', anchor: [Math.round(t), Math.round(p)], anchorSpace: 'attitude' } }));
    setSelected(a); pendingEdit = a.id;                 // drop straight into inline edit
  }
  // a title is just a prominent, figure-anchored text annotation (full inspector,
  // inline edit, persistence — all for free)
  function addTitle() {
    const a = project.add(new ITEM_TYPES.annotation({ name: 'title', style: { color: '#1d2733', fontSize: 24, bold: true, text: 'Title', anchor: [0, 0.9], anchorSpace: 'figure' } }));
    setActiveTab('net'); setSelected(a); pendingEdit = a.id;
  }
  // inline edit of an annotation label: double-click (or auto on create) → editable
  let pendingEdit = null;
  function startEdit(a, el) {
    overlayDragging = true;                              // freeze rebuilds while editing
    el.contentEditable = 'true'; el.classList.add('editing'); el.focus();
    if (typeof getSelection === 'function') { try { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch { /* no selection api */ } }
    const finish = () => {
      el.removeEventListener('blur', finish); el.removeEventListener('keydown', onKey);
      el.contentEditable = 'false'; el.classList.remove('editing'); overlayDragging = false;
      a.setStyle({ ...a.currentStyle(), text: el.textContent.trim() || 'note' });   // commit → rebuild
    };
    const onKey = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.blur(); } else if (ev.key === 'Escape') { ev.preventDefault(); el.textContent = a.currentStyle().text || 'note'; el.blur(); } };
    el.addEventListener('blur', finish); el.addEventListener('keydown', onKey);
  }
  const editAnno = (a) => { const el = annoLayer.querySelector(`[data-anno-label="${a.id}"]`); if (el) startEdit(a, el); else pendingEdit = a.id; };
  function itemMenu(item) {
    const open = !!item.currentParams().tableOpen;
    return [
      { label: 'Rename…', onClick: () => renameNode(item) },
      { label: 'Duplicate', onClick: () => duplicateItem(item) },
      { label: item.currentVisible() ? 'Hide' : 'Show', onClick: () => item.setVisible(!item.currentVisible()) },
      tabular(item) && { separator: true },
      tabular(item) && { label: open ? 'Close floating table' : 'Float table over plot', onClick: () => { item.setParams({ tableOpen: !open }); if (!open) setActiveTab('net'); bumpTable(); } },
      (tabular(item) && open) && { label: 'Reset table size & position', onClick: () => { item.setParams({ tablePos: undefined, tableW: undefined, tableH: undefined, tableMin: false }); bumpTable(); } },
      { separator: true },
      { label: 'Remove', danger: true, onClick: () => { project.remove(item); reselectAfterRemove(item); } },
    ];
  }
  function groupMenu(group) {
    return [
      { label: 'Rename…', onClick: () => renameNode(group) },
      { label: group.currentVisible() ? 'Hide' : 'Show', onClick: () => group.setVisible(!group.currentVisible()) },
      { label: group.currentExpanded() ? 'Collapse' : 'Expand', onClick: () => group.setExpanded(!group.currentExpanded()) },
      { separator: true },
      { label: 'Ungroup (keep children)', onClick: () => { const p = project.parentOf(group); group.currentChildren().slice().reverse().forEach((c) => project.move(c, p, 0)); project.remove(group); reselectAfterRemove(group); } },
      { label: 'Remove group + children', danger: true, onClick: () => { project.remove(group); reselectAfterRemove(group); } },
    ];
  }
  // copy the clicked direction in a chosen representation (shared attitude formatter)
  function copyAttitudeMenu(dcos) {
    const [t, p] = conversions.dcosToLine(dcos), [dd, dip] = conversions.dcosToPlane(dcos);
    return [
      { label: `Line  ${az(t)}/${p2(p)}`, onClick: () => copyText(`${Math.round(t)}/${Math.round(p)}`) },
      { label: `Plane  ${az(dd)}/${p2(dip)}`, onClick: () => copyText(`${Math.round(dd)}/${Math.round(dip)}`) },
      { label: `Strike/dip  ${az((dd + 270) % 360)}/${p2(dip)}`, onClick: () => copyText(`${Math.round((dd + 270) % 360)}/${Math.round(dip)}`) },
      { label: 'Direction cosines', onClick: () => copyText(`[${dcos.map((v) => v.toFixed(4)).join(', ')}]`) },
    ];
  }
  // convert an annotation endpoint between attitude/figure space, keeping it put
  function setAnnoSpace(a, key, coordKey, v) {
    const cs = a.currentStyle(), old = cs[key] || 'attitude', cur = cs[coordKey];
    if (old !== v && cur) { const pt = net.place(old, cur[0], cur[1]); const nc = net.locate(v, pt.x, pt.y); a.setStyle({ ...cs, [key]: v, ...(nc ? { [coordKey]: nc } : {}) }); }
    else a.setStyle({ ...cs, [key]: v });
  }
  const setAnno = (a, patch) => a.setStyle({ ...a.currentStyle(), ...patch });
  function annoMenu(a) {
    const st = a.currentStyle();
    return [
      { label: 'Edit text', onClick: () => editAnno(a) },
      { label: 'Bold', checked: !!st.bold, onClick: () => setAnno(a, { bold: !a.currentStyle().bold }) },
      { label: 'Background box', checked: !!st.box, onClick: () => setAnno(a, { box: !a.currentStyle().box }) },
      { separator: true },
      { label: 'Anchor space', submenu: [
        { label: 'attitude (follows rotation)', checked: (st.anchorSpace || 'attitude') === 'attitude', onClick: () => setAnnoSpace(a, 'anchorSpace', 'anchor', 'attitude') },
        { label: 'figure (fixed on the page)', checked: st.anchorSpace === 'figure', onClick: () => setAnnoSpace(a, 'anchorSpace', 'anchor', 'figure') },
      ] },
      { label: 'Lock anchor', checked: !!st.anchorLock, onClick: () => setAnno(a, { anchorLock: !a.currentStyle().anchorLock }) },
      { separator: true },
      { label: st.leader ? 'Hide leader' : 'Show leader', onClick: () => setAnno(a, { leader: st.leader ? null : [...(st.anchor || [0, 90])] }) },
      st.leader && { label: 'Leader space', submenu: [
        { label: 'attitude', checked: (st.leaderSpace || 'attitude') === 'attitude', onClick: () => setAnnoSpace(a, 'leaderSpace', 'leader', 'attitude') },
        { label: 'figure', checked: st.leaderSpace === 'figure', onClick: () => setAnnoSpace(a, 'leaderSpace', 'leader', 'figure') },
      ] },
      st.leader && { label: 'Arrowhead', checked: !!st.leaderArrow, onClick: () => setAnno(a, { leaderArrow: !a.currentStyle().leaderArrow }) },
      st.leader && { label: 'Lock leader', checked: !!st.leaderLock, onClick: () => setAnno(a, { leaderLock: !a.currentStyle().leaderLock }) },
      { separator: true },
      { label: 'Duplicate', onClick: () => duplicateItem(a) },
      { label: 'Remove', danger: true, onClick: () => { project.remove(a); reselectAfterRemove(a); } },
    ];
  }
  // measure every column to max-content and lock those widths
  function autofitAll(item) {
    const dt = root.querySelector(`.dtable[data-item="${item.id}"]`); if (!dt) return;
    const n = (item.constructor.GEOM || []).length + item.currentColumns().length;
    dt.style.gridTemplateColumns = `44px ${Array.from({ length: n }, () => 'max-content').join(' ')}${isEditing(item.id) ? ' 34px' : ''}`;
    const w = []; for (let i = 0; i < n; i++) { const th = dt.querySelector(`.th[data-col="${i}"]`); w[i] = th ? Math.max(40, Math.ceil(th.getBoundingClientRect().width) + 2) : 80; }
    item.setParams({ tableColW: w }); bumpTable();
  }
  function decorMenu() {
    return [
      { label: 'Hide legend', onClick: () => project.setLegendShow(false) },
      { label: 'Reset position', onClick: () => project.setLegendPos([-0.98, -0.62]) },
    ];
  }
  function panelMenu(item) {
    const pr = item.currentParams();
    return [
      { label: pr.tableMin ? 'Expand' : 'Minimise', onClick: () => { item.setParams({ tableMin: !pr.tableMin }); bumpTable(); } },
      { label: isEditing(item.id) ? 'Stop editing' : 'Edit cells', onClick: () => toggleEditing(item.id) },
      { label: 'Auto-fit all columns', onClick: () => autofitAll(item) },
      { label: 'Reset column widths', onClick: () => { item.setParams({ tableColW: undefined }); bumpTable(); } },
      { label: 'Reset size & position', onClick: () => { item.setParams({ tablePos: undefined, tableW: undefined, tableH: undefined, tableMin: false }); bumpTable(); } },
      { separator: true },
      { label: 'Select layer', onClick: () => setSelected(item) },
      { label: 'Open in table tab', onClick: () => { setSelected(item); setActiveTab('table'); } },
      { separator: true },
      { label: 'Close table', danger: true, onClick: () => { item.setParams({ tableOpen: false }); bumpTable(); } },
    ];
  }
  net.onContextMenu = ({ clientX, clientY, dcos, id }) => {
    const item = id ? project.items().find((x) => x.id === id) : null;
    const items = [];
    if (item) {
      items.push({ label: `Select “${item.currentName()}”`, onClick: () => setSelected(item) });
      if (dcos && tabular(item)) items.push({ label: 'Identify nearest datum', onClick: () => { setSelected(item); const i = nearestDatum(item, dcos); if (i >= 0) flashDatum(item, i); } });
      if (tabular(item)) items.push({ label: item.currentParams().tableOpen ? 'Close its table' : 'Float its table', onClick: () => { item.setParams({ tableOpen: !item.currentParams().tableOpen }); bumpTable(); } });
      items.push({ separator: true });
    }
    if (dcos) {
      const [t, p] = conversions.dcosToLine(dcos);
      items.push({ label: 'Copy attitude as', submenu: copyAttitudeMenu(dcos) });
      items.push({ label: 'Add annotation here', onClick: () => addAnnotationAt(t, p) });
      items.push({ separator: true });
    }
    items.push({ label: 'Legend', checked: project.legendShow(), onClick: () => project.setLegendShow(!project.legendShow()) });
    items.push({ label: 'Add title', onClick: () => addTitle() });
    items.push({ label: 'Reset orientation', onClick: () => net.resetView() });
    openMenu(clientX, clientY, items);
  };
  // full rebuild — on add / edit / select / remove. Skipped during a drag so the
  // captured element isn't yanked out from under the pointer.
  function renderAnnos() {
    if (overlayDragging) return;
    if (!fitOverlay()) { annoLayer.replaceChildren(); return; }
    const annos = visibleAnnos();
    const rows = annos.map((a) => {
      const st = a.style();
      const anchor = net.place(st.anchorSpace || 'attitude', ...(st.anchor || [0, 90]));
      const el = document.createElement('div');
      el.dataset.annoLabel = a.id;
      el.className = `anno-label${anchor.hidden ? ' under' : ''}${selected() === a ? ' sel' : ''}${st.anchorLock ? ' locked' : ''}`;
      el.style.left = `${anchor.x}px`; el.style.top = `${anchor.y}px`;
      el.style.color = st.color || '#1d2733'; el.style.fontSize = `${st.fontSize || 13}px`; el.style.fontWeight = st.bold ? 700 : 400;
      if (st.box) { el.classList.add('box'); el.style.background = st.bgColor || '#ffffff'; }
      el.textContent = st.text || 'note';
      el.onclick = (ev) => { ev.stopPropagation(); setSelected(a); };
      el.ondblclick = (ev) => { ev.stopPropagation(); startEdit(a, el); };
      el.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); setSelected(a); openMenu(ev.clientX, ev.clientY, annoMenu(a)); };
      el.addEventListener('pointerdown', (ev) => dragPoint(ev, a, el, 'anchor'));
      if (pendingEdit === a.id) { pendingEdit = null; (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(() => startEdit(a, el)); }
      return { a, st, el };
    });
    annoLayer.replaceChildren(annoLeaders, ...rows.map((r) => r.el));   // append labels first so they're measurable
    const lines = [], handles = [];
    for (const { a, st, el } of rows) {
      el._half = [(el.offsetWidth || 20) / 2 + 2, (el.offsetHeight || 16) / 2 + 2];  // cache size for reflow-free updates
      if (!st.leader) continue;
      const t = net.place(st.leaderSpace || 'attitude', st.leader[0], st.leader[1]);
      lines.push(`<line data-anno="${a.id}" stroke="${st.color || '#1d2733'}" stroke-width="1"/>`);   // geometry set by refreshLeader
      if (st.leaderArrow) lines.push(`<path data-arrow="${a.id}" fill="${st.color || '#1d2733'}"/>`);
      // handle is always present (grabbable 20px target) but its dot only shows on
      // hover or when the annotation is selected (see .anno-handle CSS)
      const hd = document.createElement('div');
      hd.dataset.annoHandle = a.id;
      hd.className = `anno-handle${st.leaderLock ? ' locked' : ''}${selected() === a ? ' sel' : ''}`;
      hd.style.left = `${t.x}px`; hd.style.top = `${t.y}px`;
      hd.onclick = (ev) => { ev.stopPropagation(); setSelected(a); };
      hd.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); setSelected(a); openMenu(ev.clientX, ev.clientY, annoMenu(a)); };
      hd.addEventListener('pointerdown', (ev) => dragPoint(ev, a, hd, 'leader'));
      handles.push(hd);
    }
    annoLeaders.innerHTML = lines.join('');
    annoLayer.replaceChildren(annoLeaders, ...rows.map((r) => r.el), ...handles);
    for (const { a, st } of rows) if (st.leader) refreshLeader(a);     // single source of leader geometry
  }
  // lightweight per-frame path (rotation / resize) — move existing elements, no
  // DOM churn. Falls back to a full rebuild if the element set is out of sync.
  function repositionAnnos() {
    if (overlayDragging) return;
    const annos = visibleAnnos();
    if (annoLayer.querySelectorAll('[data-anno-label]').length !== annos.length
      || annos.some((a) => !annoLayer.querySelector(`[data-anno-label="${a.id}"]`))) { renderAnnos(); return; }
    if (!fitOverlay()) return;
    for (const a of annos) {
      const st = a.style();
      const label = annoLayer.querySelector(`[data-anno-label="${a.id}"]`);
      const anchor = net.place(st.anchorSpace || 'attitude', ...(st.anchor || [0, 90]));
      label.style.left = `${anchor.x}px`; label.style.top = `${anchor.y}px`;
      label.classList.toggle('under', anchor.hidden);
      if (st.leader) {
        const handle = annoLayer.querySelector(`[data-anno-handle="${a.id}"]`);
        const t = net.place(st.leaderSpace || 'attitude', st.leader[0], st.leader[1]);
        if (handle) { handle.style.left = `${t.x}px`; handle.style.top = `${t.y}px`; }
        refreshLeader(a);
      }
    }
  }
  // ── floating data tables (figure-space panels over the net) ──
  // A layer's table, pinned over the plot: drag by the title bar, minimise, close.
  // Config lives in the item's params (tableOpen/tablePos[u,v]/tableW/tableMin) so
  // it serializes + undoes for free. Figure space → fixed under rotation.
  const PANEL_POS = [0.28, 0.96];                                      // default top-left, figure coords
  function dragPanel(e, item, panel) {
    if (e.button !== 0) return;
    e.preventDefault();                                               // let it bubble to the panel's click-to-select
    const cap = e.currentTarget; cap.setPointerCapture?.(e.pointerId); overlayDragging = true;
    const r0 = net.element.getBoundingClientRect();
    const offX = e.clientX - r0.left - px(panel.style.left), offY = e.clientY - r0.top - px(panel.style.top);
    let coords = null;
    const move = (ev) => {
      const r = net.element.getBoundingClientRect();
      const x = ev.clientX - r.left - offX, y = ev.clientY - r.top - offY;
      panel.style.left = `${x}px`; panel.style.top = `${y}px`;
      coords = net.locate('figure', x, y);
    };
    const up = () => {
      cap.removeEventListener('pointermove', move); cap.removeEventListener('pointerup', up);
      overlayDragging = false;
      if (coords) item.setParams({ tablePos: coords });
    };
    cap.addEventListener('pointermove', move); cap.addEventListener('pointerup', up);
  }
  // resize from the bottom-right corner; commits width/height to params on release
  function resizePanel(e, item, panel) {
    if (e.button !== 0) return;
    e.preventDefault();
    const cap = e.currentTarget; cap.setPointerCapture?.(e.pointerId); overlayDragging = true;
    const body = panel.querySelector('.fp-body');
    const x0 = e.clientX, y0 = e.clientY, w0 = panel.offsetWidth, h0 = body ? body.offsetHeight : 0;
    let w = w0, hh = h0;
    const move = (ev) => {
      w = Math.max(150, w0 + (ev.clientX - x0)); panel.style.width = `${w}px`;
      if (body) { hh = Math.max(60, h0 + (ev.clientY - y0)); body.style.height = `${hh}px`; }
    };
    const up = () => {
      cap.removeEventListener('pointermove', move); cap.removeEventListener('pointerup', up);
      overlayDragging = false;
      item.setParams({ tableW: Math.round(w), tableH: body ? Math.round(hh) : item.currentParams().tableH });
    };
    cap.addEventListener('pointermove', move); cap.addEventListener('pointerup', up);
  }
  function buildPanel(item) {
    const pr = item.currentParams(), pos = pr.tablePos || PANEL_POS, min = !!pr.tableMin;
    const p = net.place('figure', pos[0], pos[1]);
    const panel = document.createElement('div');
    panel.dataset.panel = item.id;
    panel.className = `floatpanel${min ? ' min' : ''}`;                 // .sel maintained by a separate effect (no rebuild on select)
    panel.style.left = `${p.x}px`; panel.style.top = `${p.y}px`; panel.style.width = `${pr.tableW || 300}px`;
    panel.addEventListener('pointerdown', () => setSelected(item));     // click anywhere → select this layer
    panel.addEventListener('contextmenu', (e) => { if (e.target.closest('input')) return; e.preventDefault(); e.stopPropagation(); setSelected(item); openMenu(e.clientX, e.clientY, panelMenu(item)); });
    const bar = h`<div class="fp-bar">
      <span class="fp-title">${item.currentName()}</span>
      <span class="fp-actions">
        <button class="fp-btn" title=${min ? 'expand' : 'minimise'} onclick=${() => { item.setParams({ tableMin: !min }); bumpTable(); }}>${min ? '▸' : '▾'}</button>
        <button class="fp-btn" title="close" onclick=${() => { item.setParams({ tableOpen: false }); bumpTable(); }}>×</button>
      </span></div>`;
    bar.addEventListener('pointerdown', (ev) => { if (ev.target.closest('.fp-btn')) return; dragPanel(ev, item, panel); });
    panel.append(bar);
    if (!min) {
      const body = document.createElement('div'); body.className = 'fp-body';
      if (pr.tableH) body.style.height = `${pr.tableH}px`;
      body.append(dataTable(item, isEditing(item.id), true)); panel.append(body);
      const grip = document.createElement('div'); grip.className = 'fp-resize'; grip.title = 'resize';
      grip.addEventListener('pointerdown', (ev) => resizePanel(ev, item, panel)); panel.append(grip);
    }
    return panel;
  }
  function renderPanels() {
    if (overlayDragging) return;
    if (!fitOverlay()) { panelLayer.replaceChildren(); return; }
    panelLayer.replaceChildren(...tabularItems().filter((it) => it.currentParams().tableOpen).map(buildPanel));
  }
  function repositionPanels() {                                       // resize-only (figure space is rotation-fixed)
    if (overlayDragging) return;
    const open = tabularItems().filter((it) => it.currentParams().tableOpen);
    if (panelLayer.children.length !== open.length || open.some((it) => !panelLayer.querySelector(`[data-panel="${it.id}"]`))) { renderPanels(); return; }
    if (!fitOverlay()) return;
    for (const it of open) {
      const pos = it.currentParams().tablePos || PANEL_POS, p = net.place('figure', pos[0], pos[1]);
      const panel = panelLayer.querySelector(`[data-panel="${it.id}"]`);
      panel.style.left = `${p.x}px`; panel.style.top = `${p.y}px`;
    }
  }
  const repositionOverlay = () => { repositionAnnos(); repositionPanels(); repositionDecor(); };
  net.onAfterRender = repositionOverlay;                               // rotation: cheap reposition, no DOM churn
  effect(() => { selected(); project.visibleLeaves().forEach((it) => { it.style(); it.name(); }); renderAnnos(); });   // structure: full rebuild on add/edit/select/remove
  // panels rebuild on open/close/min/move/resize/name/edit-mode + structural table
  // edits (tableVer); cell edits write through untracked (like the tab) so they keep
  // focus. NOT on selected() — that only re-outlines (separate effect, no rebuild).
  effect(() => { editSet(); tableVer(); tabularItems().forEach((it) => { it.params(); it.name(); }); renderPanels(); });
  effect(() => { const s = selected(); for (const el of panelLayer.querySelectorAll('.floatpanel')) el.classList.toggle('sel', !!s && el.dataset.panel === s.id); });

  const wraps = {
    net: h`<div class="plotwrap">${net.element}${brushLayer}${decorLayer}${annoLayer}${panelLayer}</div>`,
    rose: h`<div class="plotwrap">${rose.element}</div>`,
    fabric: h`<div class="plotwrap">${fabric.element}</div>`,
    table: h`<div class="plotwrap tablewrap">${tableHost}</div>`,
  };
  // observe the stable plotwrap (net.element is swapped on projection rebuilds) so a
  // window/gutter resize repositions overlay elements even without an intervening render
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(repositionOverlay).observe(wraps.net);
  effect(() => { for (const k in wraps) wraps[k].style.display = activeTab() === k ? 'flex' : 'none'; if (activeTab() === 'net' && typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(repositionOverlay); });

  // ── header / footer ──
  const projSeg = (proj, label) => h`<button class=${() => (project.projection() === proj ? 'seg on' : 'seg')} onclick=${() => project.setProjection(proj)}>${label}</button>`;
  const MODE_TIP = { select: 'select (s): click a layer to select · empty to deselect · Alt-drag to rotate', measure: 'measure (m): click two points → angle + their common plane', rotate: 'rotate (r): drag to spin the net', pick: 'pick (p): click to add a measurement to the selected layer' };
  const modeSeg = (m, label) => h`<button class=${() => (mode() === m ? 'seg on' : 'seg')} title=${MODE_TIP[m]} onclick=${() => setMode(m)}>${label}</button>`;
  const cursorText = () => {
    const d = cursor();
    if (!d) return mode() === 'measure' ? 'measure: click two points' : mode() === 'select' ? 'select: click a layer · empty to deselect' : '';
    const [t, p] = conversions.dcosToLine(d);
    const [dd, dip] = conversions.dcosToPlane(d);
    return `line ${az(t)}/${p2(p)}  ·  plane ${az(dd)}/${p2(dip)}`;
  };
  const measureText = () => {
    const m = measure();
    if (!m) return notice() || cursorText();
    const [ta, pa] = conversions.dcosToLine(m.a), [tb, pb] = conversions.dcosToLine(m.b);
    const [dd, dip] = conversions.dcosToPlane(m.pole);
    return `${az(ta)}/${p2(pa)} → ${az(tb)}/${p2(pb)}  ·  ${m.angle.toFixed(1)}°  ·  plane ${az(dd)}/${p2(dip)}`;
  };
  // construct a layer from the current measurement (common plane / its axis)
  const constructFrom = (kind) => {
    const m = measure(); if (!m) return;
    const color = PALETTE[project.items().length % PALETTE.length];
    if (kind === 'plane') { const [dd, dip] = conversions.dcosToPlane(m.pole).map(Math.round); addPayload({ type: 'planes', name: 'plane', measurements: [[dd, dip]], style: { color, width: 1 } }); }
    else { const [t, p] = conversions.dcosToLine(m.pole).map(Math.round); addPayload({ type: 'lines', name: 'axis', measurements: [[t, p]], style: { color, size: 5 } }); }
  };
  const measureBar = document.createElement('span');
  measureBar.className = 'measurebar';
  effect(() => {
    if (!measure()) { measureBar.replaceChildren(); return; }
    measureBar.replaceChildren(h`<button class="mini" onclick=${() => constructFrom('plane')}>＋plane</button><button class="mini" onclick=${() => constructFrom('axis')}>＋axis</button><button class="mini" onclick=${() => { net.clearMeasure(); setMeasure(null); }}>clear</button>`);
  });
  const countText = () => {
    let n = 0; for (const it of project.items()) n += it.measurements().length;
    return `${project.items().length} sets · ${n} measurements · ${project.projection()}, ${project.hemisphere()} hemisphere`;
  };

  // draggable column gutter — resizes the data rail (side) or inspector (insp)
  const LAYOUT_KEY = 'osjs-layout';
  function gutter(which) {
    const el = document.createElement('div');
    el.className = 'gutter';
    el.addEventListener('pointerdown', (e) => {
      const body = el.closest('.body'); if (!body) return;
      const prop = which === 'side' ? '--side-w' : '--insp-w';
      const startX = e.clientX;
      const startW = parseFloat(getComputedStyle(body).getPropertyValue(prop)) || (which === 'side' ? 264 : 300);
      el.setPointerCapture?.(e.pointerId); el.classList.add('drag'); e.preventDefault();
      const move = (ev) => {
        const w = Math.max(180, Math.min(560, which === 'side' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX)));
        body.style.setProperty(prop, `${w}px`);
      };
      const up = () => {
        el.classList.remove('drag');
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        lsSet(LAYOUT_KEY, JSON.stringify({ side: body.style.getPropertyValue('--side-w'), insp: body.style.getPropertyValue('--insp-w') }));
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    return el;
  }
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const app = h`<div class="osjs-app"
      ondragover=${(e) => { if (hasFiles(e)) e.preventDefault(); }}
      ondrop=${(e) => { if (hasFiles(e)) { e.preventDefault(); openFiles(e.dataTransfer.files); } }}>
    <header class="topbar">
      <div class="brand"><span class="glyph">⌖</span><span class="name">OSJS</span><span class="sub">OpenStereo · web edition</span></div>
      <span class="spacer"></span>
      <div class="grp">${projSeg('equal-area', 'equal-area')}${projSeg('equal-angle', 'equal-angle')}</div>
      <div class="grp" title="net interaction mode">
        ${modeSeg('select', 'select')}${modeSeg('measure', 'measure')}${modeSeg('rotate', 'rotate')}${modeSeg('pick', 'pick')}
        <button class="seg" title="reset orientation (0)" onclick=${() => net.resetView()}>⟲</button>
      </div>
      <div class="grp">
        <button class=${() => (canUndo() ? 'seg' : 'seg dim')} title="undo (Ctrl+Z)" onclick=${undo}>↶</button>
        <button class=${() => (canRedo() ? 'seg' : 'seg dim')} title="redo (Ctrl+Shift+Z)" onclick=${redo}>↷</button>
      </div>
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
          <button class="sectbtn" title="add a text annotation (double-click on the plot to edit)" onclick=${() => { const a = project.add(new ITEM_TYPES.annotation({ name: 'note', style: { color: '#1d2733', fontSize: 13, text: 'note', anchor: [0, 90] } })); setActiveTab('net'); setSelected(a); pendingEdit = a.id; }}>＋ note</button>
          <button class="sectbtn" title="add a figure title" onclick=${() => addTitle()}>＋ title</button>
          <button class="sectbtn" title="add a group" onclick=${() => setSelected(project.addGroup('group'))}>＋ group</button></div>
        <div class="list" ondragover=${(e) => { if (dragNode) e.preventDefault(); }} ondrop=${(e) => { e.preventDefault(); if (dragNode) { project.move(dragNode, null, project.nodes().length); dragNode = null; } }}>${list}</div>
        ${addHost}
        <div class="samplesrow"><span>samples</span>${SAMPLES.map((s) => h`<button class="slink" onclick=${() => loadSample(s)}>${s.label}</button>`)}</div>
      </aside>
      ${gutter('side')}
      <main class="main">
        <div class="tabs">${tab('net', 'projection')}${tab('rose', 'rose')}${tab('fabric', 'fabric')}${tab('table', 'table')}</div>
        <div class="plotarea">${wraps.net}${wraps.rose}${wraps.fabric}${wraps.table}${emptyState}</div>
      </main>
      ${gutter('insp')}
      <aside class="inspector">
        <div class="sect">properties</div>
        ${propsHost}
        <div class="sect">settings</div>
        ${settings}
      </aside>
    </div>
    <footer class="statusbar">
      <span class="cur">${() => measureText()}</span>
      ${measureBar}
      <span class="spacer"></span>
      <span class="cnt">${() => countText()}</span>
    </footer>
  </div>`;

  root.replaceChildren(app);
  try {                                            // restore saved panel widths
    const saved = JSON.parse(lsGet(LAYOUT_KEY) || 'null'); const body = app.querySelector('.body');
    if (saved && body) { if (saved.side) body.style.setProperty('--side-w', saved.side); if (saved.insp) body.style.setProperty('--insp-w', saved.insp); }
  } catch { /* ignore */ }
  return { project, net, rose, fabric, select: setSelected };
}
