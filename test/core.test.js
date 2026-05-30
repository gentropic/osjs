import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlaneSet, PoleSet, LineSet, SmallCircleSet, FaultSet, Group, isGroup, serializeProject, loadProject, rotateItem, mergeItems, differenceVectors } from '../src/core/model.js';
import { KINDS, greatCircle } from '../src/core/primitives.js';
import { parsePairs, parseTriples, parseFaults, parseTable, guessRoles, buildFromTable } from '../src/io/parse.js';

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

test('small circles contribute an axis point + a cone per datum (aperture as angle)', () => {
  const sc = new SmallCircleSet({ measurements: [[120, 40, 25], [300, 10, 15]] });
  const prims = sc.contribute('net');
  const axes = prims.filter((p) => p.kind === 'point');
  const cones = prims.filter((p) => p.kind === 'smallCircle');
  assert.equal(axes.length, 2);
  assert.equal(cones.length, 2);
  assert.deepEqual(cones.map((c) => c.angle), [25, 15]);   // aperture drives the cone half-angle
  sc.toggleLayer('axes');                                    // turn axes off
  assert.equal(sc.contribute('net').filter((p) => p.kind === 'point').length, 0);
  assert.equal(SmallCircleSet.GEOM.length, 3);              // trend / plunge / aperture
});

test('parseTriples reads trend/plunge/aperture rows', () => {
  assert.deepEqual(parseTriples('120 40 25\n300,10,15\n# c\nbad 1'), [[120, 40, 25], [300, 10, 15]]);
});

test('data tools: rotate / merge / difference vectors produce new payloads', () => {
  const lines = new LineSet({ name: 'L', measurements: [[0, 0], [90, 0]] });   // two horizontal lines N and E
  // rotate about vertical (plunge 90) by 90° → trends advance by 90°, still horizontal
  const rot = rotateItem(lines, 0, 90, 90);
  assert.equal(rot.type, 'lines');
  assert.equal(rot.measurements.length, 2);
  assert.ok(rot.measurements.every(([, p]) => Math.abs(p) < 0.5));            // stays horizontal
  const trends = rot.measurements.map(([t]) => ((Math.round(t) % 360) + 360) % 360).sort((a, b) => a - b);
  assert.deepEqual(trends, [90, 180]);                                        // N→E, E→S

  const a = new PoleSet({ name: 'A', measurements: [[10, 20]] });
  const b = new PoleSet({ name: 'B', measurements: [[30, 40], [50, 60]] });
  assert.deepEqual(mergeItems(a, b).measurements, [[10, 20], [30, 40], [50, 60]]);

  const diff = differenceVectors(new LineSet({ measurements: [[0, 0], [90, 0], [45, 10]] }));
  assert.equal(diff.type, 'lines');
  assert.equal(diff.measurements.length, 3);                                  // C(3,2) pairs
});

test('parseFaults reads dd/dip/rake/sense (letter or numeric sense)', () => {
  assert.deepEqual(parseFaults('120 60 80 n\n300 45 30 d\n90 70 90 1\n60 50 45'),
    [[120, 60, 80, 2], [300, 45, 30, 3], [90, 70, 90, 1], [60, 50, 45, 0]]);   // n→2, d→3, 1→1, missing→0
});

test('faults: planes + slickenlines + P/T axes; paleostress gated to layer + ≥4 faults', () => {
  const f = new FaultSet({ measurements: [[120, 60, 80, 2], [300, 45, 30, 1], [90, 70, 90, 2], [200, 55, 60, 1]] });
  const base = f.contribute('net');
  assert.equal(base.filter((p) => p.kind === 'greatCircle').length, 4);   // fault planes
  assert.equal(base.filter((p) => p.source.slip).length, 4);              // slickenlines
  assert.ok(!base.some((p) => p.source.stress != null), 'paleostress off by default');

  f.toggleLayer('pt');
  const pt = f.contribute('net').filter((p) => p.source.axis);
  assert.equal(pt.length, 8);                                             // P + T per fault

  f.toggleLayer('michael');
  const sigma = f.contribute('net').filter((p) => p.source.stress != null);
  assert.equal(sigma.length, 3);                                          // σ1 σ2 σ3
  // fewer than 4 defined faults → no inversion
  const few = new FaultSet({ measurements: [[120, 60, 80, 2]] }); few.toggleLayer('michael');
  assert.equal(few.contribute('net').filter((p) => p.source.stress != null).length, 0);
});

test('groups: move into a group, parentOf, and visibility cascade', () => {
  const p = new Project();
  const a = p.add(new PlaneSet({ name: 'a', measurements: [[120, 35]] }));
  const b = p.add(new PoleSet({ name: 'b', measurements: [[210, 65]] }));
  const g = p.addGroup('folder');
  p.move(a, g, 0);                               // nest a inside g
  assert.equal(p.parentOf(a), g);
  assert.equal(p.parentOf(b), null);             // b still at root
  assert.deepEqual(p.items().map((i) => i.name()), ['b', 'a']); // leaves DFS (b at root, a in g)

  // hiding the group prunes its subtree from contribute, but items() still lists it
  g.setVisible(false);
  assert.deepEqual(p.visibleLeaves().map((i) => i.name()), ['b']);
  assert.equal(p.items().length, 2);
  g.setVisible(true);
  assert.equal(p.visibleLeaves().length, 2);
});

