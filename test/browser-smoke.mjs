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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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

await browser.close();
server.close();

console.log('--- osjs browser smoke ---');
for (const [ok, label] of results) console.log((ok ? 'PASS' : 'FAIL') + ' — ' + label);
if (pageErrors.length) { console.log('--- page errors ---'); for (const e of pageErrors) console.log('  ' + e); }
const failed = results.filter(([ok]) => !ok).length + pageErrors.length;
console.log(`\n${results.length - results.filter(([ok]) => !ok).length}/${results.length} checks passed` + (pageErrors.length ? `, ${pageErrors.length} page error(s)` : ''));
console.log(failed ? 'browser smoke: FAILED' : 'browser smoke: OK');
process.exit(failed ? 1 : 0);
