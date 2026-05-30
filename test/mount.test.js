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