test('groups: move guards against cycles (a group cannot go inside its own child)', () => {
  const p = new Project();
  const outer = p.addGroup('outer');
  const inner = p.addGroup('inner');
  p.move(inner, outer, 0);
  p.move(outer, inner, 0);                        // illegal — would create a cycle
  assert.equal(p.parentOf(outer), null);         // unchanged
  assert.equal(p.parentOf(inner), outer);
});

test('nested groups round-trip through serialize → load', () => {
  const p = new Project();
  const g = p.addGroup('structures');
  const a = p.add(new PlaneSet({ name: 'bedding', measurements: [[120, 35], [130, 40]] }));
  p.move(a, g, 0);
  g.setVisible(false);
  const json = JSON.parse(JSON.stringify(serializeProject(p)));
  assert.equal(json.items[0].kind, 'group');

  const q = new Project();
  loadProject(q, json);
  const [grp] = q.nodes();
  assert.ok(isGroup(grp) && grp instanceof Group);
  assert.equal(grp.currentName(), 'structures');
  assert.equal(grp.currentVisible(), false);
  assert.equal(grp.currentChildren()[0].name(), 'bedding');
  assert.equal(q.visibleLeaves().length, 0);     // hidden group → nothing contributes
});

test('project round-trips through serialize → load (geometry, style, columns, layers, params)', () => {
  const a = new Project();
  const ps = a.add(new PlaneSet({ name: 'bedding', measurements: [[120, 35], [130, 40]], style: { color: '#abc123', opacity: 0.5 } }));
  ps.toggleLayer('poles'); ps.toggleLayer('contours'); ps.setParams({ cLevels: 6, cMethod: 'kamb', cRamp: 'magma' });
  a.add(new PoleSet({
    name: 'joints', measurements: [[210, 65], [220, 60]],
    columns: [{ name: 'set', values: ['A', 'B'] }], style: { colorMode: 'categorical', colorBy: 0 },
  }));
  a.setProjection('equal-angle'); a.setRoseBinWidth(15);
  a.setRoseScale('count'); a.setRosePetalStyle('kite'); a.setRoseMean(true);

  const json = JSON.parse(JSON.stringify(serializeProject(a)));   // prove it is JSON-able
  const b = new Project();
  loadProject(b, json);

  assert.equal(b.projection(), 'equal-angle');
  assert.equal(b.roseBinWidth(), 15);
  assert.deepEqual([b.roseScale(), b.rosePetalStyle(), b.roseMean()], ['count', 'kite', true]);
  assert.equal(b.items().length, 2);
  const [bed, jts] = b.items();
  assert.equal(bed.type, 'planes');
  assert.deepEqual(bed.currentMeasurements(), [[120, 35], [130, 40]]);
  assert.equal(bed.currentStyle().color, '#abc123');
  assert.equal(bed.currentLayers().poles, true);
  assert.equal(bed.currentLayers().contours, true);
  assert.equal(bed.currentParams().cLevels, 6);
  assert.equal(bed.currentParams().cMethod, 'kamb');
  assert.equal(bed.currentParams().cRamp, 'magma');
  assert.equal(jts.colorLegend().type, 'categorical');   // colour-by survives
  assert.deepEqual(jts.currentColumns()[0].values, ['A', 'B']);
});

test('loadProject rejects a non-project object', () => {
  assert.throws(() => loadProject(new Project(), { hello: 'world' }), /not an OSJS project/);
});

test('parsePairs is forgiving (space/comma/slash, comments)', () => {
  assert.deepEqual(parsePairs('120 35\n125,40\n118/32\n; comment\n  # x\nbad'), [[120, 35], [125, 40], [118, 32]]);
});

test('parseTable detects header + delimiter and yields aligned columns', () => {
  const t = parseTable('dipdir,dip,set\n120,35,A\n130,40,B');
  assert.deepEqual(t.columns.map((c) => c.name), ['dipdir', 'dip', 'set']);
  assert.deepEqual(t.columns[2].values, ['A', 'B']);
  assert.equal(t.rows.length, 2);
  // headerless whitespace table → synthesized names
  assert.deepEqual(parseTable('120 35\n130 40').columns.map((c) => c.name), ['col1', 'col2']);
});

test('guessRoles + buildFromTable map columns and keep alignment', () => {
  const t = parseTable('strike\tdip\tconf\n120\t35\t0.8\n130\tbad\t0.6\n140\t50\t0.9');
  const roles = guessRoles(t.columns);
  assert.deepEqual(roles, { azIdx: 0, dipIdx: 1 });
  const built = buildFromTable(t, roles);
  assert.deepEqual(built.measurements, [[120, 35], [140, 50]]);   // bad-dip row dropped
  assert.deepEqual(built.columns[2].values, ['0.8', '0.9']);       // conf stays aligned
});
