/** The Wireframe port: a tree of boxes drawn as an SVG picture of itself.
 *
 *  This is a projection and not a layout engine. Every box in the tree states where it is
 *  and how big it is, and the only thing this module does with those numbers is write them
 *  into an SVG. How big that SVG is drawn is a separate question, answered by a cell on the
 *  document and not by arithmetic on any box: a tree counted in terminal cells comes out
 *  legible with every coordinate in it still the one the tree stated. Nothing here stacks,
 *  flows, centres, grows or shrinks a box, and nothing wraps or truncates a row, because the
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

/** One box, the lines it holds, and the boxes inside it. `title` is the caller's words —
 *  no product noun lives in this file — and a box with none is drawn as an outline and
 *  nothing else. `rows` is what the box says: the lines a screen would print in it, in the
 *  order it would print them, one per row of the grid. */
export interface Box {
  readonly at: Rect;
  readonly title?: string;
  readonly rows?: readonly string[];
  readonly children?: readonly Box[];
}

export class WireframeError extends Error {}

/** How big one cell of the tree's grid is drawn, in pixels.
 *
 *  A tree of a terminal screen counts in cells — 80 across, 30 down — and a picture 80 wide
 *  is a thumbnail nobody can read. The cell is the one conversion between the two, and it
 *  is applied where SVG already has somewhere to put it: the document's `width`/`height`
 *  against a `viewBox` that stays in the tree's own units. So the picture is as big as a
 *  terminal at that cell, and every coordinate inside it is still the number the tree
 *  stated — a cell cannot move a box, because no box is ever multiplied by one.
 *
 *  It is a parameter and not a constant because the caller knows its font, and a cell is
 *  not square: a terminal row is about twice as tall as a column is wide, so a cell that
 *  ignored the aspect would draw every box the wrong shape. A caller that means user units
 *  passes a 1x1 cell. */
export interface Cell {
  readonly width: number;
  readonly height: number;
}

/** The cell a caller gets when it does not say: roughly a monospace terminal's, so the
 *  common case — draw me this screen — is legible without the caller measuring type. */
export const CELL: Cell = { width: 8, height: 16 };

/** Type, as a fraction of the row it sits on: a little under, so a row clears the one below
 *  it. In the tree's units like everything else, and the only number this module owns — it
 *  decides type and nothing about where a box is. */
const FACE = 0.8;

/** A row of text, made to occupy exactly the cells it occupies in a terminal.
 *
 *  A monospace glyph is about six tenths as wide as it is tall, and the grid it is being
 *  drawn onto is a terminal's, whose cells are about half as wide as they are tall. Left to
 *  the font, an eleven-character row would end well short of the eleventh cell, and a
 *  picture whose text does not reach where the screen's text reaches is a picture that
 *  cannot be read against the screen. `textLength` says the one thing the tree knows and
 *  the font does not: how many cells these characters take. An empty row says nothing and
 *  is given no length, because a length of nought is a degenerate one. */
const cells = (line: string): string =>
  line.length === 0 ? "" : ` textLength="${line.length}" lengthAdjust="spacingAndGlyphs"`;

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
  const lines = [...(box.title === undefined ? [] : [box.title]), ...(box.rows ?? [])];
  lines.forEach((line, row) => {
    out.push(
      `<text x="${x}" y="${y + row + FACE}" font-family="monospace" font-size="${FACE}"` +
        `${cells(line)} data-row="${row}">${xml(line)}</text>`,
    );
  });
  for (const child of box.children ?? []) {
    within(box.at, child.at);
    out.push(...elements(child, depth + 1));
  }
  return out;
}

/** The tree as an SVG document, sized to the root box. The viewBox is the root's own rect
 *  rather than one starting at 0,0, so a tree whose root sits at an offset draws where it
 *  says it does instead of being slid into the corner. */
export function wireframe(root: Box, cell: Cell = CELL): string {
  for (const [name, n] of Object.entries(cell)) {
    if (!Number.isFinite(n) || n <= 0) throw new WireframeError(`a cell cannot be ${n} ${name}`);
  }
  const { x, y, width, height } = root.at;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * cell.width}" ` +
      `height="${height * cell.height}" viewBox="${x} ${y} ${width} ${height}">`,
    ...elements(root, 0),
    "</svg>",
    "",
  ].join("\n");
}
