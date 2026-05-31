/**
 * @module ui/selection — data selection on the net (lasso / cone / rect).
 *
 * A region drag selects measurements of the visible layers; the selection is a
 * Map(itemId → Set of datum indices), highlighted with rings on a layer over the
 * net (the selLayer spans the whole plot; net.place is net-relative, so the SVG is
 * translated by the net's offset). Actions: extract → new layer, invert, clear.
 *
 * Domain-specific (uses dcos / attitude space), so it lives in OSJS, not the
 * generic composer. Factory keeps it decoupled from the app's other state.
 *   createSelection({ net, project, conversions, vec3, signal, effect, h,
 *                     ITEM_TYPES, mode, selCombine, onSelect })
 *   mode / selCombine are getters; onSelect = setSelected.
 */

export function createSelection({ net, project, conversions, vec3, statistics, signal, effect, h, ITEM_TYPES, mode, selCombine, onSelect, notify = () => {} }) {
  const [selection, setSelection] = signal(new Map());
  const selLayer = document.createElement('div'); selLayer.className = 'sellayer';
  const selSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); selSvg.setAttribute('class', 'sel-svg'); selLayer.append(selSvg);

  const selItems = () => project.visibleLeaves().filter((it) => it.type !== 'annotation');
  const selCount = () => { let n = 0; for (const s of selection().values()) n += s.size; return n; };
  let regionPreview = null;

  function renderSelection() {
    const wrap = net.element.parentElement, nr = net.element.getBoundingClientRect();
    if (!wrap || !nr.width) { selSvg.innerHTML = ''; return; }
    const wrr = wrap.getBoundingClientRect(), offX = nr.left - wrr.left, offY = nr.top - wrr.top;
    const sel = selection(); const out = [];
    for (const it of selItems()) {
      const idx = sel.get(it.id); if (!idx || !idx.size) continue;
      const ds = it.dcos();
      for (const i of idx) { const v = ds[i]; if (!v) continue; const [t, p] = conversions.dcosToLine(v); const pt = net.place('attitude', t, p); out.push(`<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="7" class="sel-ring${pt.hidden ? ' back' : ''}"/>`); }
    }
    if (regionPreview) out.push(regionPreview);
    selSvg.innerHTML = `<g transform="translate(${offX.toFixed(1)} ${offY.toFixed(1)})">${out.join('')}</g>`;
  }
  // cone outline → polyline segments, broken where it crosses to the back hemisphere
  function coneSegments(axis, r) {
    const u = vec3.normalize(vec3.cross(axis, Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), w = vec3.cross(axis, u);
    const runs = []; let cur = [];
    for (let k = 0; k <= 96; k++) {
      const th = (k / 96) * 2 * Math.PI;
      const d = vec3.normalize(vec3.add(vec3.scale(axis, Math.cos(r)), vec3.add(vec3.scale(u, Math.sin(r) * Math.cos(th)), vec3.scale(w, Math.sin(r) * Math.sin(th)))));
      const [t, pl] = conversions.dcosToLine(d), q = net.place('attitude', t, pl);
      if (q.hidden) { if (cur.length > 1) runs.push(cur); cur = []; } else cur.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
    }
    if (cur.length > 1) runs.push(cur);
    return runs;
  }
  const pointInPoly = (x, y, poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  // combine: 'replace' | 'add' | 'subtract'
  function commitSelection(test, combine) {
    const base = combine === 'add' || combine === 'subtract' ? new Map([...selection()].map(([k, v]) => [k, new Set(v)])) : new Map();
    for (const it of selItems()) {
      const ds = it.dcos(); const hit = base.get(it.id) || new Set();
      for (let i = 0; i < ds.length; i++) { const [t, p] = conversions.dcosToLine(ds[i]); const q = net.place('attitude', t, p); if (!q.hidden && test(q.x, q.y, ds[i])) { if (combine === 'subtract') hit.delete(i); else hit.add(i); } }
      if (hit.size) base.set(it.id, hit); else base.delete(it.id);
    }
    setSelection(base);
  }
  // pointer drag on the selection layer (active only in a selection mode). Re-arms
  // after each gesture (capture released); Shift = add, Alt/Ctrl = subtract.
  let drag = null;
  const local = (e) => { const r = net.element.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const combineOf = (e) => (e.shiftKey ? 'add' : (e.altKey || e.ctrlKey || e.metaKey) ? 'subtract' : selCombine());
  selLayer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; e.preventDefault(); selLayer.setPointerCapture?.(e.pointerId);
    const m = mode(), p = local(e), cmb = combineOf(e);
    if (m === 'lasso') drag = { tool: 'lasso', pts: [p], cmb };
    else if (m === 'rect') drag = { tool: 'rect', start: p, cmb };
    else if (m === 'cone') { const c = net.locate('attitude', p[0], p[1]); drag = c ? { tool: 'cone', axis: conversions.lineToDcos(c[0], c[1]), r: 0, cmb } : null; }
  });
  selLayer.addEventListener('pointermove', (e) => {
    if (!drag) return; const [x, y] = local(e);
    if (drag.tool === 'lasso') { drag.pts.push([x, y]); regionPreview = `<polygon class="lasso" points="${drag.pts.map((p) => p.join(',')).join(' ')}"/>`; }
    else if (drag.tool === 'rect') { const [sx, sy] = drag.start; drag.rect = [Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy)]; regionPreview = `<rect class="lasso" x="${drag.rect[0]}" y="${drag.rect[1]}" width="${drag.rect[2]}" height="${drag.rect[3]}"/>`; }
    else if (drag.tool === 'cone') { const c = net.locate('attitude', x, y); if (c) { const d = conversions.lineToDcos(c[0], c[1]); drag.r = Math.acos(Math.max(-1, Math.min(1, Math.abs(vec3.dot(drag.axis, d))))); regionPreview = coneSegments(drag.axis, drag.r).map((run) => `<polyline class="cone" points="${run.join(' ')}"/>`).join(''); } }
    renderSelection();
  });
  selLayer.addEventListener('pointerup', (e) => {
    selLayer.releasePointerCapture?.(e.pointerId);
    if (drag) {
      if (drag.tool === 'lasso' && drag.pts.length > 2) { const poly = drag.pts; commitSelection((x, y) => pointInPoly(x, y, poly), drag.cmb); }
      else if (drag.tool === 'rect' && drag.rect) { const [rx, ry, rw, rh] = drag.rect; commitSelection((x, y) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh, drag.cmb); }
      else if (drag.tool === 'cone' && drag.r > 0) { const ax = drag.axis, r = drag.r; commitSelection((x, y, v) => Math.acos(Math.min(1, Math.abs(vec3.dot(ax, v)))) <= r, drag.cmb); }
    }
    drag = null; regionPreview = null; renderSelection();
  });
  effect(() => { const m = mode(); selLayer.style.pointerEvents = (m === 'lasso' || m === 'cone' || m === 'rect') ? 'auto' : 'none'; });
  effect(() => { selection(); renderSelection(); });

  const clear = () => setSelection(new Map());
  function extractSelection() {
    const sel = selection(); if (!selCount()) return;
    for (const it of selItems()) {
      const idx = sel.get(it.id); if (!idx || !idx.size) continue;
      const order = [...idx].sort((a, b) => a - b), meas = it.currentMeasurements(), cols = it.currentColumns();
      const payload = { type: it.type, name: `${it.currentName()} sel`, measurements: order.map((i) => (Array.isArray(meas[i]) ? meas[i].slice() : meas[i])), columns: cols.map((c) => ({ name: c.name, values: order.map((i) => c.values[i]) })), style: { ...it.currentStyle() } };
      if (payload.measurements.length) onSelect(project.add(new (ITEM_TYPES[it.type] || ITEM_TYPES.planes)(payload)));
    }
    clear();
  }
  function invertSelection() {
    const sel = selection(), next = new Map();
    for (const it of selItems()) { const n = it.dcos().length, cur = sel.get(it.id) || new Set(), inv = new Set(); for (let i = 0; i < n; i++) if (!cur.has(i)) inv.add(i); if (inv.size) next.set(it.id, inv); }
    setSelection(next);
  }
  // tag the selection into a categorical 'set' column + colour by it (the manual
  // complement to auto k-means clustering). Tagging different subsets builds classes.
  function tagSelection(value) {
    const v = (value || '').trim(); const sel = selection(); if (!v || !selCount()) return;
    for (const it of selItems()) {
      const idx = sel.get(it.id); if (!idx || !idx.size) continue;
      const cols = it.currentColumns().map((c) => ({ name: c.name, values: c.values.slice() }));
      let si = cols.findIndex((c) => c.name === 'set');
      if (si < 0) { cols.push({ name: 'set', values: it.currentMeasurements().map(() => '') }); si = cols.length - 1; }
      for (const i of idx) cols[si].values[i] = v;
      it.setColumns(cols);
      it.setStyle({ ...it.currentStyle(), colorMode: 'categorical', colorBy: (it.constructor.GEOM || []).length + si });
    }
  }
  // pooled orientation stats on just the selected directions → footer read-out
  function statsSelection() {
    const sel = selection(), dc = [];
    for (const it of selItems()) { const idx = sel.get(it.id); if (!idx) continue; const ds = it.dcos(); for (const i of idx) if (ds[i]) dc.push(ds[i]); }
    if (dc.length < 2) { notify(`selection n=${dc.length} — need ≥2 for stats`); return; }
    const pa = statistics.principalAxes(dc), f = statistics.fisherStats(dc), [t, p] = conversions.dcosToLine(f.mean);
    const a3 = (x) => String(((Math.round(x) % 360) + 360) % 360).padStart(3, '0'), p2 = (x) => String(Math.round(x)).padStart(2, '0');
    notify(`selection n=${dc.length} · mean ${a3(t)}/${p2(p)} · S ${pa.eigenvalues.map((x) => x.toFixed(2)).join(' ')} · κ ${f.kappa.toFixed(1)}`);
  }
  const selBar = document.createElement('span');
  selBar.className = 'measurebar';
  effect(() => {
    const n = selCount();
    if (!n) { selBar.replaceChildren(); return; }
    const tagIn = document.createElement('input'); tagIn.className = 'tagin'; tagIn.placeholder = 'tag…'; tagIn.title = 'tag the selection as a category (→ categorical colour-by)';
    const apply = () => { tagSelection(tagIn.value); };
    tagIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    selBar.replaceChildren(
      h`<span class="selcount">${n} selected</span>`,
      tagIn,
      h`<button class="mini" onclick=${apply}>tag</button><button class="mini" onclick=${statsSelection}>stats</button><button class="mini" onclick=${extractSelection}>extract →</button><button class="mini" onclick=${invertSelection}>invert</button><button class="mini" onclick=${clear}>clear</button>`,
    );
  });

  return { selLayer, selBar, selection, selCount, commitSelection, extractSelection, invertSelection, tagSelection, statsSelection, clear, render: renderSelection };
}
