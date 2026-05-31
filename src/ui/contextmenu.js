/**
 * @module ui/contextmenu — a tiny, reusable right-click / long-press popup menu.
 *
 * Zero-dependency, plain-DOM (menus are ephemeral, so no reactivity needed — and
 * it sidesteps the sideact multi-root caveat). One menu open at a time; dismisses
 * on outside-press, Escape, scroll, blur, or resize. Edge-flips to stay on-screen.
 *
 * items: array of
 *   { label, onClick, danger?, disabled? }   — an action
 *   { separator: true }                        — a divider
 *   falsy                                      — skipped (lets callers inline `cond && {…}`)
 */

let _open = null;

export function closeMenu() {
  if (!_open) return;
  _open.remove();
  _open = null;
  document.removeEventListener('pointerdown', _away, true);
  document.removeEventListener('keydown', _key, true);
  document.removeEventListener('wheel', closeMenu, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
}

function _away(e) { if (_open && !_open.contains(e.target)) closeMenu(); }
function _key(e) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } }

export function openMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ctxmenu';
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.append(s); continue; }
    const b = document.createElement('button');
    b.className = `ctx-item${it.danger ? ' danger' : ''}`;
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    else b.addEventListener('click', () => { closeMenu(); try { it.onClick && it.onClick(); } catch (err) { console.error(err); } });
    menu.append(b);
  }
  document.body.append(menu);
  _open = menu;

  // place at the cursor, flipped in from the viewport edge if needed
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
  menu.style.left = `${Math.max(4, Math.min(x, vw - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, vh - r.height - 4))}px`;

  // defer dismiss wiring so the opening event itself doesn't close it
  setTimeout(() => {
    if (!_open) return;
    document.addEventListener('pointerdown', _away, true);
    document.addEventListener('keydown', _key, true);
    document.addEventListener('wheel', closeMenu, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  }, 0);
  return menu;
}
