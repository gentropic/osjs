/**
 * @module core/primitives — the closed, composable plot-primitive vocabulary.
 *
 * A data item's contribute(space) returns an array of these. Renderers consume
 * them; the vocabulary is intentionally small and CLOSED — every visual (faults,
 * dihedra, slip arrows, …) decomposes into these, so renderers never grow and
 * new data types compose what's here. Each primitive carries `source`
 * ({ item, datum }) for hit-testing / selection.
 *
 * Geometry is in direction cosines (unit [x,y,z]); the per-space renderer owns
 * the projection. Keep this list tiny — adding a kind is a deliberate act.
 */

const prim = (kind, props, style, source) => ({ kind, ...props, style: style || {}, source: source || null });

/** A marker at a single direction. */
export const point = (dir, style, source) => prim('point', { dir }, style, source);

/** A 3-D polyline (array of unit vectors); renderer projects + clips. */
export const polyline = (points, style, source) => prim('polyline', { points }, style, source);

/** A great circle, given its pole. */
export const greatCircle = (pole, style, source) => prim('greatCircle', { pole }, style, source);

/** A small circle (cone) about an axis, half-angle in degrees. */
export const smallCircle = (axis, angle, style, source) => prim('smallCircle', { axis, angle }, style, source);

/** A filled region (e.g. a density raster / dihedra field). */
export const fill = (grid, style, source) => prim('fill', { grid }, style, source);

/** A text label anchored at a direction. */
export const text = (dir, content, style, source) => prim('text', { dir, content }, style, source);

/** A scalar raster over the projected disk (density / dihedra). */
export const raster = (grid, style, source) => prim('raster', { grid }, style, source);

/** Density contour lines over a set of directions (renderer owns the kernel). */
export const contour = (dcos, opts, style, source) => prim('contour', { dcos, opts: opts || {} }, style, source);

/** Filled density raster (heatmap) over a set of directions. */
export const heatmap = (dcos, opts, style, source) => prim('heatmap', { dcos, opts: opts || {} }, style, source);

export const KINDS = ['point', 'polyline', 'greatCircle', 'smallCircle', 'fill', 'text', 'raster', 'contour', 'heatmap'];
