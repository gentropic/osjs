/**
 * @module main — bootstrap. Mounts the OSJS shell (ui/app.js) into #osjs.
 * Dev runs this as a module directly; the build inlines it into dist/osjs.html.
 */

import { mountApp } from './ui/app.js';

export { mountApp };

if (typeof document !== 'undefined') {
  window.osjs = mountApp(document.getElementById('osjs') || document.body);
}
