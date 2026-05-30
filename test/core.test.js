import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlaneSet, PoleSet, LineSet } from '../src/core/model.js';
import { KINDS, greatCircle } from '../src/core/primitives.js';
import { parsePairs } from '../src/io/parse.js';

test('primitive vocabulary is closed and carries source', () => {
  const p = greatCircle([0, 0, -1], { color: '#f00' }, { item: 'a', datum: 2 });
  assert.equal(p.kind, 'greatCircle');
  assert.deepEqual(p.source, { item: 'a', datum: 2 });
  assert.equal(KINDS.length, 9);
});

test('PlaneSet defaults to great circles only (poles layer off)', () => {
  const ps = new PlaneSet({ measurements: [[120, 35], [130, 40]] });
  const prims = ps.contribute('net');
  assert.equal(prims.length, 2);
  assert.ok(prims.every((p) => p.kind === 'greatCircle'));
  assert.equal(prims[0].source.item, ps.id);
});

test('toggling the poles layer adds a point per plane', () => {
  const ps = new PlaneSet({ measurements: [[120, 35]] });
  assert.deepEqual(ps.contribute('net').map((p) => p.kind), ['greatCircle']);
  ps.toggleLayer('poles');
  assert.deepEqual(ps.contribute('net').map((p) => p.kind), ['greatCircle', 'point']);
});

test('contours / mean / eigenvectors layers emit the right primitives', () => {
  const ps = new PlaneSet({ measurements: [[120, 35], [125, 40], [118, 32], [130, 38]] });
  ps.toggleLayer('contours');
  assert.ok(ps.contribute('net').some((p) => p.kind === 'contour'));
  ps.toggleLayer('mean');
  assert.ok(ps.contribute('net').some((p) => p.source.mean));
  ps.toggleLayer('eigen');
  const kinds = ps.contribute('net').map((p) => p.kind);
  assert.ok(kinds.filter((k) => k === 'text').length === 3); // V1/V2/V3 labels
});

test('layer + visible snapshots are untracked reads', () => {
  const ps = new PoleSet({ measurements: [[210, 65]], visible: false });
  assert.equal(ps.currentVisible(), false);
  assert.equal(ps.currentLayers().points, true);
  ps.toggleLayer('points');
  assert.equal(ps.currentLayers().points, false);
});

test('items contribute nothing to an unknown space', () => {
  assert.equal(new PlaneSet({ measurements: [[1, 2]] }).contribute('nope').length, 0);
});

test('Project aggregates only visible items', () => {
  const proj = new Project();
  const a = proj.add(new PlaneSet({ measurements: [[120, 35]] }));
  const b = proj.add(new PoleSet({ measurements: [[210, 65]] }));
  b.setVisible(false);
  const prims = proj.contribute('net');
  assert.ok(prims.length > 0 && prims.every((p) => p.source.item === a.id));
});

test('reactive: toggling visibility / editing measurements changes output', () => {
  const ps = new LineSet({ measurements: [[30, 12], [40, 18]] });
  assert.equal(ps.contribute('net').length, 2);
  ps.setMeasurements([[30, 12]]);
  assert.equal(ps.contribute('net').length, 1);
});

test('stats come from the orientation tensor', () => {
  const ps = new PlaneSet({ measurements: [[120, 35], [125, 40], [118, 32], [130, 38]] });
  const s = ps.stats();
  assert.ok(s && s.eigenvalues.length === 3 && s.fisher.n === 4);
});

test('items contribute one rose descriptor with the right azimuths', () => {
  const planes = new PlaneSet({ measurements: [[120, 35], [130, 40]] });
  const rose = planes.contribute('rose');
  assert.equal(rose.length, 1);
  assert.equal(rose[0].kind, 'rose');
  assert.deepEqual(rose[0].azimuths, [30, 40]); // strike = dipdir − 90
  assert.equal(rose[0].axial, true);

  const lines = new LineSet({ measurements: [[300, 12], [310, 18]] });
  assert.deepEqual(lines.contribute('rose')[0].azimuths, [300, 310]); // trend
});

test('items contribute one fabric descriptor carrying dcos', () => {
  const ps = new PlaneSet({ measurements: [[120, 35], [125, 40], [118, 32]] });
  const fab = ps.contribute('fabric');
  assert.equal(fab.length, 1);
  assert.equal(fab[0].kind, 'fabric');
  assert.equal(fab[0].dcos.length, 3);
  assert.equal(fab[0].label, ps.name());
});

test('fabric needs ≥2 measurements', () => {
  assert.equal(new PoleSet({ measurements: [[210, 65]] }).contribute('fabric').length, 0);
});

test('Project aggregates each space across visible items', () => {
  const proj = new Project();
  proj.add(new PlaneSet({ measurements: [[120, 35], [125, 40]] }));
  proj.add(new LineSet({ measurements: [[300, 12], [310, 18]] }));
  assert.equal(proj.contribute('rose').length, 2);   // one per item
  assert.equal(proj.contribute('fabric').length, 2);
  assert.ok(proj.contribute('net').length >= 4);      // 2 great circles + 2 points
});

test('single colour mode: every primitive uses the item colour', () => {
  const ps = new PoleSet({ measurements: [[210, 65], [220, 60]], style: { color: '#abcdef' } });
  const prims = ps.contribute('net');
  assert.ok(prims.every((p) => p.style.color === '#abcdef'));
  assert.equal(ps.colorLegend(), null);
});

test('categorical colour-by: distinct classes get distinct per-datum colours', () => {
  const ps = new PoleSet({
    measurements: [[210, 65], [220, 60], [200, 70]],
    columns: [{ name: 'set', values: ['A', 'B', 'A'] }],
    style: { color: '#888', colorMode: 'categorical', colorBy: 0 },
  });
  const pts = ps.contribute('net').filter((p) => p.kind === 'point');
  assert.equal(pts[0].style.color, pts[2].style.color, 'same class → same colour');
  assert.notEqual(pts[0].style.color, pts[1].style.color, 'different class → different colour');
  const legend = ps.colorLegend();
  assert.equal(legend.type, 'categorical');
  assert.deepEqual(legend.entries.map(([v]) => v), ['A', 'B']);
});

test('ramp colour-by: numeric column drives colour + legend range', () => {
  const ps = new PoleSet({
    measurements: [[210, 65], [220, 60], [200, 70]],
    columns: [{ name: 'conf', values: ['0', '0.5', '1'] }],
    style: { colorMode: 'ramp', colorBy: 0, colorRamp: 'viridis' },
  });
  const pts = ps.contribute('net').filter((p) => p.kind === 'point');
  assert.ok(/^rgb\(/.test(pts[0].style.color) && pts[0].style.color !== pts[2].style.color);
  const legend = ps.colorLegend();
  assert.deepEqual([legend.type, legend.min, legend.max], ['ramp', 0, 1]);
});

test('parsePairs is forgiving (space/comma/slash, comments)', () => {
  assert.deepEqual(parsePairs('120 35\n125,40\n118/32\n; comment\n  # x\nbad'), [[120, 35], [125, 40], [118, 32]]);
});
