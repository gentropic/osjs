# OSJS roadmap — beyond OpenStereo parity

OpenStereo parity is complete; the OS³ experience layer (undo/redo, annotations,
first-run samples) is in. What follows is *net-new* territory — things neither
reference tool does — plus optional dessert.

## Architecture: the figure-composer (→ eventual `@gcu/compo`)

What we've built is, in effect, a **domain figure-composer**: an overlay of
positioned, draggable elements (annotations, tables, legend, title, page frame)
over a plot, in domain coordinate spaces — **attitude** (data-anchored, follows
rotation) and **figure** (page-fixed) — with selection, persistence, and export to
SVG/PNG/print. Closest analogues: QGIS's print composer, matplotlib's figure.
*Not* a general vector editor (Fabric/tldraw/Konva) — those work in generic scene
space; ours is tied to the projection. Rolling our own (zero-dep) was the right
call for the domain.

**Current architecture: DOM is the source of truth; SVG export is a projection of
it** (a DOM→SVG walker + a few model-aware emitters). This is pragmatic — the
browser computes layout (flex/grid tables, the legend) for free, and we read it —
but it's fragile at the edges (the legend/table/page-frame export bugs we chased
were all "the projection didn't match the DOM"). Net is embedded SVG directly.

**North star: a declarative overlay scene.** The net already does this right —
`contribute(space) → primitives → per-space renderers`. The overlay does *not*; it
is imperative DOM. The target is to put overlay elements on the same model: each
emits typed primitives (text/rect/line/group, in a coordinate space) from one
source of truth, rendered to **DOM** (interactive) *and* **SVG** (export) by two
renderers. That kills the scrape-the-DOM fragility, makes export first-class, and
— not coincidentally — yields the clean, stable core to extract.

**Extraction is demand-driven, not now.** Once that model is stable *and* a second
consumer wants it (the rose/fabric/ternary surfaces, other GCU charts, auditable
Works figures), lift it into **`@gcu/compo`** — overlay layer + element/primitive
model + coordinate-space adapters + DOM & SVG renderers + the context-menu/toolbar
chrome. Until then it lives in OSJS and we keep the API churning freely.

**Phasing.** (1) ✅ *Modularize* — carved `render/figure-export.js` + `ui/selection.js`
out of `app.js` without behavior change. (2) *Scene-ify* the simple elements onto
declarative primitives + a shared SVG renderer (`render/scene.js`): ✅ vocabulary +
`sceneToSVG`/`primsToMarkup` (unit-tested); ✅ annotations/title (`annoScene`) and ✅
legend (`legendScene`, layout modelled — fixes gradient bars the style-scrape never
captured) now emit primitives from the model + `net.place`, with the export
SKIPping their live DOM (`.annolayer`/`.decorlayer`). Page frame is just the crop
boundary (not drawn). Layout-heavy tables still read rendered geometry (emitPanel)
until their layout is modeled. (3) Unify the DOM renderer onto the same primitives
(currently DOM is still hand-built; scene is export-only). (4) Extract `@gcu/compo`
when a second surface needs it.

## Selections (flagship idea)

Selection-as-interaction — a GIS/illustrator paradigm stereonet tools never adopted.
Pick a region of the net, then act on the data inside it.

**Modalities** (easy → hard):
- **Cone / small circle** — axis + angular radius; select data within that angular
  distance (a dot-product threshold). Spherically exact; doubles as a query
  ("everything within 20° of this axis").
- **Freehand lasso** — drag a loop; select points whose *projected* position is
  inside (screen-space point-in-polygon). Intuitive; view-dependent (WYSIWYG).
- **Spherical polygon** — click vertices on the sphere; point-in-spherical-polygon
  (winding / signed angle). Rigorous, rotation-independent, fiddliest.
- **Great-circle band** — within X° of a plane (cheap bonus).

**What it unlocks** (the payoff):
- **Manual set tagging** — select a cluster, assign a category value → feeds the
  existing categorical colour-by. The manual complement to cluster.fitSets.
- Extract selection → new layer · recolour / hide / delete · exclude outliers ·
  stats on just the selection · invert / clear.

**Architecture**: new `select` interaction mode (alongside measure/rotate/pick);
a transient per-datum selection set; highlight by re-emitting selected points with
a selected style (same path as colour-by); lasso path drawn in screen space; cone
via sn.cone + angular test; hit-test points via sn.project (dcos→screen).

