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
import { parsePairs, parseTable, guessRoles, buildFromTable } from '../io/parse.js';

const { conversions, color } = bearing;
const RAMPS = ['viridis', 'magma', 'inferno', 'plasma', 'thermal', 'grayscale'];
const PALETTE = ['#1aa39a', '#e8920c', '#cc3333', '#7a5cff', '#3a9a3a', '#c060c0', '#d4548a', '#5bb8d4'];
const az = (x) => String(((Math.round(x) % 360) + 360) % 360).padStart(3, '0');
const p2 = (x) => String(Math.round(x)).padStart(2, '0');
const fmtNum = (x) => (Number.isInteger(x) ? String(x) : Math.abs(x) >= 100 ? String(Math.round(x)) : x.toFixed(2));

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
        <option value="poles">poles</option><option value="lines">lines</option></select>`;
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
      if (!tbl || tbl.columns.length <= 2) { mapHost.replaceChildren(); return; }
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
      if (tbl && tbl.columns.length > 2) {
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
    const vis = project.items().filter((it) => it.visible());
    if (vis.length) legendHost.replaceChildren(h`<div class="lg">${vis.map(legendRow)}</div>`);
    else legendHost.replaceChildren();
  });
  const wraps = {
    net: h`<div class="plotwrap">${net.element}${legendHost}</div>`,
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
