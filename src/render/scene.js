/**
 * @module render/scene — a tiny declarative 2-D primitive vocabulary + SVG renderer.
 *
 * The seed of the would-be `@gcu/compo`: composition elements (page frame, legend,
 * annotations/title…) describe themselves as a flat list of typed primitives in a
 * single coordinate space, and ONE renderer turns that list into SVG. The figure
 * export consumes this instead of walking the live DOM and re-deriving geometry +
 * styling from computed styles (the source of the legend/title export bugs).
 *
 * Primitives are plain objects (closed vocabulary), so they serialise, diff, and
 * test without a DOM. Coordinates are plain numbers in the caller's space; the
 * renderer only stringifies — it does no layout. Helper constructors are provided
 * for readability but any matching literal works.
 *
 *   rect   { t:'rect',   x, y, w, h, rx?, fill?, stroke?, sw?, dash?, opacity? }
 *   text   { t:'text',   x, y, text, size, weight?, family?, fill?, anchor?, baseline?, opacity? }
 *   line   { t:'line',   x1, y1, x2, y2, stroke, sw?, dash?, opacity? }
 *   circle { t:'circle', cx, cy, r, fill?, stroke?, sw?, opacity? }
 *   poly   { t:'polyline', pts:[[x,y]…], stroke?, sw?, dash?, fill?, opacity? }
 *   group  { t:'group', children:[…], clip?:{x,y,w,h}, translate?:[dx,dy], opacity? }
 *   svg    { t:'svg', markup, x, y, w, h }   — embed a nested <svg> (e.g. the net)
 */

const SVGNS = 'http://www.w3.org/2000/svg';
export const xesc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n2 = (v) => Math.round(v * 100) / 100;
const op = (o) => (o != null && +o !== 1 ? ` opacity="${n2(+o)}"` : '');
const dash = (d) => (d ? ` stroke-dasharray="${d}"` : '');

// ── constructors (optional sugar; literals are equally valid) ──
export const rect = (x, y, w, h, o = {}) => ({ t: 'rect', x, y, w, h, ...o });
export const text = (x, y, str, o = {}) => ({ t: 'text', x, y, text: str, ...o });
export const line = (x1, y1, x2, y2, o = {}) => ({ t: 'line', x1, y1, x2, y2, ...o });
export const circle = (cx, cy, r, o = {}) => ({ t: 'circle', cx, cy, r, ...o });
export const polyline = (pts, o = {}) => ({ t: 'polyline', pts, ...o });
export const group = (children, o = {}) => ({ t: 'group', children, ...o });

let _clip = 0;
function primToSVG(p) {
  if (!p) return '';
  switch (p.t) {
    case 'rect':
      return `<rect x="${n2(p.x)}" y="${n2(p.y)}" width="${n2(p.w)}" height="${n2(p.h)}"${p.rx ? ` rx="${n2(p.rx)}"` : ''} fill="${p.fill || 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${n2(p.sw ?? 1)}"` : ''}${dash(p.dash)}${op(p.opacity)}/>`;
    case 'text': {
      const anchor = p.anchor || 'start', baseline = p.baseline || 'auto';
      return `<text x="${n2(p.x)}" y="${n2(p.y)}"${p.family ? ` font-family="${xesc(p.family)}"` : ''} font-size="${n2(p.size ?? 12)}"${p.weight ? ` font-weight="${p.weight}"` : ''} fill="${p.fill || '#000'}" text-anchor="${anchor}"${baseline !== 'auto' ? ` dominant-baseline="${baseline}"` : ''}${op(p.opacity)}>${xesc(p.text)}</text>`;
    }
    case 'line':
      return `<line x1="${n2(p.x1)}" y1="${n2(p.y1)}" x2="${n2(p.x2)}" y2="${n2(p.y2)}" stroke="${p.stroke || '#000'}" stroke-width="${n2(p.sw ?? 1)}"${dash(p.dash)}${op(p.opacity)}/>`;
    case 'circle':
      return `<circle cx="${n2(p.cx)}" cy="${n2(p.cy)}" r="${n2(p.r)}" fill="${p.fill || 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${n2(p.sw ?? 1)}"` : ''}${op(p.opacity)}/>`;
    case 'polyline':
      return `<polyline points="${p.pts.map(([x, y]) => `${n2(x)},${n2(y)}`).join(' ')}" fill="${p.fill || 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${n2(p.sw ?? 1)}"` : ''}${dash(p.dash)}${op(p.opacity)}/>`;
    case 'group': {
      const inner = (p.children || []).map(primToSVG).join('');
      let attrs = '';
      if (p.translate) attrs += ` transform="translate(${n2(p.translate[0])} ${n2(p.translate[1])})"`;
      if (p.opacity != null && +p.opacity !== 1) attrs += op(p.opacity);
      if (p.clip) { const id = `sc${_clip++}`; return `<clipPath id="${id}"><rect x="${n2(p.clip.x)}" y="${n2(p.clip.y)}" width="${n2(p.clip.w)}" height="${n2(p.clip.h)}"/></clipPath><g clip-path="url(#${id})"${attrs}>${inner}</g>`; }
      return attrs ? `<g${attrs}>${inner}</g>` : inner;
    }
    case 'svg':
      return embedSvg(p);
    default:
      return '';
  }
}

// embed a nested <svg>: accept a serialised <svg …> string or already-built markup,
// and stamp the placement attributes (x/y/width/height) so it sits in the scene.
function embedSvg(p) {
  let m = String(p.markup || '');
  const set = (name, val) => {
    const re = new RegExp(`(<svg\\b[^>]*?)\\s${name}="[^"]*"`, 'i');
    if (re.test(m)) m = m.replace(re, `$1`);
    return val;
  };
  // strip any existing x/y/width/height on the root, then inject ours
  m = m.replace(/^(\s*<svg\b)([^>]*)>/i, (full, head, rest) => {
    const cleaned = rest.replace(/\s(?:x|y|width|height|style)="[^"]*"/gi, '');
    return `${head}${cleaned} x="${n2(p.x)}" y="${n2(p.y)}" width="${n2(p.w)}" height="${n2(p.h)}">`;
  });
  return m;
}

// serialise a primitive list to bare SVG markup (no <svg> wrapper) — for embedding
// a scene into a larger document (e.g. one composition layer inside the figure).
export function primsToMarkup(prims) { return (prims || []).map(primToSVG).join(''); }

/**
 * Render a primitive list to a self-contained SVG string.
 * @param {Array} prims  flat list of primitives (groups nest)
 * @param {{x?:number,y?:number,w:number,h:number,bg?:string,fontCSS?:string}} box
 */
export function sceneToSVG(prims, box) {
  const { x = 0, y = 0, w, h, bg, fontCSS } = box;
  const style = fontCSS ? `<style>${fontCSS}</style>` : '';
  const back = bg && bg !== 'transparent' ? `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="${bg}"/>` : '';
  const body = (prims || []).map(primToSVG).join('');
  return { svg: `<svg xmlns="${SVGNS}" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)}">${style}${back}${body}</svg>`, w: Math.round(w), h: Math.round(h) };
}
