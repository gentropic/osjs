/**
 * @module render/figure-export — the figure composer's export pipeline.
 *
 * The first carved-out piece of the would-be `@gcu/compo`: turn the composed
 * figure (bearing's net SVG + the annotation / table / legend / page overlays)
 * into a self-contained image, two ways:
 *   • nativeFigure()   — real <text>/<rect>/<line> via a DOM→SVG walk (editor-
 *                        portable, no foreignObject → no canvas taint). SVG + PNG.
 *   • composeFigureSVG() — exact browser render wrapped in <foreignObject>.
 * Plus exportSVG / exportPNG (rasterize at DPI) / printFigure (fit one A4 page in
 * a hidden iframe). Page frame on → crop to the page.
 *
 * Factory so it stays decoupled from the app's signals; pass the few live deps.
 *   createExport({ net, project, getWrap, pageFrame, notify })
 */

const SVGNS = 'http://www.w3.org/2000/svg';
const xesc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n2 = (v) => Math.round(v * 100) / 100;
// transient UI (brush / selection) + interactive chrome are kept out of exports;
// .floatpanel is handled specially (clean caption + grid) by emitPanel.
const SKIP = '.anno-handle,.fp-resize,.colgrip,.emptystate,.brushring,.brushlayer,.sellayer,.gutter,.pageframe,.floatpanel';
const EXPORT_VARS = ['--bg', '--panel', '--panel-2', '--raised', '--line', '--line-2', '--ink', '--ink-dim', '--ink-faint', '--amber', '--accent-text', '--cyan', '--cyan-text', '--on-accent', '--canvas-bg', '--canvas-grid', '--vignette', '--ui', '--mono'];

