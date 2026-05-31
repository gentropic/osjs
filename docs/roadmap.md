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
- **annotations** (first/smallest — build the overlay with these)
- **table-on-plot** (float the selected layer's table; draggable / minimise / close)
- **legend**, **title/caption**, **scale/north decorations**

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
