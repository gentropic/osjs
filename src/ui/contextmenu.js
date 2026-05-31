/**
 * @module ui/contextmenu — a tiny, reusable right-click / long-press popup menu.
 *
 * Zero-dependency, plain-DOM (menus are ephemeral, so no reactivity needed — and
 * it sidesteps the sideact multi-root caveat). One menu tree open at a time;
 * dismisses on outside-press, Escape, scroll, blur, or resize. Edge-flips to stay
 * on-screen. Submenus open to the side on hover.
 *
 * items: array of
 *   { label, onClick, danger?, disabled?, checked? }  — an action; `checked`
 *        (boolean) shows a ✓ toggle marker and reserves the marker gutter.
 *   { label, submenu: [...], disabled? }               — a nested menu
 *   { separator: true }                                — a divider
 *   falsy                                              — skipped (inline `cond && {…}`)
 */

let _stack = [];          // open menus, root first; submenus pushed on top

export function closeMenu() {
  while (_stack.length) _stack.pop().remove();
  _detach();
}

function _closeFrom(level) {           // close any menu at >= level (a deeper submenu)
  while (_stack.length > level) _stack.pop().remove();
}

function _detach() {
  document.removeEventListener('pointerdown', _away, true);
  document.removeEventListener('keydown', _key, true);
  document.removeEventListener('wheel', closeMenu, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
}

function _away(e) { if (_stack.length && !_stack.some((m) => m.contains(e.target))) closeMenu(); }
function _key(e) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } }

export function openMenu(x, y, items) {
  closeMenu();
  const menu = _build(items, 0);
  document.body.append(menu);
  _place(menu, x, y);
  _stack.push(menu);
  setTimeout(() => {
    if (!_stack.length) return;
    document.addEventListener('pointerdown', _away, true);
    document.addEventListener('keydown', _key, true);
    document.addEventListener('wheel', closeMenu, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  }, 0);
  return menu;
}

function _build(items, level) {
  const menu = document.createElement('div');
  menu.className = 'ctxmenu';
  // reserve the ✓ gutter only if some item is a toggle
  const hasToggle = items.some((it) => it && 'checked' in it);
  if (hasToggle) menu.classList.add('has-toggles');
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.append(s); continue; }
    const b = document.createElement('button');
    b.className = `ctx-item${it.danger ? ' danger' : ''}${it.submenu ? ' has-sub' : ''}`;
    if (hasToggle) { const mk = document.createElement('span'); mk.className = 'ctx-check'; mk.textContent = ('checked' in it && it.checked) ? '✓' : ''; b.append(mk); }
    const lbl = document.createElement('span'); lbl.className = 'ctx-label'; lbl.textContent = it.label; b.append(lbl);
    if (it.submenu) { const ar = document.createElement('span'); ar.className = 'ctx-arrow'; ar.textContent = '▸'; b.append(ar); }
    if (it.disabled) {
      b.disabled = true;
    } else if (it.submenu) {
      b.addEventListener('mouseenter', () => {
        _closeFrom(level + 1);
        const sub = _build(it.submenu, level + 1);
        document.body.append(sub);
        _place(sub, b.getBoundingClientRect().right - 3, b.getBoundingClientRect().top, b.getBoundingClientRect());
        _stack.push(sub);
      });
    } else {
      b.addEventListener('mouseenter', () => _closeFrom(level + 1));
      b.addEventListener('click', () => { closeMenu(); try { it.onClick && it.onClick(); } catch (err) { console.error(err); } });
    }
    menu.append(b);
  }
  return menu;
}

function _place(menu, x, y, avoid) {
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
  let px = x, py = y;
  if (px + r.width > vw) px = avoid ? Math.max(4, avoid.left - r.width + 3) : Math.max(4, vw - r.width - 4);
  if (py + r.height > vh) py = Math.max(4, vh - r.height - 4);
  menu.style.left = `${Math.max(4, px)}px`;
  menu.style.top = `${Math.max(4, py)}px`;
}