export function createExport({ net, project, getWrap, pageFrame, notify = () => {} }) {
  // ── foreignObject path (exact browser render; used by print) ──
  const exportVars = () => { const cs = getComputedStyle(document.body); return EXPORT_VARS.map((n) => `${n}:${cs.getPropertyValue(n)}`).join(';'); };
  function composeFigureSVG() {
    const wrap = getWrap(), r = wrap.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    const clone = wrap.cloneNode(true);
    clone.querySelectorAll('.anno-handle, .fp-resize, .colgrip, .emptystate').forEach((e) => e.remove());
    clone.querySelectorAll('.fp-actions, .thead-row .btn, .thead-row .mini').forEach((e) => { e.style.visibility = 'hidden'; });   // keep layout → table stays put
    clone.querySelectorAll('.pageframe').forEach((e) => { e.style.border = 'none'; e.style.boxShadow = 'none'; });
    clone.querySelectorAll('.sel').forEach((e) => e.classList.remove('sel'));
    clone.style.cssText = `position:relative;inset:auto;width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center;`;
    const cnet = clone.querySelector(':scope > svg'); if (cnet) { cnet.style.width = `${net.element.offsetWidth || 540}px`; cnet.style.height = 'auto'; }
    let cx = 0, cy = 0, cw = W, ch = H;
    if (project.pageShow()) { const fr = pageFrame.getBoundingClientRect(); cx = fr.left - r.left; cy = fr.top - r.top; cw = Math.max(1, Math.round(fr.width)); ch = Math.max(1, Math.round(fr.height)); }
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const dark = document.body.classList.contains('theme-dark') ? ' theme-dark' : '';
    const bg = project.figureBg() === 'transparent' ? 'transparent' : '#ffffff';
    const ser = new XMLSerializer().serializeToString(clone);
    const inner = `<div xmlns="http://www.w3.org/1999/xhtml" class="osjs-fig preview${dark}" style="position:relative;width:${W}px;height:${H}px;background:${bg};${exportVars()}"><style>${css}</style>${ser}</div>`;
    return { svg: `<svg xmlns="${SVGNS}" width="${cw}" height="${ch}" viewBox="${cx} ${cy} ${cw} ${ch}"><foreignObject x="0" y="0" width="${W}" height="${H}">${inner}</foreignObject></svg>`, w: cw, h: ch };
  }

  // ── best-effort font embedding (Google-Fonts CSS + woff2 → data-URI, cached) ──
  let _fontCSS;
  const ab2b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  async function embeddedFontCSS() {
    if (_fontCSS !== undefined) return _fontCSS;
    _fontCSS = '';
    try {
      const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => /fonts\.googleapis/.test(l.href));
      if (!link || typeof fetch === 'undefined') return _fontCSS;
      let css = await (await fetch(link.href)).text();
      const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]))];
      const map = {};
      await Promise.all(urls.map(async (u) => { try { const b = await (await fetch(u)).arrayBuffer(); map[u] = `data:font/woff2;base64,${ab2b64(b)}`; } catch { /* skip this face */ } }));
      _fontCSS = css.replace(/url\((https:\/\/[^)]+)\)/g, (m, u) => (map[u] ? `url(${map[u]})` : m));
    } catch { _fontCSS = ''; }
    return _fontCSS;
  }

  // ── native SVG path (real primitives via a DOM→SVG walk) ──
  function nativeFigure(fontCSS) {
    const wrap = getWrap(), wr = wrap.getBoundingClientRect();
    const W = Math.max(1, Math.round(wr.width)), H = Math.max(1, Math.round(wr.height));
    const out = [];
    const visible = (cs) => cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0;
    const emitNested = (svgEl) => {
      const r = svgEl.getBoundingClientRect(); const c = svgEl.cloneNode(true);
      c.setAttribute('x', n2(r.left - wr.left)); c.setAttribute('y', n2(r.top - wr.top));
      c.setAttribute('width', n2(r.width)); c.setAttribute('height', n2(r.height));
      c.removeAttribute('style'); out.push(new XMLSerializer().serializeToString(c));
    };
    const emitBox = (el, cs, r) => {
      const bg = cs.backgroundColor, hasBg = bg && bg !== 'transparent' && !bg.startsWith('rgba(0, 0, 0, 0');
      const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs[`border${s}Width`]) || 0);
      const bw = Math.max(...sides), hasBorder = bw > 0;
      if (!hasBg && !hasBorder) return;
      const rx = parseFloat(cs.borderRadius) || 0;
      out.push(`<rect x="${n2(r.left - wr.left)}" y="${n2(r.top - wr.top)}" width="${n2(r.width)}" height="${n2(r.height)}"${rx ? ` rx="${n2(rx)}"` : ''} fill="${hasBg ? bg : 'none'}"${hasBorder ? ` stroke="${cs.borderBottomColor || cs.borderTopColor}" stroke-width="${n2(bw)}"` : ''} opacity="${cs.opacity}"/>`);
    };
    const emitText = (el, cs, r) => {
      const t = [...el.childNodes].filter((nd) => nd.nodeType === 3).map((nd) => nd.textContent).join('').trim();
      if (!t) return;
      const fs = parseFloat(cs.fontSize) || 12, pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
      const al = cs.textAlign, anchor = al === 'center' ? 'middle' : al === 'right' || al === 'end' ? 'end' : 'start';
      const x = anchor === 'middle' ? (r.left + r.right) / 2 : anchor === 'end' ? r.right - pr : r.left + pl;
      out.push(`<text x="${n2(x - wr.left)}" y="${n2(r.top - wr.top + r.height / 2)}" font-family="${xesc(cs.fontFamily)}" font-size="${n2(fs)}" font-weight="${cs.fontWeight}" fill="${cs.color}" text-anchor="${anchor}" dominant-baseline="central" opacity="${cs.opacity}">${xesc(t)}</text>`);
    };
    const walk = (el) => {
      if (el.nodeType !== 1 || (el.matches && el.matches(SKIP)) || el.tagName === 'BUTTON' || el.tagName === 'INPUT') return;
      const cs = getComputedStyle(el); if (!visible(cs)) return;
      if (el.namespaceURI === SVGNS) { if (el.tagName.toLowerCase() === 'svg') emitNested(el); return; }
      const r = el.getBoundingClientRect();
      if (r.width && r.height) emitBox(el, cs, r);
      emitText(el, cs, r);
      for (const c of el.children) walk(c);
    };
    // floating tables → clean caption + bordered grid, clipped to what's shown
    let clipN = 0;
    const emitPanel = (panel) => {
      const dt = panel.querySelector('.dtable'); if (!dt) return;
      const scroll = panel.querySelector('.tscroll') || dt, sv = scroll.getBoundingClientRect();
      if (!sv.width) return;
      const titEl = panel.querySelector('.fp-title'), tt = titEl ? titEl.textContent.trim() : '';
      if (tt) { const tcs = getComputedStyle(titEl); out.push(`<text x="${n2(sv.left - wr.left)}" y="${n2(sv.top - wr.top - 7)}" font-family="${xesc(tcs.fontFamily)}" font-size="13" font-weight="700" fill="${tcs.color}">${xesc(tt)}</text>`); }
      const scs = getComputedStyle(scroll);
      out.push(`<rect x="${n2(sv.left - wr.left)}" y="${n2(sv.top - wr.top)}" width="${n2(sv.width)}" height="${n2(sv.height)}" fill="${scs.backgroundColor}" stroke="${scs.borderTopColor}" stroke-width="1"/>`);
      const start = out.length;
      for (const cell of dt.children) { const r = cell.getBoundingClientRect(); if (r.bottom <= sv.top + 1 || r.top >= sv.bottom - 1) continue; walk(cell); }
      const cells = out.splice(start).join(''); const cid = `tclip${clipN++}`;
      out.push(`<clipPath id="${cid}"><rect x="${n2(sv.left - wr.left)}" y="${n2(sv.top - wr.top)}" width="${n2(sv.width)}" height="${n2(sv.height)}"/></clipPath><g clip-path="url(#${cid})">${cells}</g>`);
    };
    for (const child of wrap.children) walk(child);
    for (const panel of wrap.querySelectorAll('.floatpanel')) emitPanel(panel);
    let cx = 0, cy = 0, cw = W, ch = H;
    if (project.pageShow()) { const fr = pageFrame.getBoundingClientRect(); cx = fr.left - wr.left; cy = fr.top - wr.top; cw = Math.max(1, Math.round(fr.width)); ch = Math.max(1, Math.round(fr.height)); }
    const bg = project.figureBg() === 'transparent' ? '' : `<rect x="${n2(cx)}" y="${n2(cy)}" width="${cw}" height="${ch}" fill="#ffffff"/>`;
    const fonts = fontCSS ? `<style>${fontCSS}</style>` : '';
    return { svg: `<svg xmlns="${SVGNS}" width="${cw}" height="${ch}" viewBox="${n2(cx)} ${n2(cy)} ${cw} ${ch}">${fonts}${bg}${out.join('')}</svg>`, w: cw, h: ch };
  }

  // ── download / print ──
  const triggerDownload = (url, name) => { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
  async function exportSVG() {
    const { svg } = nativeFigure(await embeddedFontCSS());
    triggerDownload(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), 'figure.svg');
  }
  async function exportPNG() {
    const { svg, w, h } = nativeFigure(await embeddedFontCSS());
    const scale = Math.max(1, project.exportDpi() / 96);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const ctx = c.getContext('2d');
      if (project.figureBg() !== 'transparent') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob((b) => { if (b) triggerDownload(URL.createObjectURL(b), 'figure.png'); else notify('PNG export failed (canvas blocked)'); });
    };
    img.onerror = () => { URL.revokeObjectURL(url); notify('export failed — the browser blocked rasterizing the figure'); };
    img.src = url;
  }
  // print the composed figure via a hidden iframe (only the figure → a clean page)
  async function printFigure() {
    const { svg, w, h } = nativeFigure(await embeddedFontCSS());
    let dw = 190, dh = 190 * h / w;               // fit one A4 page (10mm margins → 190×277mm)
    if (dh > 277) { dh = 277; dw = 277 * w / h; }
    const land = w > h;
    const ifr = document.createElement('iframe');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(ifr);
    const doc = ifr.contentDocument || ifr.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4 ${land ? 'landscape' : 'portrait'};margin:10mm}html,body{margin:0;padding:0}svg{width:${Math.min(dw, land ? 277 : 190)}mm;height:auto;max-height:${land ? 190 : 277}mm;display:block;margin:0 auto}</style></head><body>${svg}</body></html>`);
    doc.close();
    const win = ifr.contentWindow;
    win.addEventListener('afterprint', () => setTimeout(() => ifr.remove(), 300));
    setTimeout(() => { win.focus(); win.print(); }, 80);
  }

  return { nativeFigure, composeFigureSVG, exportSVG, exportPNG, printFigure };
}
