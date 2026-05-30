# vendored libraries

Zero-dependency GCU libs are **vendored** (copied in), not pulled from npm — we
control the version and can patch in place while iterating. Re-copy from source
to update.

| File | Source | Notes |
|---|---|---|
| `bearing.mjs` | `../bearing.js/dist/bearing.mjs` (npm `@gcu/bearing`, GitHub `endarthur/bearing.js`) | ESM bundle of the engine. Rebuild bearing (`node build.js`) then re-copy. |
| `sideact-signals.js` | `../auditable/ext/sideact/src/signals.js` (`@gcu/sideact/signals`) | Standalone reactive core: `signal`, `computed`, `effect`, `batch`. Zero-dep, no DOM. |

To add (when the UI workspace lands): `@gcu/rails`, `@gcu/menu`, `@gcu/dialog`,
`@gcu/switchboard` — all from `../auditable/ext/<name>/index.js`.
