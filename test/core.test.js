import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlaneSet, PoleSet, LineSet } from '../src/core/model.js';
import { KINDS, greatCircle } from '../src/core/primitives.js';
import { parsePairs } from '../src/io/parse.js';

test('primitive vocabulary is closed and carries source', () => {
  const p = greatCircle([0, 0, -1], { color: '#f00' }, { item: 'a', datum: 2 });
  assert.equal(p.kind, 'greatCircle');
  assert.deepEqual(p.source, { item: 'a', datum: 2 });
  assert.equal(KINDS.length, 7);
});

test('PlaneSet contributes one great circle per plane to the net', () => {
  const ps = new PlaneSet({ measurements: [[120, 35], [130, 40]] });
  const prims = ps.contribute('net');
  assert.equal(prims.length, 2);
  assert.ok(prims.every((p) => p.kind === 'greatCircle'));
  assert.equal(prims[0].source.item, ps.id);
});

test('showPoles adds a point per plane', () => {
  const ps = new PlaneSet({ measurements: [[120, 35]], style: { showPoles: true } });
  const kinds = ps.contribute('net').map((p) => p.kind);
  assert.deepEqual(kinds, ['greatCircle', 'point']);
});

test('items contribute nothing to spaces they do not serve (v0)', () => {
  assert.equal(new PlaneSet({ measurements: [[1, 2]] }).contribute('rose').length, 0);
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

test('parsePairs is forgiving (space/comma/slash, comments)', () => {
  assert.deepEqual(parsePairs('120 35\n125,40\n118/32\n; comment\n  # x\nbad'), [[120, 35], [125, 40], [118, 32]]);
});
