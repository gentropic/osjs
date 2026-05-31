import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneToSVG, rect, text, line, circle, polyline, group, xesc } from '../src/render/scene.js';

test('scene: rect emits fill/stroke/rx/opacity, rounds coords', () => {
  const { svg } = sceneToSVG([rect(1.234, 2, 10, 20, { rx: 3, fill: '#abc', stroke: '#123', sw: 2, opacity: 0.5 })], { w: 100, h: 100 });
  assert.match(svg, /<rect x="1.23" y="2" width="10" height="20" rx="3" fill="#abc" stroke="#123" stroke-width="2" opacity="0.5"\/>/);
});

test('scene: rect with no fill defaults to none, opacity 1 omitted', () => {
  const { svg } = sceneToSVG([rect(0, 0, 5, 5, { stroke: '#000' })], { w: 10, h: 10 });
  assert.match(svg, /fill="none"/);
  assert.doesNotMatch(svg, /opacity=/);
});

test('scene: text carries font + anchor + baseline and escapes content', () => {
  const { svg } = sceneToSVG([text(5, 6, 'a & <b>', { size: 14, weight: 700, family: 'Foo', fill: '#222', anchor: 'middle', baseline: 'central' })], { w: 50, h: 50 });
  assert.match(svg, /<text x="5" y="6" font-family="Foo" font-size="14" font-weight="700" fill="#222" text-anchor="middle" dominant-baseline="central">a &amp; &lt;b&gt;<\/text>/);
});

test('scene: line / circle / polyline', () => {
  const { svg } = sceneToSVG([
    line(0, 0, 10, 10, { stroke: '#f00', sw: 1.5, dash: '4 3' }),
    circle(5, 5, 3, { fill: '#0f0' }),
    polyline([[0, 0], [1, 2], [3.456, 4]], { stroke: '#00f' }),
  ], { w: 20, h: 20 });
  assert.match(svg, /<line x1="0" y1="0" x2="10" y2="10" stroke="#f00" stroke-width="1.5" stroke-dasharray="4 3"\/>/);
  assert.match(svg, /<circle cx="5" cy="5" r="3" fill="#0f0"\/>/);
  assert.match(svg, /<polyline points="0,0 1,2 3.46,4" fill="none" stroke="#00f" stroke-width="1"\/>/);
});

test('scene: group nests children and applies translate', () => {
  const { svg } = sceneToSVG([group([rect(0, 0, 2, 2, { fill: '#000' })], { translate: [10, 20] })], { w: 50, h: 50 });
  assert.match(svg, /<g transform="translate\(10 20\)"><rect[^>]*fill="#000"\/><\/g>/);
});

test('scene: group clip emits a clipPath and references it', () => {
  const { svg } = sceneToSVG([group([rect(0, 0, 100, 100, { fill: '#000' })], { clip: { x: 5, y: 5, w: 20, h: 20 } })], { w: 50, h: 50 });
  assert.match(svg, /<clipPath id="sc\d+"><rect x="5" y="5" width="20" height="20"\/><\/clipPath>/);
  assert.match(svg, /<g clip-path="url\(#sc\d+\)">/);
});

test('scene: embedded svg gets its placement attrs replaced (not duplicated)', () => {
  const inner = '<svg xmlns="http://www.w3.org/2000/svg" x="999" width="1" viewBox="0 0 10 10"><circle/></svg>';
  const { svg } = sceneToSVG([{ t: 'svg', markup: inner, x: 30, y: 40, w: 200, h: 150 }], { w: 300, h: 300 });
  assert.match(svg, /x="30" y="40" width="200" height="150"/);
  assert.doesNotMatch(svg, /x="999"/);
  assert.match(svg, /viewBox="0 0 10 10"/);   // preserved
  assert.equal((svg.match(/width="200"/g) || []).length, 1, 'placement width injected once');
});

test('scene: sceneToSVG wraps with viewBox, optional bg + fontCSS', () => {
  const { svg, w, h } = sceneToSVG([rect(0, 0, 1, 1, { fill: '#000' })], { x: 2, y: 3, w: 120, h: 80, bg: '#fff', fontCSS: '@font-face{}' });
  assert.equal(w, 120); assert.equal(h, 80);
  assert.match(svg, /viewBox="2 3 120 80"/);
  assert.match(svg, /<style>@font-face\{\}<\/style>/);
  assert.match(svg, /<rect x="2" y="3" width="120" height="80" fill="#fff"\/>/);   // bg rect at viewBox origin
});

test('scene: transparent bg emits no background rect', () => {
  const { svg } = sceneToSVG([], { w: 10, h: 10, bg: 'transparent' });
  assert.doesNotMatch(svg, /<rect/);
});

test('scene: xesc escapes the five entities used', () => {
  assert.equal(xesc('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
});
