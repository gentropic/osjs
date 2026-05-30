# OSJS architecture

The design we converged on, and *why* — so it survives across sessions and
contributors.

## The core idea (kept from OpenStereo)

OpenStereo's good bones: **a data item is a source of "encapsulated plot
commands," and a renderer consumes them.** New data type → emit the right
commands → done; the renderer never has to know about it. That seam is correct
and we keep it. What we change is everything *around* it.

## What we changed (and why)

| OpenStereo (PyQt) | OSJS | Why |
|---|---|---|
| `DataItem(QTreeWidgetItem)` — model fused to the UI tree | Pure reactive model; the tree is a *view* | Headless, testable, retargetable (the reason this is a JS rewrite) |
| Open `*PlotData` class hierarchy grows per visual | **Closed primitive vocabulary** everything composes from | Renderers stop growing; new data types compose existing primitives |
| compute + style + assembly tangled in one `plot_*` method | Three layers: geometry/stats (bearing) · style cascade · assembly | Each concern testable in isolation |
| re-plot wholesale (matplotlib immediate-mode) | retained-mode + signals → incremental | Smooth interaction without fighting the renderer |

## The layers (the seam)

```
core/      data model + plot-primitive contribution   — PURE, no DOM, no I/O
  model.js      Project, DataItem → contribute(space) → Primitive[]   (reactive via sideact)
  primitives.js the closed vocabulary: point, polyline, greatCircle, smallCircle, fill, text, raster
render/    per-space renderers (consume primitives, own the projection)
  net.js        → @gcu/bearing Stereonet; delegates DOM diffing to bearing's retained scene
  (rose.js, fabric.js to follow)
io/        load/save adapters — THE SEAM
  parse.js      text → measurements; later: CSV column-mapping → typed items
ui/        rails workspace, tree, properties, panels — VIEWS over the model   (to build)
```

## Primitives

A `contribute(space)` returns `Primitive[]`. A primitive is a plain object:
`{ kind, …geometry (direction cosines), style, source }`. `source` is
`{ item, datum }` for hit-testing / selection. The vocabulary is **closed and
small** — adding a `kind` is a deliberate act, not the default move. Everything
(faults, slip arrows, dihedra) decomposes into these.

The renderer owns the projection; the model speaks geometry. This is what makes
the same items render to the net, the rose, and the fabric diagram, and (later)
to canvas / WebGL / PDF — by swapping the renderer, not the model.

## Why bearing.js is the net backend

Bearing's `Stereonet` already keeps a retained item scene that diffs to the DOM.
So the net renderer maps primitives → bearing draw-calls and **lets bearing do
the diffing** — we do not reimplement a scene graph. (Open follow-up: a couple of
primitive-level methods on bearing — point-at-dcos, polyline3d — would make it an
even cleaner primitive backend; `net.js` currently maps point→line,
greatCircle→plane, smallCircle→cone, and TODOs polyline/fill/raster.)

## Three faces, one core

- **Standalone app** = core + ui + io/file
- **Auditable Works surface** = core + ui + io/vfs (swap the I/O adapter)
- **`@gcu/stereonet` notebook cell** = a thin slice of core

The clean `io/` seam is what makes that real — keep load/save out of `core/`.

## Stack

`@gcu/bearing` (engine) · `@gcu/sideact/signals` (reactivity) · `@gcu/rails`
(docked workspace — panels never reparent, so the net SVG survives drags) ·
`@gcu/menu` + `@gcu/dialog` (chrome) · `@gcu/switchboard` (theme). All zero-dep,
**vendored** under `vendor/` (see `vendor/README.md`). esbuild for the single-file
build; dev needs no build (ESM runs directly).
