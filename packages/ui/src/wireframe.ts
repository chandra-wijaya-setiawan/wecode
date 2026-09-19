/** The Wireframe port: a tree of boxes drawn as an SVG picture of itself.
 *
 *  This is a projection and not a layout engine. Every box in the tree states where it is
 *  and how big it is, and the only thing this module does with those numbers is write them
 *  into an SVG. Nothing here stacks, flows, centres, grows or shrinks a box, because the
 *  moment it did there would be two answers to "where is that box" — the tree's and the
 *  renderer's — and a wireframe whose coordinates are not the ones you asked for is worse
 *  than no wireframe at all.
 *
 *  What that buys is a picture a caller can check against arithmetic it did itself: whoever
 *  computed the tree — a terminal's box model, a spec, a person with a ruler — keeps the
 *  authority over the geometry, and this file keeps none.
 *
 *  Because it lays nothing out, it must refuse a tree that contradicts itself rather than
 *  quietly repair it. A negative size and a child that hangs outside its parent are both
 *  statements a projection cannot honour, so they are `WireframeError` and not a clamp. */

/** Where a box is, in the tree's own units. The origin is the top left, x grows right and
 *  y grows down — SVG's convention, and a terminal's. Coordinates are absolute, not
 *  relative to the parent: a box says where it is, full stop, so reading one row of the
 *  tree never means adding up the rows above it. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One box, and the boxes inside it. `title` is the caller's words — no product noun lives
 *  in this file — and a box with none is drawn as an outline and nothing else. */
export interface Box {
  readonly at: Rect;
  readonly title?: string;
  readonly children?: readonly Box[];
}

export class WireframeError extends Error {}

/** A title sits this far in from its box's top left, on a baseline that clears the font.
 *  These are the only numbers this module owns, and they decide type and nothing about
 *  where a box is. */
const PAD = 6;
const FONT = 12;

const xml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const states = (at: Rect): void => {
  for (const [name, n] of Object.entries(at)) {
    if (!Number.isFinite(n)) throw new WireframeError(`${name} is ${String(n)}`);
  }
  if (at.width < 0 || at.height < 0) {
    throw new WireframeError(`a box cannot be ${at.width} by ${at.height}`);
  }
};

/** A child outside its parent is the one tree this cannot draw honestly: either the child's
 *  coordinates are wrong or the parent's are, and picking one is a layout decision. */
const within = (parent: Rect, child: Rect): void => {
  const fits =
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height;
  if (!fits) {
    throw new WireframeError(
      `a child at ${child.x},${child.y} ${child.width}x${child.height} ` +
        `does not fit its parent at ${parent.x},${parent.y} ${parent.width}x${parent.height}`,
    );
  }
};

/** The elements for one box and everything under it, parent first so a child draws over the
 *  outline it sits in — document order is paint order in SVG, and the tree's order is the
 *  one it was handed. */
function elements(box: Box, depth: number): string[] {
  states(box.at);
  const { x, y, width, height } = box.at;
  const out = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" ` +
      `fill="none" stroke="#000" data-depth="${depth}"/>`,
  ];
  if (box.title !== undefined) {
    out.push(
      `<text x="${x + PAD}" y="${y + PAD + FONT}" font-family="monospace" ` +
        `font-size="${FONT}">${xml(box.title)}</text>`,
    );
  }
  for (const child of box.children ?? []) {
    within(box.at, child.at);
    out.push(...elements(child, depth + 1));
  }
  return out;
}

/** The tree as an SVG document, sized to the root box. The viewBox is the root's own rect
 *  rather than one starting at 0,0, so a tree whose root sits at an offset draws where it
 *  says it does instead of being slid into the corner. */
export function wireframe(root: Box): string {
  const { x, y, width, height } = root.at;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="${x} ${y} ${width} ${height}">`,
    ...elements(root, 0),
    "</svg>",
    "",
  ].join("\n");
}
