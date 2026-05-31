# OSJS roadmap — beyond OpenStereo parity

OpenStereo parity is complete; the OS³ experience layer (undo/redo, annotations,
first-run samples) is in. What follows is *net-new* territory — things neither
reference tool does — plus optional dessert.

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

**Phasing**: P1 = cone + lasso + actions (extract / tag-to-set / recolour / delete /
invert / clear). P2 = spherical polygon + great-circle band.

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
- **Page-space navigation** — pan & zoom the figure as a canvas (see "Plot viewport"
  below; the viewport transform is the substrate). Scroll/zoom a page larger than
  the net, lay elements in the margins, fit-to-page.
- **Figure configuration** — page size / aspect / orientation, margins, background
  (paper white vs transparent vs themed), a visible page frame to compose within,
  and DPI/scale for export. Persisted in the project.
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

## Context menus (interaction infrastructure)

Right-click (and long-press on touch) menus, context-sensitive to what's under the
cursor. A big discoverability + speed win — most of the actions below already exist
behind toolbar buttons, inspector controls, or keyboard shortcuts; a context menu
just puts them where the hand already is. Build once as a reusable OSJS-owned
component (positioned popup, submenus, Esc/click-away dismiss, keyboard nav,
long-press on touch); zero-dep, same `h`/signal idiom as the rest of the shell.

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

## Optional dessert
- Richer **markdown** in annotations (bold/italic/code, multiline) — currently plain.
- **Export polish**: legend + title/caption baked into SVG/PNG output.
- **Rails / dockable panels** (@gcu/rails) — replace the fixed CSS-grid layout.
- **OSOS demo easter eggs** (the bearing.js CRT demo, not the OSJS app): doom /
  adventure console, field-geology FPS, olodoom, anaglyph mode.
