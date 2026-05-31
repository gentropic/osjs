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

## Optional dessert
- Richer **markdown** in annotations (bold/italic/code, multiline) — currently plain.
- **Export polish**: legend + title/caption baked into SVG/PNG output.
- **Rails / dockable panels** (@gcu/rails) — replace the fixed CSS-grid layout.
- **OSOS demo easter eggs** (the bearing.js CRT demo, not the OSJS app): doom /
  adventure console, field-geology FPS, olodoom, anaglyph mode.
