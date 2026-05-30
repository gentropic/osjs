import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseOpenStereo } from '../src/io/openstereo.js';
import { unzip } from '../src/io/zip.js';
import { Project, loadProject } from '../src/core/model.js';

// a hand-built unzipped .openstereo (filename → text)
const files = {
  'project_data.json': JSON.stringify({
    global_settings: { general_settings: { projection: 'Equal-Angle' } },
    items: [
      { name: 'structures', checked: true, items: [
        { name: 'bedding', path: 'example_data\\bedding.txt', checked: true, layer_settings_file: 'bedding.os_lyr',
          checked_plots: { Poles: true, 'Great Circles': true, Contours: false, Eigenvectors: false },
          kwargs: { line: false, dip_direction: true, dipdir_column: 0, dip_column: 1 } },
      ] },
      // strike-convention plane (dip_direction false → +90)
      { name: 'joints', path: 'joints.txt', checked: true, layer_settings_file: 'joints.os_lyr',
        checked_plots: { Poles: true, 'Great Circles': false }, kwargs: { line: false, dip_direction: false, dipdir_column: 0, dip_column: 1 } },
      // synthetic single-datum item (attitude from the name)
      { name: 'Small Circle (300 60 70)', path: null, layer_settings_file: 'sc.os_lyr', checked: true, checked_plots: {}, kwargs: null },
      // relational fault → skipped
      { name: 'Faults ((P)x,(L)y)', path: null, layer_settings_file: 'f.os_lyr', checked: true, checked_plots: { Michael: true }, kwargs: null },
    ],
  }),
  'bedding.txt': 'dip direction,dip\n120,35\n130,40',   // loose sibling; path above has a dir → resolved by basename
  'joints.txt': '30 80\n40 70',            // strikes → become 120/40, 130/70 as dip-dir
  'bedding.os_lyr': JSON.stringify({ plane_data: { point_settings: { c: '#0000ff', ms: 3 }, GC_settings: { colors: '#4d4d4d', linewidths: 0.8 }, check_settings: { v3point: true, v3GC: true } } }),
  'joints.os_lyr': JSON.stringify({ plane_data: { GC_settings: { colors: '#aa0000', linewidths: 1 }, point_settings: { c: '#00ff00', ms: 4 } } }),
  'sc.os_lyr': JSON.stringify({ singlesc_data: { scaxis_settings: { c: '#123456', ms: 5 } } }),
  'f.os_lyr': JSON.stringify({ fault_data: {} }),
};

test('parseOpenStereo maps groups, planes (incl strike), single-datum, and skips faults', () => {
  const data = parseOpenStereo(files);
  assert.equal(data.projection, 'equal-angle');
  assert.equal(data.items.length, 3);                      // group, joints, small circle (fault skipped)
  assert.ok(data.skipped.some((s) => /Faults/.test(s)));

  const [grp, joints, sc] = data.items;
  assert.equal(grp.kind, 'group');
  const bedding = grp.children[0];
  assert.equal(bedding.type, 'planes');
  assert.deepEqual(bedding.measurements, [[120, 35], [130, 40]]);
  assert.equal(bedding.style.color, '#4d4d4d');            // great-circle colour preferred for planes
  assert.equal(bedding.layers.eigen, true);                // v3 toggles → eigen layer on
  assert.deepEqual(bedding.params.eigPlane, [false, false, true]);

  assert.deepEqual(joints.measurements, [[120, 80], [130, 70]]); // strike + 90 → dip direction
  assert.equal(sc.type, 'smallcircle');
  assert.deepEqual(sc.measurements, [[300, 60, 70]]);            // parsed from the name
});

test('the imported project loads into a Project', () => {
  const p = new Project();
  loadProject(p, parseOpenStereo(files));
  assert.equal(p.nodes().length, 3);
  assert.equal(p.items().length, 3);                       // bedding (nested) + joints + small circle
  assert.equal(p.items()[0].type, 'planes');
});

test('end-to-end: unzip + parse a real packed .openstereo through zip.js', async () => {
  const buf = await readFile(new URL('./fixtures/packed.openstereo', import.meta.url));
  const data = parseOpenStereo(await unzip(buf));           // exercises deflate via DecompressionStream
  const p = new Project();
  loadProject(p, data);
  const names = p.items().map((i) => i.name());
  assert.ok(names.includes('Tocher (planes)') && names.includes('Qplot (planes)'), `got ${names.join(', ')}`);
  const tocher = p.items().find((i) => i.name().startsWith('Tocher'));
  assert.equal(tocher.type, 'planes');
  assert.ok(tocher.measurements().length > 10, 'real data rows parsed');
  assert.ok(tocher.measurements().every(([dd, dip]) => Number.isFinite(dd) && Number.isFinite(dip)));
});
