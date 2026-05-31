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

## Optional dessert
- Richer **markdown** in annotations (bold/italic/code, multiline) — currently plain.
- **Export polish**: legend + title/caption baked into SVG/PNG output.
- **Rails / dockable panels** (@gcu/rails) — replace the fixed CSS-grid layout.
- **OSOS demo easter eggs** (the bearing.js CRT demo, not the OSJS app): doom /
  adventure console, field-geology FPS, olodoom, anaglyph mode.
