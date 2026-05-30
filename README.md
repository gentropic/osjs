# OSJS — OpenStereo, web edition

Interactive structural-geology stereonet application for the browser, built on
[`@gcu/bearing`](https://github.com/endarthur/bearing.js). The web successor to
**[OpenStereo](https://github.com/spamlab-iee/os)** (Python/PyQt) — same ideas,
modern retained-mode rendering, no install.

> Status: **early scaffold.** The reactive core (data model → plot primitives →
> renderers) works and is tested; the UI workspace, more data types, import
> formats, and the rose/fabric plot spaces are being built out from here.

## Run (dev)

ES modules run directly — no build step for development. Serve over http (ESM
won't load from `file://`):

```bash
npx serve .      # or: python -m http.server
# then open the printed URL
```

Drag the net to rotate it.

## Build (single-file deploy)

```bash
npm install && npm run build      # → dist/osjs.html (self-contained, offline)
```

## Test

```bash
npm test          # node --test — validates the pure core (model, primitives, parse)
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md). In one breath: a **reactive Project of
typed DataItems**, each a pure source of **declarative plot primitives** via
`contribute(space)`; per-space **renderers** consume them (the stereonet renderer
delegates DOM diffing to bearing's retained scene). The clean data-in / render-out
seam means the same core powers the standalone app, an auditable Works surface,
and the `@gcu/stereonet` notebook cell.

## Lineage

OSJS is the web rewrite of OpenStereo (A. Endlein, sole maintainer). OpenStereo
lives on as the honored ancestor; active development continues here, under the
GCU / gentropic umbrella.

## License

[MIT](LICENSE)
