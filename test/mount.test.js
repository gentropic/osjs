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
    ['plot as', 'lines / poles', 'density / contours', 'mean / confidence', 'eigenvectors', 'statistics'],
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
});

test('groups: a group nests items in the tree and gates their visibility', async () => {
  const root = document.createElement('div');
  const { project } = mountApp(root);
  const legendCount = () => root.querySelectorAll('.netlegend .lgitem').length;
  const n0 = legendCount();
  assert.ok(n0 >= 2, 'legend lists the seed datasets');

  root.querySelector('.sect .sectbtn').click();   // + group
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
  [...root.querySelectorAll('.ttoolbar .mini')].find((b) => /row/i.test(b.textContent)).click();
  await tick();
  assert.equal(item.measurements().length, n0 + 1, 'add row appends a measurement');

  // edit the first azimuth cell → model updates without a rebuild
  const firstInput = root.querySelector('.dtable input.tc');
  firstInput.value = '999'; firstInput.dispatchEvent(new window.Event('input'));
  assert.equal(item.currentMeasurements()[0][0], 999, 'cell edit writes through to measurements');

  // add a column
  [...root.querySelectorAll('.ttoolbar .mini')].find((b) => /column/i.test(b.textContent)).click();
  await tick();
  assert.equal(item.currentColumns().length, 1, 'add column adds an aligned column');
  assert.equal(item.currentColumns()[0].values.length, item.measurements().length, 'new column aligned to rows');
});