**Open questions**: lasso view-dependence (fine — WYSIWYG); selection scoped to the
active layer vs all visible (lean: active layer, since tag/extract want one dataset).

**Phasing**: P1 ✅ = cone + lasso + rect + actions (extract / tag-to-set with a
chosen/new column / stats / invert / clear), Shift=add / Alt=subtract.
P2 ✅ = spherical polygon (`g` — click vertices, click-first/double-click to close,
Esc cancels; winding test in `sphInside`) + great-circle band (`d` — click a
plane's pole, drag the half-width; `|angle(datum,pole) − 90°| ≤ w`). Both are
rotation-independent (test on dcos, not screen). Spherical rectangle (trend/plunge
box) intentionally skipped — the screen-space rect covers that ergonomically and a
lat/lon box adds trend-wraparound fuss for little gain.
P3 (maybe): per-tool combine buttons (vs the Shift/Alt modifiers), selection
scoped to active-layer vs all-visible toggle, by-attribute select (where col = x).

## Table cell-range selection + anchored paste (spreadsheet model)

A *second*, distinct selection space from the net flagship above: **table cells**,
not orientations. Today: copy → TSV (done), paste → **append** rows (done). Next:
make the table behave like a spreadsheet so paste can **replace** in place.

- **Cell / range selection** — click a cell to anchor; drag or Shift-click to extend
  a rectangular range (incl. whole-row via the `#` gutter, whole-column via the
  header). Reuses nothing from the net selection — it's grid coordinates.
- **Anchored paste** — with a TSV/CSV on the clipboard, paste writes the block with
  its top-left at the anchor cell, **overwriting** the covered cells; rows past the
  bottom grow the table (so today's append = "anchor at the end / no selection").
  Geometry-vs-data mapping follows the *column position* the paste lands on, so you
  can drop a block of dips into the dip column without touching dip-dir.
- **Copy** then narrows to the selected range (currently whole table).
- **Fit check** — only treat it as a range-replace when the pasted shape sits inside
  (or just past) the table; otherwise fall back to append + notify, so a stray paste
  never silently clobbers data.
- Delete/clear the selected range; fill-down; maybe column reorder — all natural
  once cell-range selection exists.

Keep it clearly separate from the net Selections flagship in code and UI (one is
dcos-space, one is grid-space) even though both are "select → act".

## Composition overlay → map-composer (flagship #2)

Realisation: floating tables, draggable annotations, on-plot legend/title, and a
"map composer" are **one feature** — an interactive overlay layer over the plot
hosting positioned, draggable elements. The composer is that overlay matured (a
stereonet figure composer, à la QGIS print composer — novel for stereonets). Also
fixes the "linked identify pops to another tab" gripe: the table can float on the
projection view.

**Overlay layer (OSJS-owned; bearing stays the plot engine):** abs-positioned,
draggable elements over the net; repositioned on rotation. Element types, growing:
- **annotations** ✓ (built: draggable, multi-space, leader+arrow, locks, background)
- **table-on-plot** ✓ (built: float a layer's table; drag / minimise / close / resize;
  per-table edit; figure-space, rotation-fixed; config in item params, persists)
- **legend** (built — draggable + toggleable auto-decoration). **scale bar / north
  arrow** still to do. (Titles are just prominent figure-anchored annotations now —
  same machinery + full inspector; a title carrying a leader option is a harmless
  quirk of the reuse.)
- **data-point labels** (NEW) — per-datum text labels pinned to points (attitude
  space, follow rotation): show a column value or the attitude beside a point, with
  leader lines + collision/declutter handling. The point-label half of "a stereonet
  is a tiny GIS". Reuses annotation rendering; new bit is *per-datum* generation +
  declutter. Likely a layer toggle ("label by column") + individually movable labels.

**Composition editing — multi-select + align/distribute** (NEW; needed once a figure
has several overlay elements): rubber-band / shift-click to select multiple overlay
elements (annotations, tables, legend, labels), then **align** (left/right/top/bottom/
centre-h/centre-v) · **distribute** (even spacing) · arrow-key nudge · snap to guides /
each other / the net centre · move & lock as a set. Distinct from *data* selection
(the Selections flagship tags measurements); here the objects are composition
elements. Needs a shared overlay-selection model + an align toolbar shown when ≥2 are
selected. Print/preview mode is the natural companion.

**Preview / print mode** ✓ (built): a header toggle adds `body.preview` → hides
drag handles, resize grips, panel buttons, column grips, selection outlines, the
engineering-grid background and the side/inspector/gutter chrome, leaving a
camera-ready figure. `print` button enters preview then `window.print()`; an
`@media print` stylesheet shows only the active plot full-page (white, `@page`
margins). Still to do: composed **SVG/PNG export** that bakes the HTML overlay
(annotations/tables/legend) into the vector output — today's SVG/PNG buttons emit
bearing's net only; print is the only path that captures the full composition.

**Figure / page space** (NEXT — ties preview, the viewport, and a page model
together): treat the composition as a **figure on a page**, not just an overlay on
a fixed net. Pieces:
- **Page-space navigation** ✓ (built — pan & zoom). Scroll = zoom-to-cursor,
  middle-drag = pan, ⤢ = fit/reset. Done host-side as a CSS transform on the net
  SVG: because the overlay math is rect-based, the transform composes for free
  (overlays follow via onAfterRender; measure/pick/drag still invert) — **no bearing/
  viewBox change needed**, contrary to the earlier assumption. `net._vp{tx,ty,scale}`,
  `zoomAt`/`panBy`/`resetViewport`. Not yet persisted (it's a view, like rotation).
  TODO refinements: keyboard/space-pan, touch pinch, fit-to-content, persist per tab.
- **Figure configuration** ✓ (first slice) — a toggleable **page frame** (aspect:
  square/4:3/3:4/16:9/A4 ↔ portrait) behind the net that pans/zooms with it,
  **background** (paper/transparent/theme), and **export DPI** (PNG renders at
  dpi/96). Persisted. Preview restyles the figure (rails stay); print reveals only
  the plot subtree with no reflow.
  TODO to finish the page model:
  - **Print/export clipped to the page bounds** at the chosen size + DPI — today
    print shows the figure where it sits on screen (coherent, but not page-fitted)
    and PNG/SVG are net-only. Need to map the page-frame rect → paper, and bake the
    overlay (annotations/tables/legend) into the raster/vector.
  - **Explicit page size** (mm/in, named presets A4/Letter/…) not just aspect, so
    DPI×size gives real output pixel dimensions.
  - **Composed export** ✓ (built). Two render paths:
    - *native SVG* (`nativeFigure()`) — real `<text>`/`<rect>`/`<line>` from a
      generic DOM→SVG walker; no foreignObject → editor-portable + no canvas taint.
      SVG + PNG buttons use this; page-frame crop + exportDpi honored.
    - *foreignObject* (`composeFigureSVG()`) — exact browser render, used by print
      (rendered in a hidden iframe, fits one A4 page).
    Remaining polish: **embed fonts** (data-URI) for byte-identical self-contained
    output (today fonts are referenced by family → editors substitute); carry the
    injected per-datum opacity/dash CSS into the embedded net; native legend ramp
    gradients (currently the gradient bar is a div bg → may flatten).
- Multiple figures / pages eventually (a project holds several composed views) —
  the QGIS-layout-manager analogue. Defer until single-page is solid.
This is where preview/print graduates from "hide chrome" to "a real page you arrange
on and export at a chosen size".

**Annotation coordinate spaces** (per anchor AND leader, independently):
- **attitude** [trend, plunge] — sticks to a direction, moves with rotation.
- **figure** (normalised ~−1…1 about centre, extends beyond) — pixel-free, fixed
  under rotation, for titles/captions/legends. (Drop raw-pixel screen space.)
Draggable in whichever space (drag → unproject for attitude, → normalised for figure).

**Linked identify / brushing** (needs co-visibility, hence the overlay): click a
plotted element → flash + scroll its table row; hover a row → flash the element.
Selection precursor (shares hit-testing via sn.project + per-datum highlight).

**Quick win, independent:** rgb colour-by mode (read literal colours from a column)
— `_colorFn` already maps per datum; just return the cell value.

## Plot viewport — pan & zoom (infrastructure)

Today the net is fixed in size and position. The plot area is *both* a data-analysis
surface and a composition canvas, so it should pan and zoom — magnify a dense cluster
to pick it apart, or push the net aside to lay out a figure.

**Key distinction — two orthogonal transforms:**
- **Rotation (sphere orientation)** — the arcball, already built. Changes the
  *projection* (what's where on the net).
- **Viewport (camera over the canvas)** — a 2D affine (translate + uniform scale)
  applied *after* projection. Pure view; changes **no** projection/stats math. This
  is the new piece.
Keeping them separate matters: zooming must not touch the geology, and "reset
orientation" (just shipped) stays distinct from a new "reset/fit view" (zoom+pan).

**What it unlocks:**
- *Analysis*: zoom into a tight cluster / girdle to disambiguate overlapping points;
  pan to inspect the margin of a dense contour.
- *Composition*: treat the area as free canvas — net off to one side, tables/legend/
  title arranged around it (feeds the map-composer). A pannable/zoomable canvas is
  the natural substrate that could eventually host **multiple** nets/rose/fabric.

**Architecture:**
- Apply the viewport as a wrapping `<g transform="translate() scale()">` (or SVG
  `viewBox` manipulation) — likely a small bearing addition (`setViewport`/`viewport`)
  so the engine owns one transform; host drives it. Rotation stays in the projection
  pipeline, untouched.
- **Overlay must compose with it.** `place()`/`locate()` currently map via `sn.project`
  + `k = svgWidth/sn.size`; with a viewport they must fold in (tx,ty,scale) so
  annotations, leader handles, and floating tables track under zoom/pan. Cleanest:
  thread the viewport through place/locate (and the annolayer positioning) rather than
  CSS-transforming the overlay separately (keeps hit-tests exact).
- **Stroke/scale policy**: decide what scales vs stays constant — `vector-effect:
  non-scaling-stroke` for grid/great-circles + constant-size point markers & text is
  usually what you want (zoom reveals *spatial* separation, not fatter lines).
- **Interaction bindings** (the crowded part): wheel = zoom-to-cursor; pan via
  middle-drag or space-drag (design-tool convention) or a dedicated pan affordance.
  Must coexist with select-drag, measure-drag, and Alt-rotate — pick non-conflicting
  gestures (wheel is free; space-drag is free). A "fit" / "reset view" control +
  shortcut alongside the ⟲ reset-orientation button.

**Phasing**: P1 = wheel-zoom-to-cursor + space/middle-drag pan + fit/reset, overlay
composing correctly, non-scaling strokes. P2 = composer-grade free canvas (and the
multi-plot question — one zoomable canvas vs per-space viewports).

**Open questions**: per-tab viewport (net vs rose vs fabric) or shared? Persist
viewport in the project file (likely yes, it's part of a saved figure)? Does the
map-composer want one big canvas hosting several plots, or stays one-plot-per-tab?

## Net orientation — readout + go-to

The net's rotation (arcball / `setCenter`) is a full SO(3) view orientation, but
right now it's invisible: you can spin to an oblique view and have no idea *what*
you're looking at, and no way to return to a named orientation. Two halves:

- **Readout** (cheap, low-risk — do first): show the current view orientation in
  the footer, live as you rotate. Updates on `onAfterRender` like the cursor read-out.
- **Go-to** (the fun half): type an orientation → set the net rotation to it. A small
  footer input next to the read-out; Enter sets, the read-out then echoes it.

**The design decision — how to represent 3 DOF.** The view orientation has three
degrees of freedom, so the read-out/input must too:
- *centre attitude + roll* — trend/plunge of the direction at the net centre (2 DOF)
  plus an in-plane roll angle. Intuitive ("looking down this line, rotated N°").
- *dip-dir / dip / rake of the view frame* (the user's suggestion) — one triple that
  captures all three at once, via `frameFromDipDirRake` (the Leapfrog / Isatis Neo
  convention the user actually likes; **NOT** Bunge). Compact and already the house
  convention for orienting a frame.
Lean toward dip-dir/dip/rake for symmetry with the rest of the rotation tooling, but
pin the convention deliberately and validate against a reference before shipping
(the rake sign/zero is exactly the thing that's easy to get subtly wrong).

**What's needed:** bearing already has `frameFromDipDirRake` (triple → matrix) for
the *go-to*; the *read-out* needs the inverse (current rotation matrix → dip-dir/dip
/rake), which may be a small bearing addition next to `euler.js`/`rotation.js`.
Relate to the existing context-menu **"set centre here"** (that's the 2-DOF case, no
roll); go-to is its full-orientation sibling. Persist as part of the saved view
(alongside the viewport). Bonus: named presets (down-plunge of the mean, perpendicular
to the girdle, "reset") become one-click — and tie straight into the derived-element
menus ("set centre to V1", "view down the fold axis").

## Context menus (interaction infrastructure)

Right-click (and long-press on touch) menus, context-sensitive to what's under the
cursor. A big discoverability + speed win — most of the actions below already exist
behind toolbar buttons, inspector controls, or keyboard shortcuts; a context menu
just puts them where the hand already is. Build once as a reusable OSJS-owned
component (positioned popup, submenus, Esc/click-away dismiss, keyboard nav,
long-press on touch); zero-dep, same `h`/signal idiom as the rest of the shell.

**Principle: a menu on *everything*.** Anything the user can point at — a datum, a
derived primitive, a legend swatch, a rose petal, a table cell, an annotation, an
axis label — should answer a right-click with the actions that make sense *for that
thing*. The default question for any new element is "what would I want to do to this
here?", and the default answers are almost always some of: **copy** (in a sensible
format), **extract / promote to a real layer**, **hide/show**, **style**, **use as
input** (set centre, unfold about, rotate by). Empty menus are a smell; reach for
this rather than burying actions in panels.

**Data tree** (right-click an item or group):
- rename · duplicate · delete · show/hide · solo (hide siblings)
- group / ungroup · move to group
- quick colour · change colour-by · change item type (plane↔pole)
- zoom/centre on this layer · open its table · stats popup · export this layer
- float its table over the plot · **reset its floating table** (size + position to
  default) — recovery when a table is dragged/resized past where its handles are
  reachable. Also available by right-clicking the panel itself.
- (on a group) collapse/expand all · merge children

**Plot area** (right-click the net — branch on the hit):
- *on a datum / primitive*: select its layer · identify (flash table row) · add to
  selection · hide that layer · colour-by this datum's value
- *on empty net*: add measurement here (plane / line at the cursor attitude) ·
  add annotation here · **set centre here** (rotate that direction to centre) ·
  reset orientation · fit / zoom · projection toggle · export SVG/PNG
- *construct-from-plot*: plane / line / intersection / small-circle from the
  picked point(s) — already wired through measure mode; expose it here too
- *with an active selection*: extract → new layer · tag-to-set · recolour · invert
  · clear (ties into the Selections flagship)

**Derived / computed elements** (the part most plotting tools never make
actionable — make every computed primitive a first-class, right-clickable object):
- *eigenvectors* (V1/V2/V3) → **extract as a lines layer** (the three principal
  axes as a dataset) · copy each as trend/plunge or dcos · plot V3 as the best-fit
  girdle plane · set centre to an eigenvector · use V3 as the unfold/rotation axis.
- *Fisher mean (+ α95 cone)* → extract the mean as a one-point line layer · copy
  the attitude · extract the α95 small circle as a small-circle layer · set centre
  to the mean.
- *best-fit great circle / fold axis* → promote to a planes / lines layer · copy ·
  unfold the dataset about it.
- *density peak(s)* (contour maxima) → drop a measurement at the peak · extract
  peaks as a layer · copy the modal attitude.
- *rose petal* → select the data in that bin · set it as the rose start · copy the
  bin range/count. *fabric point* (Woodcock/Vollmer) → select / identify its layer.
- General move: "**promote this computed thing to a real dataset**" so it can then
  be styled, exported, fed back as input — the computed overlay stops being a
  dead-end. (Mechanically: most of these already exist as `params`/stats outputs;
  the menu just wraps them in a `project.add(...)` with the right payload.)

**Clipboard / copy-as** (cross-surface, a recurring win):
- *copy attitude as…* — right-click a point on the net → copy the cursor (or a
  picked datum's) attitude in a chosen format: **trend/plunge** (line/point),
  **dip-dir/dip** or **strike/dip** (plane), the **pole** to that plane, **dcos**
  `[x,y,z]`, lat/lon. A submenu of representations off one location.
- copy a datum / selection / whole layer as CSV (the table's columns) · copy stats
  block · copy the figure as SVG/PNG (already a button, mirror it here).
- **paste** to create: paste trend/plunge or dd/dip text → new measurements in the
  active (or a new) layer; paste an image/SVG onto the composition overlay later.
- format is a small shared "attitude formatter" (line vs plane vs pole vs dcos),
  reusable by the footer read-out, table cells, and export — write it once.

**Cross-cutting**: the menu is context-sensitive (hit-test via the same `dsId`
layer-resolution that select mode uses; detect annotation vs primitive vs empty);
respect the active selection; mobile long-press; suppress the native browser menu
only over the app surfaces. Also a candidate home for rose/fabric/table-specific
actions (e.g. rose: set this bin as start; table: filter by this value).

## QGIS / external-host bridge (a stereonet for a real GIS)

"A stereonet is a tiny GIS" — so closing the loop with an actual GIS (QGIS) is on
theme: a point layer of structural measurements ↔ the interactive net. OSJS is
host-agnostic by design (clean I/O seam), so QGIS is just a third host surface
(like the auditable Works surface). **Keep all GIS specifics — CRS, feature
geometry, Qt — on the plugin side; OSJS never learns the word "QGIS."**

**Tiers (do the cheap one first; only climb when the workflow demands it):**
- **T0 — structured copy/paste (already works).** Copy QGIS's attribute table →
  paste into OSJS (TSV import detects `dip dir`/`dip`); export OSJS → CSV → join
  back. Just needs a documented field-naming convention. ~80% of the value, zero plugin.
- **T1 — thin PyQGIS bridge plugin (no webview).** GIS-aware glue the clipboard
  can't do: map the active/selected point layer's fields → dip-dir/dip, carry
  attributes + a **stable `fid`** as OSJS data columns, hand off to OSJS, and —
  the valuable half — **write back**: an OSJS selection/tag → a `set` field joined
  to features by `fid` ("lasso a cluster on the net → those map points light up").
- **T2 — live two-way.** Only if "they stay in sync" is the actual goal.

**Transport — the part we reasoned through, so we don't relearn it:**
- **Do NOT have a public origin call loopback.** A page on `https://gentropic.org`
  reaching `http://localhost:PORT` is blocked not by CORS (headers are trivial) but
  by **mixed content** (https→http) and **Private Network Access** (Chrome gates
  public→loopback; needs `Access-Control-Allow-Private-Network`, secure context, and
  is being tightened in waves). That's the exact pattern browsers are hardening
  against — fragile, moving target. Avoid it.
- **Two shapes that dodge the whole swamp:**
  1. *Connectionless hosted* — `gentropic.org/osjs` stays a pure web app; QGIS
     exchanges via files/clipboard. The public page never touches localhost. Cleanest
     when live wiring isn't needed.
  2. *Localhost serves BOTH* — the tiny plugin server returns OSJS's bundled
     `dist/osjs.html` **and** the JSON API on the same `127.0.0.1:PORT`. Same origin,
     both http, both loopback → **no CORS, no mixed content, no PNA, no QtWebEngine**.
     One extra route; less friction than fighting the security model.
- **Plain HTTP request/response is enough** (OSJS GETs the layer, POSTs back
  selections/tags). A **websocket** only earns its keep for QGIS *pushing*
  spontaneously (live select-here-highlights-there); `QWebSocketServer` (Qt-native,
  event-loop friendly) or a threaded `http.server`+SSE fallback if so.
- The transport is independent of embedding: pick HTTP-on-localhost now and a future
  docked `QWebEngineView` just points at the same `localhost:PORT` — protocol unchanged.

**What OSJS needs**: a thin **host-bridge** adapter module (connect, small versioned
JSON messages: load-measurements / here's-the-selection / tag), the same concept as
the auditable surface bridge (A-Bus) — one host seam, not two bespoke ones. Plus
carry a stable `fid` column through import → tag/extract → export for round-trip
write-back. Prior art exists (qgSurf, Geotrace, mplstereonet-in-QGIS); OSJS's
differentiator is being the *interactive composer*, not a static plot.

## Optional dessert
- Richer **markdown** in annotations (bold/italic/code, multiline) — currently plain.
- **Export polish**: legend + title/caption baked into SVG/PNG output.
- **Rails / dockable panels** (@gcu/rails) — replace the fixed CSS-grid layout.
- **OSOS demo easter eggs** (the bearing.js CRT demo, not the OSJS app): doom /
  adventure console, field-geology FPS, olodoom, anaglyph mode.
