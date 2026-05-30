# OpenStereo → OSJS feature-parity map

Survey of the OpenStereo (PyQt, `../os`) codebase — `data_models.py`, `os_plot.py`,
`os_auttitude.py`, `io.py`, `os_base.py`, the `*_properties.ui` dialogs, and the
`.openstereo` project format — mapped to OSJS as of this writing.

Legend: ✅ in OSJS · 🟡 partial · ❌ missing · ⭐ OSJS is **ahead** of OpenStereo.

---

## Data item types
| OpenStereo | OSJS |
|---|---|
| Plane (poles + great circles) | ✅ planes |
| Line / lineation | ✅ lines |
| (poles as own item) | ✅ poles |
| Small circle (axis + aperture column, filled cones) | ❌ |
| **Fault** (plane+line+sense → slip arrows, slickenlines, right-dihedra, Michael paleostress) | ❌ |
| **Slope** (kinematic: daylight envelope, lateral limits, friction cones) | ❌ |
| Single plane / line / small-circle / **arc** (constructed elements) | ❌ |
| **Group** (nestable folders in the tree) | ❌ |
| Circular / azimuth (rose-only) | 🟡 (rose works off any item; no dedicated azimuth type) |
| Extract mean/eigenvector/small-circle → new standalone item | ❌ |

## Plots
| | |
|---|---|
| Equal-area / equal-angle | ✅ |
| Upper **and** lower hemisphere | 🟡 lower only |
| Net rotation (numeric azim/plng/rake) | 🟡 arcball drag only, no numeric |
| Grid spacing / cardinal-point / border settings | ❌ (grid fixed) |
| Rose diagram | ✅ |
| Classification: Vollmer P-G-R ternary + Woodcock/Flinn | ✅ (fabric tab) |
| Mohr | ❌ (neither really; OS has none) |

## Contouring / density
| OpenStereo | OSJS |
|---|---|
| Fisher kernel | ✅ |
| Kamb counting (angle / % area) | 🟡 method exists; aperture/% not exposed |
| Auto-k: Robin & Jowett 1986 | 🟡 bearing auto-σ; not the named option |
| Auto-k: Diggle & Fisher 1985 (cross-validation `optimize_k`) | ❌ |
| Contour intervals: min-max / zero-max / **custom list** | 🟡 n-levels only |
| % vs MUD vs σ units + colorbar/legend | ❌ |
| Fill + line colormaps, gradient vs solid, draw-over, resolution | 🟡 single color lines / hue-ramp fill; no cmap choice, no colorbar |

## Rose diagram
| | |
|---|---|
| Bin width, axial | ✅ |
| Offset, 180°(N/S half), arbitrary interval | ❌ |
| Continuous **Munro** weighted counting | ❌ |
| Weight-by-column | ❌ |
| Petals / **kite** / **lines** render styles | 🟡 petals only |
| Mean direction + confidence interval | ❌ |
| Per-item vs shared scaling, rings/diagonals frame | 🟡 shared-max only |

## Statistics
| | |
|---|---|
| Orientation tensor, eigenvalues/vectors | ✅ |
| Woodcock K·C, Vollmer P·G·R·B·C | ✅ |
| Fisher mean, κ | ✅ |
| **α95 confidence cone** | ⭐ OSJS has it; OpenStereo does *not* compute spherical α95 |
| Circular stats (mean, R̄, variance, von-Mises κ̂, confidence) | 🟡 in bearing; not surfaced |
| Mode (density peak) | ❌ surfaced |
| Small-circle / cone axis fit (girdle) | ❌ (bearing may help) |
| Fold axis via plane intersections (β-axes) | ❌ surfaced |
| Bingham | ❌ (neither) |
| Hypothesis tests (Rayleigh/uniformity/common-mean), bootstrap | ⭐ in bearing, not in OS; not surfaced in OSJS |
| Paleostress (Michael, dihedra) | ❌ surfaced (bearing has `fault.js`) |

## Import / export
| OpenStereo | OSJS |
|---|---|
| CSV/TSV with delimiter+header sniff, column mapping | ✅ |
| Column role auto-guess by header name | ✅ |
| Strike(RHR) vs dip-direction convention toggle | ❌ (assumes dip-dir) |
| Rake/obliquity input; small-circle aperture column | ❌ |
| Excel `.xls/.xlsx` | ❌ |
| `.ply` mesh → planes (by face color); `.shp` → azimuth | ❌ |
| Fault import (DD/Dir/TectonicsFP/T-TECTO → 3 linked items) | ❌ |
| Encoding auto-detect (chardet) | ❌ |
| Figure export SVG/PNG(/PDF) | ⭐ OSJS has SVG+PNG buttons; OS relies on matplotlib toolbar |
| Numeric data export | ❌ (OS exports via tools) |
| Item data table view **+ edit** | ⭐ OSJS edit UX is richer |

## Project / persistence
| | |
|---|---|
| Save/load project (`.openstereo` = zip of per-layer JSON + manifest) | ❌ **none in OSJS** |
| Packed vs linked source data | ❌ |
| Copy/paste/export layer properties (JSON) | ❌ |
| Recent projects | ❌ |

## Data tools
| | |
|---|---|
| Rotate data (axis trend/plunge/angle) | ❌ |
| Merge data | ❌ |
| Difference vectors (pairwise) | ❌ |
| Mesh → plane (colored faces) | ❌ |
| Shapefile → azimuth (geographic / UTM) | ❌ |
| Construct from plot: add plane/line/intersection/small-circle/arc from picked points | 🟡 pick-to-add-measurement only |
| Measure tool: angle between two picked points, cone about an axis | ❌ |

## App / UI
| | |
|---|---|
| Checkable tree, per-element sub-layers | ✅ (tree + layers) |
| **Groups / nesting / reordering** | ❌ |
| Tabbed plots | ✅ (net/rose/fabric/table) |
| Per-element **legend with custom text** (`{data}` templating) | 🟡 net legend exists; no per-element custom text |
| Project settings dialog (title/author/description) | ❌ |
| Per-item properties (rich) | ✅ (arguably ahead) |
| Color-by-data column (categorical/ramp) + legend | ⭐ OSJS has it; OpenStereo does not (only rose weight + mesh colors) |
| Theme (light/dark) | ⭐ |
| Language / i18n | ❌ |

---

## Where OSJS already leads
α95 cone · per-datum color-by-data + legend · figure export buttons · editable data
table · reactive retained-mode rendering (no full replot) · light/dark theme ·
and bearing carries unsurfaced power OpenStereo lacks (hypothesis tests, bootstrap,
SO(3) rotations, paleostress, Euler conventions).

## Suggested priority tiers
1. **Project save/load** (JSON; the single biggest functional hole) + **groups** in the tree.
2. **Item types**: small circle, then fault (slip/dihedra/Michael via bearing `fault.js`).
3. **Rose depth** (mean+CI, 180/interval/offset, kite/lines) + **contour depth** (custom intervals, colormap, colorbar, % units).
4. **Import breadth**: strike/dip-dir convention toggle + rake; Excel; fault import.
5. **Data tools**: rotate, merge, difference vectors.
6. **Net tools**: measure-angle, construct-from-plot, numeric rotation, upper hemisphere, grid settings.
7. Surface existing bearing stats (mode, small-circle fit, fold axis, hypothesis tests).
