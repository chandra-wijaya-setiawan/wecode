/** A design written down, as a tree diff.ts can read against a capture.
 *
 *  diff.ts compares two captures, which means the only screen it can hold you to is one
 *  you already drew. That catches the regression and misses the whole first release: on
 *  the day a screen is built there is no before, so the thing it was supposed to be lives
 *  in a person's head and in review comments, and the suite asserts substrings again.
 *
 *  A design is that intent stated as data — the boxes a screen ought to draw, each one
 *  saying how big it is, where it sits inside its parent, what letter opens it and what it
 *  holds. `expected` turns it into a `CapturedNode`, so the design is a capture like any
 *  other: the diff reads it with no new vocabulary, and the four words come out meaning
 *  what a reader would want them to mean when the before is a design rather than a
 *  release —
 *
 *    - `gone` — the design asks for a box the screen does not draw;
 *    - `arrived` — the screen draws a box the design never asked for;
 *    - `moved` — the box is drawn, somewhere other than where it was designed;
 *    - `changed` — the box is where it belongs holding something else.
 *
 *  A design places a box inside its parent rather than on the screen, because that is the
 *  one thing a design knows that a capture does not: `Queue` sits to the right of
 *  `Needs you` *within the board*, and moving the board must not rewrite every box under
 *  it. `expected` adds the offsets up on the way down and hands the diff the absolute
 *  numbers it compares.
 *
 *  This decides no geometry of its own. Every number in the tree it returns was written by
 *  the person who wrote the design, and a design that puts a box outside its parent gets a
 *  `clipped` finding out of check.ts rather than a correction out of this module — a
 *  design is a claim about a screen, and a claim can be wrong.
 *
 *  What this is not: a partial match. There is no "any rows here" and no "roughly there",
 *  because a design that declines to say what a box holds cannot be read as a tree, and a
 *  tolerance is a second opinion about the same box. Say what the screen should be, or
 *  leave the box out of the design and read its `arrived`. */
import type { CapturedNode } from "./check.js";
import { diff, type Change } from "./diff.js";
import type { Rect } from "./wireframe.js";

/** Where a box sits inside its parent, in the design's own units. Omitted is the parent's
 *  own top-left, which is what a box that fills its parent wants to say. */
export interface Offset {
  readonly x?: number;
  readonly y?: number;
}

/** One box of a design: what it is called, how big, where inside its parent, and either
 *  what it holds or the boxes it holds it through.
 *
 *  `rows` left out of a leaf is not silence — it is the design saying the box has nothing
 *  to say, which a screen says on an empty line, so that is what the expected tree holds.
 *  A box with `parts` says what it has to say through them and holds no rows of its own,
 *  the same reading check.ts takes. */
export interface Design {
  /** What the box is called — the name a difference will report it under. */
  readonly name: string;
  /** How big it is, in the design's own units. */
  readonly width: number;
  readonly height: number;
  /** Where it sits inside its parent. The root's is where it sits on the screen. */
  readonly at?: Offset;
  /** The letter that should open it, if it should be reachable by one. */
  readonly key?: string;
  /** The lines it should hold, its own only. */
  readonly rows?: readonly string[];
  /** The boxes inside it, placed relative to it. */
  readonly parts?: readonly Design[];
}

/** An empty line is how a box with nothing to say says so — see check.ts, which reads a
 *  box holding neither rows nor children as a fault rather than as an empty box. */
const NOTHING: readonly string[] = [""];

const placed = (parent: Rect, design: Design): Rect => ({
  x: parent.x + (design.at?.x ?? 0),
  y: parent.y + (design.at?.y ?? 0),
  width: design.width,
  height: design.height,
});

const holds = (design: Design): readonly string[] =>
  design.rows ?? ((design.parts ?? []).length === 0 ? NOTHING : []);

/** One designed box as a captured one, and everything under it, with the offsets added
 *  up. `origin` is where the box's parent was placed; the root's parent is the screen. */
function place(design: Design, origin: Rect): CapturedNode {
  const at = placed(origin, design);
  const rows = holds(design);
  const parts = design.parts ?? [];
  return {
    name: design.name,
    at,
    ...(design.key === undefined ? {} : { key: design.key }),
    ...(rows.length === 0 ? {} : { rows }),
    ...(parts.length === 0 ? {} : { children: parts.map((part) => place(part, at)) }),
  };
}

/** The design as a capture: the same boxes, in the same order, at absolute coordinates.
 *
 *  What comes back is an ordinary `CapturedNode` and is meant to be — it is the argument
 *  to `diff`, and it is also the argument to `check`, which is how a design that doubles a
 *  row or hangs a box off the edge of its parent is caught before a screen is measured
 *  against it. */
export const expected = (design: Design): CapturedNode =>
  place(design, { x: 0, y: 0, width: 0, height: 0 });

/** What the screen does not do that the design asked for, and what it does that the design
 *  did not: `diff` with the design as the before, which is the whole point of writing one.
 *
 *  The order of the arguments is the order of the sentence — this design, against that
 *  capture — and it is fixed here rather than left to each caller because the four words
 *  are directional. A caller that passed them the other way round would report the screen
 *  as the intent and every shortfall backwards. */
export const against = (design: Design, capture: CapturedNode): Change[] =>
  diff(expected(design), capture);
