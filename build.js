// OSJS build — bundle the ESM app into a single self-contained file (WA-style,
// offline). Dev does NOT need this (browsers run src/main.js as modules); this
// is for the deployable single-file artifact and, later, the auditable surface.

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  outfile: 'dist/osjs.js',
});
console.log('Built dist/osjs.js');

// Inline into a single deployable HTML.
const js = readFileSync('dist/osjs.js', 'utf8');
// Function replacement so `$`-sequences in the minified JS ($&, $`, $') aren't
// interpreted as replacement patterns (which silently balloons the output).
const html = readFileSync('index.html', 'utf8')
  .replace('<script type="module" src="./src/main.js"></script>', () => `<script>${js}</script>`);
writeFileSync('dist/osjs.html', html);
console.log('Built dist/osjs.html (single file)');
