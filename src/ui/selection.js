/**
 * @module ui/selection — data selection on the net.
 *
 * A region selects measurements of the visible layers; the selection is a
 * Map(itemId → Set of datum indices), highlighted with rings on a layer over the
 * net (the selLayer spans the whole plot; net.place is net-relative, so the SVG is
 * translated by the net's offset). Actions: extract → new layer, invert, clear.
 *
 * Tools come in two flavours:
 *  · screen-space drags — lasso (freehand loop), rect (box). View-dependent.
 *  · attitude-space regions, rotation-independent — cone (within an angle of an
 *    axis), band (within an angle of a plane's great circle), poly (inside a
 *    spherical polygon of great-circle edges, built by clicking vertices).
 *
 * Domain-specific (uses dcos / attitude space), so it lives in OSJS, not the
 * generic composer. Factory keeps it decoupled from the app's other state.
 *   createSelection({ net, project, conversions, vec3, curves, signal, effect, h,
 *                     ITEM_TYPES, mode, selCombine, onSelect })
 *   mode / selCombine are getters; onSelect = setSelected.
 */

export function createSelection({ net, project, conversions, vec3, curves, statistics, signal, effect, h, ITEM_TYPES, mode, selCombine, onSelect, notify = () => {}, onDataChange = () => {} }) {
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
    if (polyVerts && polyVerts.length) {                      // in-progress spherical polygon: edges + vertices
      for (let i = 0; i < polyVerts.length - 1; i++) for (const r of arcSegments(polyVerts[i], polyVerts[i + 1])) out.push(`<polyline class="cone" points="${r.join(' ')}"/>`);
      if (polyVerts.length >= 3) for (const r of arcSegments(polyVerts[polyVerts.length - 1], polyVerts[0])) out.push(`<polyline class="band-edge" points="${r.join(' ')}"/>`);
      polyVerts.forEach((v, i) => { const q = vertScreen(v); if (!q.hidden) out.push(`<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${i === 0 ? 4.5 : 3}" class="poly-vert${i === 0 ? ' first' : ''}"/>`); });
    }
    selSvg.innerHTML = `<g transform="translate(${offX.toFixed(1)} ${offY.toFixed(1)})">${out.join('')}</g>`;
  }
  // cone outline → polyline segments, broken where it crosses to the back hemisphere
  function coneSegments(axis, r) {
    const u = vec3.normalize(vec3.cross(axis, Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), w = vec3.cross(axis, u);
    const runs = []; let cur = [];
    for (let k = 0; k <= 96; k++) {
      const th = (k / 96) * 2 * Math.PI;
      const d = vec3.normalize(vec3.add(vec3.scale(axis, Math.cos(r)), vec3.add(vec3.scale(u, Math.sin(r) * Math.cos(th)), vec3.scale(w, Math.sin(r) * Math.sin(th)))));
      const q = net.placeDcos(d);
      if (q.hidden) { if (cur.length > 1) runs.push(cur); cur = []; } else cur.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
    }
    if (cur.length > 1) runs.push(cur);
    return runs;
  }
  const pointInPoly = (x, y, poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  const clamp1 = (x) => Math.max(-1, Math.min(1, x));
  // a great-circle edge between two dcos → polyline runs, broken where it dips to
  // the back hemisphere (same convention as coneSegments)
  function arcSegments(a, b) {
    const pts = curves.arc(a, b, 48), runs = []; let cur = [];
    for (const d of pts) { const q = net.placeDcos(d); if (q.hidden) { if (cur.length > 1) runs.push(cur); cur = []; } else cur.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`); }
    if (cur.length > 1) runs.push(cur);
    return runs;
  }
  // band outline = central great circle + the two flanking small circles (the
  // band is everything within `w` of the great circle, i.e. acos|dot|≥π/2−w). The
  // two edges are the radius-(π/2−w) small circles about the pole AND its antipode
  // (a radius-(π/2+w) circle about the pole is the same circle about −pole); using
  // the antipode keeps both radii <90° so they render as clean arcs, not the long
  // chords you get sampling a >90° circle through the back hemisphere.
  function bandSegments(axis, w) {
    const neg = vec3.scale(axis, -1);
    const mk = (ax, r, cls) => coneSegments(ax, r).map((run) => `<polyline class="${cls}" points="${run.join(' ')}"/>`).join('');
    return mk(axis, Math.PI / 2, 'cone') + mk(axis, Math.PI / 2 - w, 'band-edge') + mk(neg, Math.PI / 2 - w, 'band-edge');
  }
  // spherical point-in-polygon by signed-angle winding: sum the tangent-plane
  // angles each edge subtends at p; |Σ| ≈ 2π inside the polygon, ≈ 0 outside.
  // Works for the lower-hemisphere cap the verts + data share. Robust to non-convex.
  function sphInside(p, verts) {
    let sum = 0;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ta = vec3.sub(a, vec3.scale(p, vec3.dot(a, p))), tb = vec3.sub(b, vec3.scale(p, vec3.dot(b, p)));
      const la = Math.hypot(ta[0], ta[1], ta[2]), lb = Math.hypot(tb[0], tb[1], tb[2]);
      if (la < 1e-9 || lb < 1e-9) return true;                  // p sits on a vertex → treat as inside
      const ap = vec3.scale(ta, 1 / la), bp = vec3.scale(tb, 1 / lb);
      const ang = Math.acos(clamp1(vec3.dot(ap, bp))), sign = Math.sign(vec3.dot(vec3.cross(ap, bp), p));
      sum += sign * ang;
    }
    return Math.abs(sum) > Math.PI;
  }
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
  // spherical-polygon in progress: a list of vertex dcos built up by clicking
  // (multi-click, not a drag). Closed by clicking near the first vertex, by a
  // double-click, or committed via the public api; Escape cancels.
  let polyVerts = null, polyCmb = 'replace';
  const local = (e) => { const r = net.element.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const combineOf = (e) => (e.shiftKey ? 'add' : (e.altKey || e.ctrlKey || e.metaKey) ? 'subtract' : selCombine());
  const vertScreen = (v) => { const [t, p] = conversions.dcosToLine(v); return net.place('attitude', t, p); };
  function closePoly() { const verts = polyVerts, cmb = polyCmb; polyVerts = null; if (verts && verts.length >= 3) commitSelection((x, y, v) => sphInside(v, verts), cmb); renderSelection(); }
  function cancelPoly() { if (!polyVerts) return false; polyVerts = null; regionPreview = null; renderSelection(); return true; }
  selLayer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; e.preventDefault();
    const m = mode(), p = local(e), cmb = combineOf(e);
    if (m === 'poly') {                                  // multi-click: add a vertex, or close near the first
      const c = net.locate('attitude', p[0], p[1]); if (!c) return;
      if (polyVerts && polyVerts.length >= 3) { const q0 = vertScreen(polyVerts[0]); if (!q0.hidden && Math.hypot(q0.x - p[0], q0.y - p[1]) <= 12) { closePoly(); return; } }
      if (!polyVerts) { polyVerts = []; polyCmb = cmb; }
      polyVerts.push(conversions.lineToDcos(c[0], c[1])); renderSelection(); return;
    }
    selLayer.setPointerCapture?.(e.pointerId);
    if (m === 'lasso') drag = { tool: 'lasso', pts: [p], cmb };
    else if (m === 'rect') drag = { tool: 'rect', start: p, cmb };
    else if (m === 'cone') { const c = net.locate('attitude', p[0], p[1]); drag = c ? { tool: 'cone', axis: conversions.lineToDcos(c[0], c[1]), r: 0, cmb } : null; }
    else if (m === 'band') { const c = net.locate('attitude', p[0], p[1]); drag = c ? { tool: 'band', axis: conversions.lineToDcos(c[0], c[1]), w: 0, cmb } : null; }
  });
  selLayer.addEventListener('dblclick', (e) => { if (mode() === 'poly' && polyVerts && polyVerts.length >= 3) { e.preventDefault(); closePoly(); } });
  selLayer.addEventListener('pointermove', (e) => {
    if (!drag) return; const [x, y] = local(e);
    if (drag.tool === 'lasso') { drag.pts.push([x, y]); regionPreview = `<polygon class="lasso" points="${drag.pts.map((p) => p.join(',')).join(' ')}"/>`; }
    else if (drag.tool === 'rect') { const [sx, sy] = drag.start; drag.rect = [Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy)]; regionPreview = `<rect class="lasso" x="${drag.rect[0]}" y="${drag.rect[1]}" width="${drag.rect[2]}" height="${drag.rect[3]}"/>`; }
    else if (drag.tool === 'cone') { const c = net.locate('attitude', x, y); if (c) { const d = conversions.lineToDcos(c[0], c[1]); drag.r = Math.acos(clamp1(Math.abs(vec3.dot(drag.axis, d)))); regionPreview = coneSegments(drag.axis, drag.r).map((run) => `<polyline class="cone" points="${run.join(' ')}"/>`).join(''); } }
    else if (drag.tool === 'band') { const c = net.locate('attitude', x, y); if (c) { const d = conversions.lineToDcos(c[0], c[1]); drag.w = Math.acos(clamp1(Math.abs(vec3.dot(drag.axis, d)))); regionPreview = bandSegments(drag.axis, drag.w); } }
    renderSelection();
  });
  selLayer.addEventListener('pointerup', (e) => {
    selLayer.releasePointerCapture?.(e.pointerId);
    if (drag) {
      if (drag.tool === 'lasso' && drag.pts.length > 2) { const poly = drag.pts; commitSelection((x, y) => pointInPoly(x, y, poly), drag.cmb); }
      else if (drag.tool === 'rect' && drag.rect) { const [rx, ry, rw, rh] = drag.rect; commitSelection((x, y) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh, drag.cmb); }
      else if (drag.tool === 'cone' && drag.r > 0) { const ax = drag.axis, r = drag.r; commitSelection((x, y, v) => Math.acos(clamp1(Math.abs(vec3.dot(ax, v)))) <= r, drag.cmb); }
      else if (drag.tool === 'band' && drag.w > 0) { const ax = drag.axis, w = drag.w; commitSelection((x, y, v) => Math.abs(Math.acos(clamp1(Math.abs(vec3.dot(ax, v)))) - Math.PI / 2) <= w, drag.cmb); }
    }
    drag = null; regionPreview = null; renderSelection();
  });
  const SEL_MODES = new Set(['lasso', 'cone', 'rect', 'band', 'poly']);
  effect(() => { const m = mode(); selLayer.style.pointerEvents = SEL_MODES.has(m) ? 'auto' : 'none'; if (m !== 'poly') cancelPoly(); });   // leaving poly mid-draw discards the partial polygon
  effect(() => { selection(); renderSelection(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cancelPoly()) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);

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
  // tag the selection into a categorical column (default 'set') + colour by it (the
  // manual complement to k-means). Column is created if missing; tagging different
  // subsets builds classes. onDataChange() refreshes the tables.
  function tagSelection(value, colName) {
    const v = (value || '').trim(), name = (colName || '').trim() || 'set'; const sel = selection();
    if (!v || !selCount()) return;
    for (const it of selItems()) {
      const idx = sel.get(it.id); if (!idx || !idx.size) continue;
      const cols = it.currentColumns().map((c) => ({ name: c.name, values: c.values.slice() }));
      let si = cols.findIndex((c) => c.name === name);
      if (si < 0) { cols.push({ name, values: it.currentMeasurements().map(() => '') }); si = cols.length - 1; }
      for (const i of idx) cols[si].values[i] = v;
      it.setColumns(cols);
      it.setStyle({ ...it.currentStyle(), colorMode: 'categorical', colorBy: (it.constructor.GEOM || []).length + si });
    }
    onDataChange();
  }
  // distinct data-column names across the currently-selected layers (for the tag-column suggestions)
  const selColumnNames = () => { const s = new Set(); for (const it of selItems()) { if (selection().get(it.id)) for (const c of it.currentColumns()) s.add(c.name); } return [...s]; };
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
  let tagId = 0;
  effect(() => {
    const n = selCount();
    if (!n) { selBar.replaceChildren(); return; }
    const existing = new Set(selColumnNames());
    const colIn = document.createElement('input'); colIn.className = 'tagin'; colIn.placeholder = 'column'; colIn.value = 'set';
    colIn.title = 'column to tag — pick one or type a new name to create it';
    const dl = document.createElement('datalist'); dl.id = `tagcols${tagId++}`; for (const nm of existing) { const o = document.createElement('option'); o.value = nm; dl.append(o); } colIn.setAttribute('list', dl.id);
    const valIn = document.createElement('input'); valIn.className = 'tagin'; valIn.placeholder = 'tag…'; valIn.title = 'category value for the selected rows';
    const hint = document.createElement('span'); hint.className = 'taghint';
    const upd = () => { const c = colIn.value.trim(); hint.textContent = c && !existing.has(c) ? '+new' : ''; };
    colIn.addEventListener('input', upd); upd();
    const apply = () => tagSelection(valIn.value, colIn.value);
    valIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    selBar.replaceChildren(
      h`<span class="selcount">${n} selected</span>`,
      colIn, hint, valIn,
      h`<button class="mini" onclick=${apply}>tag</button><button class="mini" onclick=${statsSelection}>stats</button><button class="mini" onclick=${extractSelection}>extract →</button><button class="mini" onclick=${invertSelection}>invert</button><button class="mini" onclick=${clear}>clear</button>`,
      dl,
    );
  });

  return { selLayer, selBar, selection, selCount, commitSelection, extractSelection, invertSelection, tagSelection, statsSelection, clear, render: renderSelection };
}
