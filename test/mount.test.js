/**
 * Mount smoke tests — run the real shell under jsdom (dev-only dependency).
 *
 * `node -e import(app.js)` only *evaluates* the module; it never calls mountApp,
 * so reactivity/hoisting/render bugs (TDZ, scrambled sections) slip through. These
 * tests actually mount the app and assert the resulting DOM, the only way to catch
 * sideact `h` template bugs without a browser.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let mountApp;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="osjs"></div></body></html>', { pretendToBeVisual: true });
  // expose the globals the app + sideact + bearing reach for
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DocumentFragment = dom.window.DocumentFragment;
  globalThis.Node = dom.window.Node;
  globalThis.XMLSerializer = dom.window.XMLSerializer;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  ({ mountApp } = await import('../src/ui/app.js'));
});

const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

test('app mounts without throwing and builds the three regions', () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  assert.ok(handle && handle.project, 'mountApp returns a handle with a project');
  assert.ok(root.querySelector('.side'), 'data rail present');
  assert.ok(root.querySelector('.main'), 'plot area present');
  assert.ok(root.querySelector('.inspector'), 'inspector present');
  const headerBtns = [...root.querySelectorAll('.topbar button')].map((b) => (b.textContent || '').trim().toLowerCase());
  assert.ok(headerBtns.includes('save') && headerBtns.includes('open'), 'save/open project controls present');
  assert.equal(root.querySelectorAll('.body > .gutter').length, 2, 'two resize gutters (data rail + inspector)');
});

test('inspector sections render IN ORDER, each owning its own controls', () => {
  const root = document.createElement('div');
  mountApp(root);
  const pbody = root.querySelector('.inspector .pbody');
  assert.ok(pbody, 'a dataset is selected and its properties render');

  // section titles, in document order
  const titles = [...pbody.querySelectorAll('.istit')].map(text);
  assert.deepEqual(
    titles,
    ['plot as', 'lines / poles', 'color by', 'density / contours', 'mean / confidence', 'eigenvectors', 'tools', 'statistics'],
    'all sections present and ordered',
  );

  // Each section is one .psec wrapping its own title + labels. This is what was
  // broken: controls collapsed under a single header (multi-root-fragment bug).
  const buckets = {};
  for (const sec of pbody.querySelectorAll('.psec')) {
    const title = text(sec.querySelector('.istit'));
    buckets[title] = [...sec.querySelectorAll('label')].map(text);
  }
  assert.ok(buckets['density / contours']?.some((l) => l.startsWith('method')), 'method lives under density');
  assert.ok(buckets['density / contours']?.some((l) => l.startsWith('levels')), 'levels lives under density');
  assert.ok(buckets['mean / confidence']?.some((l) => l.includes('cone')), 'α95 cone lives under mean');
  assert.ok(buckets['eigenvectors']?.some((l) => l.startsWith('V1')), 'V1 row present under eigenvectors');
  assert.ok(buckets['eigenvectors']?.some((l) => l.startsWith('V3')), 'V3 row present under eigenvectors');
  // nothing from density should have leaked into eigenvectors
  assert.ok(!buckets['eigenvectors']?.some((l) => l.startsWith('method')), 'density control did not leak into eigenvectors');

  // sections are collapsible: clicking a title folds its psec
  const densSec = [...pbody.querySelectorAll('.psec')].find((s) => text(s.querySelector('.istit')) === 'density / contours');
  assert.ok(!densSec.classList.contains('collapsed'));
  densSec.querySelector('.istit').click();
  assert.ok(densSec.classList.contains('collapsed'), 'clicking a section title collapses it');

  // eigenvector + mean rows carry an orientation read-out (trend/plunge)
  const eigRows = [...pbody.querySelectorAll('.psec')].find((s) => text(s.querySelector('.istit')) === 'eigenvectors');
  const vReadouts = [...eigRows.querySelectorAll('label')].filter((l) => /^V\d/.test(text(l))).map((l) => text(l.querySelector('.ro')));
  assert.equal(vReadouts.length, 3, 'three eigenvector rows');
  assert.ok(vReadouts.every((r) => /^\d{3}\/\d{2}$/.test(r)), `each V has a trend/plunge read-out (got ${JSON.stringify(vReadouts)})`);
  const meanSec = [...pbody.querySelectorAll('.psec')].find((s) => text(s.querySelector('.istit')) === 'mean / confidence');
  const meanRows = [...meanSec.querySelectorAll('label')].map((l) => [text(l.querySelector('.fk')), text(l.querySelector('.ro'))]);
  assert.ok(meanRows.find(([k]) => k === 'mean vector')?.[1].match(/^\d{3}\/\d{2}$/), 'mean vector shows trend/plunge');
  assert.ok(meanRows.find(([k]) => k.includes('cone'))?.[1].endsWith('°'), 'α95 cone shows an opening angle');
});

// reactive effects re-run on a microtask, so flush after each interaction
const tick = () => new Promise((r) => setTimeout(r, 0));

test('CSV import: pasting a multi-column table reveals mapping + builds a coloured item', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  const n0 = project.items().length;
  root.querySelector('.add').click();                 // open the add form
  await tick();
  const ta = root.querySelector('.form .ta');
  assert.ok(ta, 'add form is shown');
  ta.value = 'dipdir,dip,set\n120,35,A\n130,40,B\n118,32,A';
  ta.dispatchEvent(new window.Event('input'));        // triggers column detection
  await tick();
  const selects = [...root.querySelectorAll('.mapping select')];
  assert.equal(selects.length, 3, 'azimuth / dip / color-by selects appear for a 3-column table');
  selects[2].value = '2'; selects[2].dispatchEvent(new window.Event('change'));  // colour by "set"
  root.querySelector('.form .go').click();            // add
  const item = project.items().at(-1);
  assert.equal(project.items().length, n0 + 1, 'one item added');
  assert.equal(item.measurements().length, 3, 'three measurements parsed');
  assert.equal(item.currentColumns().length, 3, 'columns carried onto the item');
  assert.equal(item.colorLegend()?.type, 'categorical', 'colour-by-set is categorical');
  assert.deepEqual(item.colorLegend().entries.map(([v]) => v), ['A', 'B']);

  await tick();  // the new item is auto-selected → inspector rebuilds
  const titles = [...root.querySelectorAll('.inspector .psec .istit')].map((e) => (e.textContent || '').trim());
  assert.ok(titles.includes('color by'), 'inspector shows a color-by section for an item with columns');
  const legendCats = [...root.querySelectorAll('.netlegend .lgcat')].map((e) => (e.textContent || '').trim());
  assert.ok(legendCats.some((t) => t.startsWith('A')) && legendCats.some((t) => t.startsWith('B')), 'net legend lists the classes');

  // categorical → editable class table (one row per class, editing sets catColors)
  const classRows = [...root.querySelectorAll('.classtable .classrow')];
  assert.equal(classRows.length, 2, 'a class row per distinct value (A, B)');
  const sw = classRows[0].querySelector('input[type="color"]');
  assert.ok(sw, 'each class has an editable colour');
  sw.value = '#123456'; sw.dispatchEvent(new window.Event('change'));
  assert.ok(item.currentStyle().catColors && Object.values(item.currentStyle().catColors).includes('#123456'), 'editing a class swatch sets catColors');

  // ramp mode → preview bar + clamp inputs (symmetric to the class table)
  item.setStyle({ ...item.currentStyle(), colorMode: 'ramp', colorBy: 1 });   // ramp by dip
  await tick();
  assert.ok(root.querySelector('.ramptable .rampbar'), 'ramp preview bar shown');
  const clampInputs = [...root.querySelectorAll('.ramptable input[type="number"]')];
  assert.equal(clampInputs.length, 2, 'min/max clamp inputs');
  clampInputs[0].value = '10'; clampInputs[0].dispatchEvent(new window.Event('change'));
  assert.equal(item.currentStyle().rampMin, 10, 'clamping sets rampMin');
});

test('empty state appears with no data and loads a sample; samples strip is persistent', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  const empty = root.querySelector('.emptystate');
  assert.ok(empty, 'empty-state element exists');
  // clear the seed → empty state shows + offers samples
  [...project.nodes()].forEach((n) => project.remove(n));
  await tick();
  assert.notEqual(empty.style.display, 'none', 'empty state shown when no data');
  assert.ok(root.querySelectorAll('.es-samples .btn').length >= 3, 'sample buttons offered');

  root.querySelector('.es-samples .btn').click();           // load the first sample
  await tick();
  assert.ok(project.items().length > 0, 'a sample loaded data');
  assert.equal(empty.style.display, 'none', 'empty state hidden once data exists');
  // persistent samples strip still reachable
  assert.ok(root.querySelectorAll('.samplesrow .slink').length >= 3);
});

test('annotations: add a note → annotation item, overlay layer, inspector editor', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  [...root.querySelectorAll('.sect .sectbtn')].find((b) => /annotation/i.test(b.title)).click();
  await tick();
  const note = project.items().at(-1);
  assert.equal(note.type, 'annotation');
  assert.ok(root.querySelector('.annolayer'), 'annotation overlay present');   // labels need real layout (verified in-browser)
  note.setStyle({ ...note.currentStyle(), text: 'fold axis here' });
  await tick();
  assert.match((root.querySelector('.inspector').textContent || '').toLowerCase(), /annotation/, 'inspector shows the annotation editor');
  // switching the anchor space converts the stored coords (round-trips through place/locate)
  assert.equal(note.currentStyle().anchorSpace || 'attitude', 'attitude');
});

test('undo / redo restores project state after a change', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  const undoBtn = [...root.querySelectorAll('.topbar button')].find((b) => b.title && /undo/i.test(b.title));
  const redoBtn = [...root.querySelectorAll('.topbar button')].find((b) => b.title && /redo/i.test(b.title));
  assert.ok(undoBtn && redoBtn, 'undo/redo controls present');

  const item = project.items()[0];
  const n0 = item.measurements().length;
  item.setMeasurements([...item.measurements(), [42, 42]]);   // a change
  await new Promise((r) => setTimeout(r, 400));               // let the debounced snapshot land
  assert.equal(project.items()[0].measurements().length, n0 + 1);

  undoBtn.click();
  assert.equal(project.items()[0].measurements().length, n0, 'undo reverts the added measurement');
  redoBtn.click();
  assert.equal(project.items()[0].measurements().length, n0 + 1, 'redo re-applies it');
});

test('net interaction: select is default; measure mode drags an angle + builds a plane', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const net = handle.net;
  assert.equal(net.mode, 'select', 'select is the default mode (non-destructive)');
  net.setMode('measure');

  // simulate a press-drag (A then B); the pointer plumbing sets net._measure
  const a = bearingDir(0, 0), b = bearingDir(90, 0);    // N-horizontal and E-horizontal lines
  net._measure = { a, b };
  net.onMeasure(net.measure());
  await tick();
  const m = net.measure();
  assert.ok(Math.abs(m.angle - 90) < 1, `angle ≈ 90° (got ${m.angle})`);
  assert.ok(root.querySelector('.measurebar .mini'), 'construct buttons appear in the status bar');

  // ＋plane builds the common great circle (pole = a×b → vertical N–S plane)
  const n0 = handle.project.items().length;
  [...root.querySelectorAll('.measurebar .mini')].find((x) => /plane/.test(x.textContent)).click();
  assert.equal(handle.project.items().length, n0 + 1);
  assert.equal(handle.project.items().at(-1).type, 'planes');
});

test('net select mode: onSelect resolves a layer id, null deselects', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const net = handle.net;
  const it = handle.project.items()[0];
  assert.ok(it, 'seeded with at least one layer');
  net.onSelect(it.id); await tick();
  assert.ok([...root.querySelectorAll('.it.sel')].length >= 1, 'selecting an id marks a tree row selected');
  net.onSelect(null); await tick();
  assert.equal(root.querySelectorAll('.it.sel').length, 0, 'null deselects');
});

test('floating table: the float button opens a table panel on the selected layer', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const it = handle.project.items().find((x) => x.type !== 'annotation');
  assert.ok(it, 'seeded with a tabular layer');
  handle.net.onSelect(it.id); await tick();              // select it so the data tab shows its table
  [...root.querySelectorAll('.tab')].find((t) => /table/i.test(t.textContent)).click(); await tick();
  const floatBtn = root.querySelector('[title="float this table over the plot"]');
  assert.ok(floatBtn, 'float button present in the data table');
  floatBtn.click(); await tick();
  assert.equal(it.currentParams().tableOpen, true, 'the layer table is now flagged to float');
});

test('linked identify: clicking near a datum flashes its table row', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const it = handle.project.items().find((x) => x.type === 'poles' || x.type === 'lines');
  assert.ok(it && it.measurements().length, 'seeded with a point-like layer');
  handle.net.onSelect(it.id); await tick();              // its table renders in the (hidden) table tab
  handle.net.onIdentify(it.dcos()[0], it.id);            // identify by the first datum's own direction
  const flashed = root.querySelector(`.dtable[data-item="${it.id}"] [data-row="0"].flash`);
  assert.ok(flashed, 'the matching row is flashed');
  // a direction far from every datum identifies nothing
  handle.net.onIdentify([1, 0, 0], it.id);               // horizontal N — far from the steep poles
  // (no assertion on absence beyond not throwing; nearestDatum returns -1)
});

test('table columns: add then delete a data column (× in edit mode)', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const item = handle.project.items().find((x) => x.type === 'planes' || x.type === 'poles');
  handle.net.onSelect(item.id); await tick();
  [...root.querySelectorAll('.tabs .tab')].find((t) => /table/i.test(t.textContent)).click(); await tick();
  [...root.querySelectorAll('.thead-row .btn')].find((b) => /edit/i.test(b.textContent)).click(); await tick();
  const c0 = item.currentColumns().length;
  [...root.querySelectorAll('.thead-actions .mini')].find((b) => /col/i.test(b.textContent)).click(); await tick();
  assert.equal(item.currentColumns().length, c0 + 1, '+ col appends a data column');
  root.querySelector('.dtable .thdel').click(); await tick();
  assert.equal(item.currentColumns().length, c0, 'the × deletes that column');
});

test('context menu: right-click a layer row → Remove deletes it', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const n0 = handle.project.items().length;
  const row = root.querySelector('.it:not(.grp-row)');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await tick();
  const menu = document.querySelector('.ctxmenu');
  assert.ok(menu, 'a context menu opens');
  const remove = [...menu.querySelectorAll('.ctx-item')].find((b) => /remove/i.test(b.textContent));
  assert.ok(remove, 'Remove action present');
  remove.click(); await tick();
  assert.equal(handle.project.items().length, n0 - 1, 'Remove deletes the layer');
  assert.ok(!document.querySelector('.ctxmenu'), 'menu closes after an action');
});

test('context menu: plot offers copy-attitude + add-annotation-here', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  handle.net.onContextMenu({ clientX: 5, clientY: 5, dcos: [0, 1, 0], id: null });   // N horizontal
  await tick();
  const menu = document.querySelector('.ctxmenu');
  assert.ok([...menu.querySelectorAll('.ctx-item')].some((b) => /copy attitude/i.test(b.textContent)), 'copy-attitude submenu present');
  const n0 = handle.project.items().length;
  [...menu.querySelectorAll('.ctx-item')].find((b) => /add annotation/i.test(b.textContent)).click();
  await tick();
  assert.equal(handle.project.items().length, n0 + 1, 'add annotation here creates a note');
  assert.equal(handle.project.items().at(-1).type, 'annotation');
});

test('vendored sideact h: multi-root + adjacent interpolations keep order (binding-order fix)', async () => {
  const { h } = await import('../vendor/sideact/dom.js');
  const a = document.createElement('i'); a.textContent = 'A';
  const multi = h`<i>B1</i><i>B2</i>`;                 // a multi-root fragment
  const c = document.createElement('i'); c.textContent = 'C';
  const root = h`<div>${a}${multi}${c}</div>`;          // followed by another binding
  assert.equal([...root.querySelectorAll('i')].map((e) => e.textContent).join(','), 'A,B1,B2,C',
    'fragment expands in place without clobbering the following binding');
});

test('viewport: zoomAt scales (clamped), panBy translates, reset clears', () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const net = handle.net;
  net.zoomAt(2, 100, 100);
  assert.equal(net.viewport.scale, 2, 'zoom in scales the viewport');
  net.panBy(15, -5);
  assert.ok(net.viewport.tx !== 0 || net.viewport.ty !== 0, 'pan translates');
  net.zoomAt(100, 0, 0);
  assert.equal(net.viewport.scale, 8, 'zoom is clamped to 8×');
  net.resetViewport();
  assert.deepEqual([net.viewport.tx, net.viewport.ty, net.viewport.scale], [0, 0, 1], 'reset clears the viewport');
});

test('composed export: builds a self-contained SVG with the overlay baked in', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const { svg, w, h } = handle.composeFigureSVG();
  assert.match(svg, /^<svg[\s>]/, 'is an SVG');
  assert.ok(/<foreignObject/.test(svg), 'wraps the HTML overlay in a foreignObject');
  assert.ok(/<style>/.test(svg), 'inlines the stylesheet so it renders standalone');
  assert.ok(/--ink\s*:/.test(svg), 'inlines the theme variables');
  assert.ok(w >= 1 && h >= 1, 'has positive dimensions');
  // native SVG: real primitives, no foreignObject
  const nat = handle.nativeFigure();
  assert.match(nat.svg, /^<svg[\s>]/, 'native is an SVG');
  assert.ok(!/foreignObject/.test(nat.svg), 'native export uses no foreignObject');
});

test('footer zoom control: reflects the viewport and the % resets to 100%', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  handle.net.zoomAt(2, 50, 50); await tick();
  const pct = root.querySelector('.zoomctl .zpct');
  assert.ok(pct, 'zoom control in the footer');
  assert.match(pct.textContent, /200\s*%/, 'shows the current zoom');
  pct.click(); await tick();
  assert.equal(handle.net.viewport.scale, 1, 'clicking the % resets to 100%');
});

test('selection: select data then extract → new layer(s), and clears', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const before = handle.project.items().length;
  handle.commitSelection(() => true, false);             // select every (lower-hemisphere) datum
  let n = 0; for (const s of handle.selection().values()) n += s.size;
  assert.ok(n > 0, 'select-all picks up data');
  handle.extractSelection();
  assert.ok(handle.project.items().length > before, 'extract adds layer(s)');
  let after = 0; for (const s of handle.selection().values()) after += s.size;
  assert.equal(after, 0, 'extract clears the selection');
});

test('tag-to-set: tagging the selection writes a categorical "set" column + colour-by', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const it = handle.project.items().find((x) => x.type === 'poles' || x.type === 'planes');
  // select all of one layer, then tag
  handle.commitSelection(() => true);
  handle.tagSelection('A');
  const col = it.currentColumns().find((c) => c.name === 'set');
  assert.ok(col, 'a "set" column was created');
  assert.ok(col.values.some((v) => v === 'A'), 'selected rows tagged "A"');
  assert.equal(it.currentStyle().colorMode, 'categorical', 'item now colours categorically');
});

test('preview mode: the toggle adds/removes body.preview', async () => {
  const root = document.createElement('div');
  mountApp(root);
  const btn = [...root.querySelectorAll('button')].find((b) => /preview/i.test(b.getAttribute('title') || ''));
  assert.ok(btn, 'preview toggle present');
  btn.click(); await tick();
  assert.ok(document.body.classList.contains('preview'), 'preview class on');
  btn.click(); await tick();
  assert.ok(!document.body.classList.contains('preview'), 'preview class off');
});

test('inline rename: double-click a layer name edits it in place (no browser dialog)', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const item = handle.project.items()[0];
  const nm = root.querySelector(`.it[data-node="${item.id}"] .nm`);
  assert.ok(nm, 'name span found');
  nm.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  assert.ok(nm.classList.contains('editing'), 'name becomes editable in place');
  nm.textContent = 'renamed';
  nm.dispatchEvent(new window.FocusEvent('blur'));
  await tick();
  assert.equal(item.currentName(), 'renamed', 'blur commits the new name');
});

test('add title: ＋ title creates a prominent figure-space text annotation', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const n0 = handle.project.items().length;
  [...root.querySelectorAll('.sectbtn')].find((b) => /title/i.test(b.textContent)).click();
  await tick();
  assert.equal(handle.project.items().length, n0 + 1, 'a layer is added');
  const t = handle.project.items().at(-1);
  assert.equal(t.type, 'annotation');
  assert.equal(t.currentStyle().bold, true, 'bold');
  assert.ok((t.currentStyle().fontSize || 0) >= 20, 'large font');
  assert.equal(t.currentStyle().anchorSpace, 'figure', 'figure-anchored (fixed under rotation)');
});

test('context menu: plot Legend toggle flips project.legendShow', async () => {
  const root = document.createElement('div');
  const handle = mountApp(root);
  const before = handle.project.legendShow();
  handle.net.onContextMenu({ clientX: 5, clientY: 5, dcos: null, id: null });
  await tick();
  [...document.querySelector('.ctxmenu').querySelectorAll('.ctx-item')].find((b) => /legend/i.test(b.textContent)).click();
  await tick();
  assert.equal(handle.project.legendShow(), !before, 'Legend item toggles the project setting');
});

test('context menu component: checkmarks render, submenu opens on hover, action closes all', async () => {
  const { openMenu, closeMenu } = await import('../src/ui/contextmenu.js');
  let fired = false;
  openMenu(10, 10, [
    { label: 'Toggle', checked: true, onClick: () => {} },
    { label: 'More', submenu: [{ label: 'Deep', onClick: () => { fired = true; } }] },
  ]);
  const menu = document.querySelector('.ctxmenu');
  assert.ok(menu.classList.contains('has-toggles'), 'toggle gutter reserved');
  assert.equal(menu.querySelector('.ctx-check').textContent, '✓', 'checked item shows a ✓');
  [...menu.querySelectorAll('.ctx-item')].find((b) => /more/i.test(b.textContent))
    .dispatchEvent(new window.MouseEvent('mouseenter'));
  await tick();
  assert.equal(document.querySelectorAll('.ctxmenu').length, 2, 'submenu opened alongside root');
  [...document.querySelectorAll('.ctx-item')].find((b) => /deep/i.test(b.textContent)).click();
  await tick();
  assert.ok(fired, 'submenu action fired');
  assert.equal(document.querySelectorAll('.ctxmenu').length, 0, 'all menus closed after an action');
  closeMenu();
});

function bearingDir(trend, plunge) {                    // local trend/plunge → dcos (avoids extra imports)
  const t = trend * Math.PI / 180, p = plunge * Math.PI / 180;
  return [Math.cos(p) * Math.sin(t), Math.cos(p) * Math.cos(t), -Math.sin(p)];
}

test('import conventions: strike→dip-direction for planes, rake→trend/plunge for lines', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  const seg = (label) => [...root.querySelectorAll('.formopts .seg')].find((b) => new RegExp(label, 'i').test(b.textContent));

  // planes, azimuth entered as strike (RHR) → stored as dip direction (+90)
  root.querySelector('.add').click(); await tick();
  seg('strike').click();
  const ta = root.querySelector('.form .ta');
  ta.value = '30 60\n40 50'; ta.dispatchEvent(new window.Event('input')); await tick();
  root.querySelector('.form .go').click();
  assert.deepEqual(project.items().at(-1).currentMeasurements(), [[120, 60], [130, 50]]);
  await tick();   // let the form collapse back to the + button

  // lines entered as rake on a plane → converted to trend/plunge (2-tuples, finite)
  root.querySelector('.add').click(); await tick();
  const typeSel = root.querySelector('.form select');
  typeSel.value = 'lines'; typeSel.dispatchEvent(new window.Event('change')); await tick();
  seg('rake').click(); await tick();
  assert.equal(root.querySelectorAll('.mapping select').length, 0, 'rake is positional → no column mapping');
  const ta2 = root.querySelector('.form .ta');
  ta2.value = '90 60 0\n120 45 90'; ta2.dispatchEvent(new window.Event('input')); await tick();
  root.querySelector('.form .go').click();
  const lines = project.items().at(-1);
  assert.equal(lines.type, 'lines');
  assert.equal(lines.currentMeasurements().length, 2);
  assert.ok(lines.currentMeasurements().every((m) => m.length === 2 && m.every(Number.isFinite)));
});

test('small circles: add via the form (t/p/aperture) and the table shows 3 geometry columns', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  root.querySelector('.add').click(); await tick();
  const typeSel = root.querySelector('.form select');
  typeSel.value = 'smallcircle'; typeSel.dispatchEvent(new window.Event('change'));
  const ta = root.querySelector('.form .ta');
  ta.value = '120 40 25\n300 10 15'; ta.dispatchEvent(new window.Event('input'));
  await tick();
  assert.equal(root.querySelectorAll('.mapping select').length, 0, 'no az/dip mapping for small circles (positional triples)');
  root.querySelector('.form .go').click();
  const item = project.items().at(-1);
  assert.equal(item.type, 'smallcircle');
  assert.deepEqual(item.currentMeasurements(), [[120, 40, 25], [300, 10, 15]]);

  // its contribution draws cones; the table header has trend/plunge/aperture
  assert.ok(item.contribute('net').some((p) => p.kind === 'smallCircle'));
  [...root.querySelectorAll('.tabs .tab')].find((t) => /table/i.test(t.textContent)).click();
  await tick();
  const headers = [...root.querySelectorAll('.dtable .th')].map((e) => (e.textContent || '').trim());
  assert.ok(headers.includes('trend') && headers.includes('plunge') && headers.includes('aperture'), `3 geometry columns (got ${headers.join(',')})`);
});

test('faults: add via the form; paleostress is gated + flagged experimental in the inspector', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  root.querySelector('.add').click(); await tick();
  const typeSel = root.querySelector('.form select');
  typeSel.value = 'fault'; typeSel.dispatchEvent(new window.Event('change'));
  const ta = root.querySelector('.form .ta');
  ta.value = '120 60 80 n\n300 45 30 i\n90 70 90 n\n200 55 60 i';
  ta.dispatchEvent(new window.Event('input')); await tick();
  root.querySelector('.form .go').click();
  const f = project.items().at(-1);
  assert.equal(f.type, 'fault');
  assert.equal(f.currentMeasurements().length, 4);

  // selected → inspector mentions the experimental paleostress caveat
  await tick();
  assert.match((root.querySelector('.inspector').textContent || '').toLowerCase(), /experimental|unvalidated/);

  // paleostress σ axes appear only once the layer is enabled
  assert.ok(!f.contribute('net').some((p) => p.source.stress != null));
  f.toggleLayer('michael');
  assert.equal(f.contribute('net').filter((p) => p.source.stress != null).length, 3);
});

test('groups: a group nests items in the tree and gates their visibility', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  const legendCount = () => root.querySelectorAll('.netlegend .lgitem').length;
  const n0 = legendCount();
  assert.ok(n0 >= 2, 'legend lists the seed datasets');

  [...root.querySelectorAll('.sect .sectbtn')].find((b) => /group/i.test(b.title)).click();   // + group
  await tick();
  const groupRow = [...root.querySelectorAll('.grp-row')];
  assert.equal(groupRow.length, 1, 'a group row appears');

  // nest the first dataset under the group (drag-drop is wired in the UI; drive the model directly here)
  const g = project.nodes().find((n) => n.kind === 'group');
  project.move(project.items()[0], g, 0);
  await tick();
  assert.ok(root.querySelector('.grp-kids .it'), 'the item now renders nested under the group');

  // hiding the group removes its child from what the net draws
  g.setVisible(false);
  await tick();
  assert.equal(legendCount(), n0 - 1, 'hiding the group drops its nested layer from the legend');
  assert.equal(project.visibleLeaves().length, n0 - 1, 'and from contribute()');
});

test('table tab: shows the selected item and edits write through to the model', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  const item = project.items()[0];                    // bedding (8 planes)
  [...root.querySelectorAll('.tabs .tab')].find((t) => /table/i.test(t.textContent)).click();
  await tick();
  const rowCount = () => root.querySelectorAll('.dtable .td.rownum').length;  // one row-number cell per row
  assert.equal(rowCount(), item.measurements().length, 'a row per measurement');

  // enter edit mode → add a row
  const editBtn = [...root.querySelectorAll('.thead-row .btn')].find((b) => /edit/i.test(b.textContent));
  editBtn.click(); await tick();
  const n0 = item.measurements().length;
  [...root.querySelectorAll('.thead-actions .mini')].find((b) => /row/i.test(b.textContent)).click();
  await tick();
  assert.equal(item.measurements().length, n0 + 1, 'add row appends a measurement');

  // edit the first azimuth cell → model updates without a rebuild
  const firstInput = root.querySelector('.dtable input.tc');
  firstInput.value = '999'; firstInput.dispatchEvent(new window.Event('input'));
  assert.equal(item.currentMeasurements()[0][0], 999, 'cell edit writes through to measurements');

  // add a column
  [...root.querySelectorAll('.thead-actions .mini')].find((b) => /col/i.test(b.textContent)).click();
  await tick();
  assert.equal(item.currentColumns().length, 1, 'add column adds an aligned column');
  assert.equal(item.currentColumns()[0].values.length, item.measurements().length, 'new column aligned to rows');
});
