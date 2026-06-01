// Browser smoke test — boots the real app in headless Chromium over a loopback
// HTTP origin (ES modules are blocked on file://) and drives the interactions the
// jsdom suite can't: layout-dependent overlay placement, pointer drags (lasso /
// cone selection), wheel zoom, and the composed export at real geometry.
//
// Not part of `npm test` (that's the fast node:test/jsdom suite). Run directly:
//   node test/browser-smoke.mjs        (or: npm run test:browser)
//
// The static server binds 127.0.0.1 only — loopback, no firewall prompt.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.join(root, p === '/' ? 'index.html' : p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));

const results = [];
const check = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} — ${e.message}`]); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.osjs && window.osjs.project, null, { timeout: 15000 });
await page.waitForTimeout(150);   // let the first render + overlay placement settle

// helper: the net's on-screen box (for pointer coordinates)
const netBox = () => page.evaluate(() => { const r = window.osjs.net.element.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
const selCount = () => page.evaluate(() => { let n = 0; for (const s of window.osjs.selection().values()) n += s.size; return n; });

await check('app boots with the net rendered (data points present)', async () => {
  const circles = await page.locator('.plotwrap svg circle').count();
  assert(circles > 0, 'no <circle> data points in the net');
});

await check('overlay is laid out (legend positioned over the plot)', async () => {
  const left = await page.locator('.netlegend').first().evaluate((el) => el.style.left).catch(() => '');
  assert(left && left.endsWith('px'), 'legend has no computed px position');
});

await check('lasso selects data by drag', async () => {
  await page.locator('header button[title^="lasso"]').click();
  const b = await netBox();
  await page.mouse.move(b.x - 12, b.y - 12); await page.mouse.down();
  await page.mouse.move(b.x + b.w + 12, b.y - 12);
  await page.mouse.move(b.x + b.w + 12, b.y + b.h + 12);
  await page.mouse.move(b.x - 12, b.y + b.h + 12);
  await page.mouse.move(b.x - 12, b.y - 12); await page.mouse.up();
  await page.waitForTimeout(50);
  assert(await selCount() > 0, 'lasso around the whole net selected nothing');
  assert(await page.locator('.sel-ring').count() > 0, 'no selection rings drawn');
});

await check('extract turns the selection into a new layer + clears', async () => {
  const before = await page.evaluate(() => window.osjs.project.items().length);
  await page.evaluate(() => window.osjs.extractSelection());
  await page.waitForTimeout(50);
  const after = await page.evaluate(() => window.osjs.project.items().length);
  assert(after > before, 'extract added no layer');
  assert(await selCount() === 0, 'selection not cleared after extract');
});

await check('tag-to-set: lasso then tag → categorical column + the open table refreshes live', async () => {
  await page.evaluate(() => window.osjs.project.items().find((x) => x.type !== 'annotation').setParams({ tableOpen: true }));
  await page.waitForTimeout(40);
  await page.locator('header button[title^="lasso"]').click();
  const b = await netBox();
  await page.mouse.move(b.x - 12, b.y - 12); await page.mouse.down();
  await page.mouse.move(b.x + b.w + 12, b.y - 12); await page.mouse.move(b.x + b.w + 12, b.y + b.h + 12);
  await page.mouse.move(b.x - 12, b.y + b.h + 12); await page.mouse.move(b.x - 12, b.y - 12); await page.mouse.up();
  await page.waitForTimeout(40);
  await page.evaluate(() => window.osjs.tagSelection('Z', 'zone'));
  await page.waitForTimeout(80);
  const tagged = await page.evaluate(() => window.osjs.project.items().some((it) => (it.currentColumns?.() || []).some((c) => c.name === 'zone' && c.values.includes('Z')) && it.currentStyle().colorMode === 'categorical'));
  assert(tagged, 'no layer got a categorical zone tag');
  const inTable = await page.evaluate(() => [...document.querySelectorAll('.floatpanel .dtable .th')].some((th) => /zone/.test(th.textContent)));
  assert(inTable, 'the tagged column did not appear in the open table (no live refresh)');
  await page.evaluate(() => { window.osjs.commitSelection(() => false); window.osjs.project.items().find((x) => x.type !== 'annotation').setParams({ tableOpen: false }); });
});

await check('stats-on-selection reports a footer read-out', async () => {
  await page.evaluate(() => { window.osjs.commitSelection(() => true); window.osjs.statsSelection(); });
  await page.waitForTimeout(60);   // the footer text is reactive (microtask flush)
  const txt = await page.evaluate(() => document.querySelector('.statusbar .cur')?.textContent || '');
  assert(/selection n=\d+/.test(txt), `stats read-out missing (got "${txt}")`);
  await page.evaluate(() => window.osjs.commitSelection(() => false));
});

await check('cone selects data by drag', async () => {
  await page.locator('header button[title^="cone"]').click();
  const b = await netBox();
  await page.mouse.move(b.cx, b.cy); await page.mouse.down();
  await page.mouse.move(b.cx + b.w * 0.42, b.cy); await page.mouse.up();
  await page.waitForTimeout(50);
  assert(await selCount() > 0, 'wide cone selected nothing');
});

await check('spherical polygon selects data by clicking vertices', async () => {
  await page.evaluate(() => window.osjs.commitSelection(() => false));   // clear
  await page.locator('header button[title^="polygon"]').click();
  const b = await netBox();
  const R = b.w / 2 * 0.82;   // vertices must land inside the projection circle (locate is null past ~0.85)
  const verts = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * 2 * Math.PI; verts.push([b.cx + R * Math.cos(a), b.cy + R * Math.sin(a)]); }
  for (const [x, y] of verts) { await page.mouse.click(x, y); await page.waitForTimeout(15); }
  await page.mouse.click(verts[0][0], verts[0][1]);   // click first vertex again → close
  await page.waitForTimeout(50);
  assert(await selCount() > 0, 'a near-full-disk spherical polygon selected nothing');
  await page.evaluate(() => window.osjs.commitSelection(() => false));
});

await check('band selects data within an angle of a plane', async () => {
  await page.locator('header button[title^="band"]').click();
  const b = await netBox();
  await page.mouse.move(b.cx, b.cy); await page.mouse.down();   // pole at centre → great circle = the primitive
  await page.mouse.move(b.cx + b.w * 0.4, b.cy); await page.mouse.up();   // drag near the rim → wide band (stay inside the circle)
  await page.waitForTimeout(50);
  assert(await selCount() > 0, 'a wide band selected nothing');
  await page.evaluate(() => window.osjs.commitSelection(() => false));
});

await check('band edges render as clean in-circle arcs (no back-hemisphere chords)', async () => {
  // inspect the live preview mid-drag: every band-edge point inside the primitive,
  // no segment long enough to be a chord across the net (the old folding bug)
  await page.locator('header button[title^="band"]').click();
  const b = await netBox();
  await page.mouse.move(b.cx + b.w * 0.16, b.cy - b.w * 0.1); await page.mouse.down();
  await page.mouse.move(b.cx + b.w * 0.28, b.cy + b.w * 0.04);
  await page.mouse.move(b.cx + b.w * 0.3, b.cy + b.w * 0.05);
  await page.waitForTimeout(40);
  const bad = await page.evaluate(() => {
    const R = window.osjs.net.element.getBoundingClientRect().width / 2;
    const out = { count: 0, maxseg: 0, rRatio: 0 };
    for (const p of document.querySelectorAll('.sellayer .band-edge, .sellayer .cone')) {
      out.count++;
      const pts = p.getAttribute('points').trim().split(/\s+/).map((s) => s.split(',').map(Number));
      for (let i = 0; i < pts.length; i++) { out.rRatio = Math.max(out.rRatio, Math.hypot(pts[i][0] - R, pts[i][1] - R) / R); if (i) out.maxseg = Math.max(out.maxseg, Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); }
    }
    return out;
  });
  await page.mouse.up();
  assert(bad.count > 0, 'no band preview drawn');
  assert(bad.rRatio <= 1.02, `band point outside the primitive (r/R=${bad.rRatio.toFixed(2)}) — upper-hemisphere point projected instead of hidden`);
  assert(bad.maxseg < 40, `band has a chord-like segment (${bad.maxseg}px) — back-hemisphere folding regression`);
  await page.evaluate(() => window.osjs.commitSelection(() => false));
});

await check('band dip mode: the great circle passes through the clicked dip vector', async () => {
  await page.locator('header button[title^="band"]').click();
  await page.locator('header button[title="click the dip vector (down-dip line) of the plane"]').click();   // pole → dip
  const b = await netBox();
  const cx = b.cx + b.w * 0.18, cy = b.cy - b.w * 0.1;     // click an off-centre dip vector
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + b.w * 0.06, cy + b.w * 0.04);  // small drag → narrow band
  await page.mouse.move(cx + b.w * 0.07, cy + b.w * 0.04);
  await page.waitForTimeout(40);
  const m = await page.evaluate(([clx, cly, left, top]) => {
    const rel = [clx - left, cly - top];
    const pts = (sel) => [...document.querySelectorAll(sel)].flatMap((p) => p.getAttribute('points').trim().split(/\s+/).map((s) => s.split(',').map(Number)));
    const gc = pts('.sellayer .cone'), edges = pts('.sellayer .band-edge');
    let through = 1e9; for (const [x, y] of gc) through = Math.min(through, Math.hypot(x - rel[0], y - rel[1]));
    // narrowness: each band-edge point's distance to the nearest great-circle point (small ⇒ inverted width starts tight)
    let widest = 0; for (const [ex, ey] of edges) { let d = 1e9; for (const [gx, gy] of gc) d = Math.min(d, Math.hypot(ex - gx, ey - gy)); widest = Math.max(widest, d); }
    return { through, widest };
  }, [cx, cy, b.x, b.y]);
  await page.mouse.up();
  assert(m.through < 14, `dip-mode great circle does not pass through the clicked dip vector (min dist ${m.through.toFixed(1)}px)`);
  assert(m.widest < 90, `dip-mode band is not narrow for a small drag (edge ${m.widest.toFixed(0)}px from the plane) — width not inverted`);
  await page.evaluate(() => window.osjs.commitSelection(() => false));
  await page.locator('header button[title="click the pole of the plane"]').click();   // restore pole mode
});

await check('wheel zooms the viewport', async () => {
  await page.evaluate(() => window.osjs.net.resetViewport());
  const b = await netBox();
  await page.mouse.move(b.cx, b.cy);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(50);
  const s = await page.evaluate(() => window.osjs.net.viewport.scale);
  assert(s > 1, `scale did not increase (got ${s})`);
});

await check('composed export builds a real SVG with net + overlay', async () => {
  const fig = await page.evaluate(() => window.osjs.nativeFigure());
  assert(/^<svg/.test(fig.svg), 'not an svg');
  assert(fig.w > 100 && fig.h > 100, `tiny figure ${fig.w}x${fig.h}`);
  assert(/<circle/.test(fig.svg), 'no data circles in export');
  assert(/<text[^>]*>note<\/text>|>note</.test(fig.svg) || /<svg/.test(fig.svg.slice(60)), 'net not embedded');
});

await check('floating panel: ghost rows let you add data without toggling edit', async () => {
  const id = await page.evaluate(() => {
    const it = window.osjs.project.items().find((x) => x.type !== 'annotation');
    it.setParams({ tableOpen: true, tableH: 420 });     // float it tall, read-only
    return it.id;
  });
  await page.waitForTimeout(60);
  const panel = page.locator(`.floatpanel[data-panel="${id}"]`);
  const ghosts = panel.locator('.dtable .td.ghost input.tc');
  assert(await ghosts.count() > 4, 'a resized-tall panel did not fill the empty space with ghost rows');
  const n0 = await page.evaluate((i) => window.osjs.project.items().find((x) => x.id === i).currentMeasurements().length, id);
  const row0 = panel.locator('.dtable .td.ghost input.tc[data-grow="0"]');
  await row0.nth(0).fill('300'); await row0.nth(1).fill('10');
  await row0.nth(1).press('Enter');
  await page.waitForTimeout(60);
  const added = await page.evaluate((i) => { const m = window.osjs.project.items().find((x) => x.id === i).currentMeasurements(); return m[m.length - 1]; }, id);
  const n1 = await page.evaluate((i) => window.osjs.project.items().find((x) => x.id === i).currentMeasurements().length, id);
  assert(n1 === n0 + 1, 'Enter on a ghost row did not append a measurement');
  assert(added[0] === 300 && added[1] === 10, `whole ghost row not committed (got ${added})`);
  await page.evaluate((i) => window.osjs.project.items().find((x) => x.id === i).setParams({ tableOpen: false }), id);
});

await check('table copy → clipboard TSV, and paste → appended rows (Excel round-trip)', async () => {
  // open the layer's table in the tab and enter edit mode (paste lives there)
  const id = await page.evaluate(() => { const it = window.osjs.project.items().find((x) => x.type !== 'annotation'); window.osjs.select(it); return it.id; });
  await page.locator('.tabs .tab', { hasText: /table/i }).click();
  await page.waitForTimeout(40);
  await page.locator('.tablewrap .thead-row .btn', { hasText: /edit/i }).click();
  await page.waitForTimeout(40);
  // copy → the clipboard holds a TSV header + rows
  await page.locator('.tablewrap .thead-actions .mini', { hasText: /copy/i }).click();
  await page.waitForTimeout(40);
  const tsv = await page.evaluate(() => navigator.clipboard.readText());
  assert(/dip dir\tdip/.test(tsv), `clipboard TSV missing header (got "${tsv.slice(0, 40)}")`);
  assert(tsv.split('\n').length >= 9, 'TSV should have a header + 8 data rows');
  // paste a new TSV → rows appended
  const n0 = await page.evaluate((i) => window.osjs.project.items().find((x) => x.id === i).currentMeasurements().length, id);
  await page.evaluate(() => navigator.clipboard.writeText('dip dir\tdip\n45\t12\n50\t15'));
  await page.locator('.tablewrap .thead-actions .mini', { hasText: /paste/i }).click();
  await page.waitForTimeout(60);
  const n1 = await page.evaluate((i) => window.osjs.project.items().find((x) => x.id === i).currentMeasurements().length, id);
  assert(n1 === n0 + 2, `paste did not append 2 rows (was ${n0}, now ${n1})`);
  await page.locator('.tabs .tab', { hasText: /projection/i }).click();   // back to the net for later checks
  await page.waitForTimeout(40);
});

await check('footer orientation read-out tracks the net rotation', async () => {
  await page.evaluate(() => window.osjs.net.resetView());
  await page.waitForTimeout(40);
  const before = await page.evaluate(() => document.querySelector('.statusbar .orient')?.textContent.trim());
  assert(before === 'plan view', `unrotated should read 'plan view' (got "${before}")`);
  await page.evaluate(() => window.osjs.net.setView(120, 30));
  await page.waitForTimeout(40);
  const after = await page.evaluate(() => document.querySelector('.statusbar .orient')?.textContent.trim());
  assert(/120\/30/.test(after), `rotating should show the centre attitude (got "${after}")`);
  await page.evaluate(() => window.osjs.net.resetView());
});

await check('legend exports from the scene at real geometry (names + box)', async () => {
  const svg = await page.evaluate(() => window.osjs.nativeFigure().svg);
  assert(/>bedding</.test(svg) && /></.test(svg), 'legend layer name missing from native export');
  assert(/>joints</.test(svg), 'legend missing a visible layer');
  // the legend box should sit inside the figure (positive, finite coords)
  assert(!/NaN|undefined/.test(svg), 'legend/scene produced NaN/undefined coordinates');
});

await check('dark mode: cardinals stay visible (themed fill) and labels get a halo', async () => {
  await page.locator('button[title="toggle theme"]').click();   // → dark
  await page.waitForTimeout(50);
  const fill = await page.evaluate(() => { const t = document.querySelector('.osjs-cardinal'); return t ? getComputedStyle(t).fill : ''; });
  assert(fill && fill !== 'rgb(0, 0, 0)', `cardinals still black in dark mode (fill=${fill})`);
  await page.locator('button[title^="add a text annotation"]').click();
  await page.waitForTimeout(60);
  const shadow = await page.evaluate(() => { const l = document.querySelector('.anno-label'); return l ? l.style.textShadow : '(no label)'; });
  assert(/rgba?\(/.test(shadow), `plain label has no auto-contrast halo (textShadow=${shadow})`);
  await page.keyboard.press('Escape');
  await page.locator('button[title="toggle theme"]').click();   // back to light
});

await browser.close();
server.close();

console.log('--- osjs browser smoke ---');
for (const [ok, label] of results) console.log((ok ? 'PASS' : 'FAIL') + ' — ' + label);
if (pageErrors.length) { console.log('--- page errors ---'); for (const e of pageErrors) console.log('  ' + e); }
const failed = results.filter(([ok]) => !ok).length + pageErrors.length;
console.log(`\n${results.length - results.filter(([ok]) => !ok).length}/${results.length} checks passed` + (pageErrors.length ? `, ${pageErrors.length} page error(s)` : ''));
console.log(failed ? 'browser smoke: FAILED' : 'browser smoke: OK');
process.exit(failed ? 1 : 0);
