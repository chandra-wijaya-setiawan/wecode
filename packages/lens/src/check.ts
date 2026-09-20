/** Four rules that hold for every screen, checked against a captured tree.
 *
 *  Six layout defects reached master in a week and a person found every one of them by
 *  looking at a screenshot, because the suite only ever asserted substrings of a joined
 *  frame. A substring says a word was printed somewhere. It cannot say the word was
 *  printed inside the box that owns it, or that it was not also printed in the box next
 *  door, or that the box it was printed in had a right edge to the left of it.
 *
 *  So this module reads a capture — the boxes a screen was actually drawn as, each one
 *  stating where it is, what letter opens it and which rows it holds — and reports the
 *  faults that are true of any screen whatever it is a screen of:
 *
 *    - a row drawn in two boxes, because a row belongs to one box and a reader who sees it
 *      twice cannot tell which box is lying;
 *    - a box that leaves its parent's, because whatever hangs outside is clipped away and
 *      the capture is the only place that is still visible;
 *    - a key bound twice, because the second binding is unreachable and the index that
 *      advertises it is wrong;
 *    - a box holding no rows at all, because a box that has nothing to say must say so on
 *      an empty line rather than collapse to a frame a reader has to interpret.
 *
 *  No product noun lives here. A node is named by the caller, and the check reports the
 *  caller's names back, so the same four rules read a cockpit, a detail page or a fixture.
 *
 *  What this is not: a layout engine, and not a judge of whether a screen is any good.
 *  Every number it reads was decided by whoever produced the capture — see wireframe.ts,
 *  which takes the same view of the same geometry — and nothing here moves a box or
 *  proposes where one ought to go. A screen with all four rules satisfied can still be
 *  ugly; that is a person's call, and this is the part that is not. */
import type { Rect } from "./wireframe.js";

/** One box of a capture, and the boxes inside it.
 *
 *  `rows` is what the box drew, one string per line, and it is the box's own lines only —
 *  a parent does not repeat its children's. That is what lets a row found under two boxes
 *  be a fault rather than an artefact of how the tree was flattened. A box that drew
 *  nothing but is entitled to draw nothing says so with an empty line, `rows: [""]`, which
 *  is a different statement from `rows: []` and is meant to be. */
export interface CapturedNode {
  /** The caller's name for this box — what a finding will call it. */
  readonly name: string;
  /** Where it was drawn, absolute, in the capture's own units. */
  readonly at: Rect;
  /** The letter that opens it, if it is reachable by one. */
  readonly key?: string;
  /** The lines this box drew, its own only. */
  readonly rows?: readonly string[];
  readonly children?: readonly CapturedNode[];
}

/** The four rules, as the words a finding is reported under. */
export type Rule = "placed twice" | "clipped" | "key bound twice" | "empty box";

/** One fault: which rule, which node broke it, and the detail that makes it actionable.
 *  `node` is the path down the capture — `"Board > Queue"` — so a name reused at two
 *  depths still points at one box. For a row it is the row's own text, which is the only
 *  name a row has. */
export interface Finding {
  readonly rule: Rule;
  readonly node: string;
  readonly says: string;
}

const path = (above: readonly string[], node: CapturedNode): string =>
  [...above, node.name].join(" > ");

const rect = (at: Rect): string => `${at.x},${at.y} ${at.width}x${at.height}`;

/** Inside, edges included: a child flush against its parent's edge is drawn, not clipped. */
const inside = (parent: Rect, child: Rect): boolean =>
  child.x >= parent.x &&
  child.y >= parent.y &&
  child.x + child.width <= parent.x + parent.width &&
  child.y + child.height <= parent.y + parent.height;

/** A box that holds other boxes is not expected to hold rows of its own: it says what it
 *  has to say through its children, and it is their emptiness that would be a fault. */
const holdsNothing = (node: CapturedNode): boolean =>
  (node.children ?? []).length === 0 && (node.rows ?? []).length === 0;

interface Sightings {
  /** Every box a row was drawn in, in the order the walk met them. */
  readonly rows: Map<string, string[]>;
  /** Every box that bound a key, likewise. */
  readonly keys: Map<string, string[]>;
}

const sight = (index: Map<string, string[]>, at: string, where: string): void => {
  const seen = index.get(at);
  if (seen === undefined) index.set(at, [where]);
  else seen.push(where);
};

/** One box and everything under it: the faults that are the box's own, in walk order,
 *  with what it was seen to hold recorded for the rules that only a second sighting can
 *  break. */
function walk(
  node: CapturedNode,
  above: readonly string[],
  parent: Rect | undefined,
  seen: Sightings,
): Finding[] {
  const here = path(above, node);
  const out: Finding[] = [];

  if (parent !== undefined && !inside(parent, node.at)) {
    out.push({
      rule: "clipped",
      node: here,
      says: `drawn at ${rect(node.at)}, outside its parent at ${rect(parent)}`,
    });
  }
  if (holdsNothing(node)) {
    out.push({ rule: "empty box", node: here, says: "holds no rows and no empty line" });
  }

  if (node.key !== undefined) sight(seen.keys, node.key, here);
  /** An empty line is how a box says it has nothing, not a row it drew — two boxes with
   *  nothing to say are two boxes saying so, and that is not one row in two places. */
  for (const row of node.rows ?? []) if (row !== "") sight(seen.rows, row, here);

  for (const child of node.children ?? []) {
    out.push(...walk(child, [...above, node.name], node.at, seen));
  }
  return out;
}

/** Only what was seen more than once: the rest of the capture is not this rule's business. */
const twice = (index: Map<string, string[]>): [string, string[]][] =>
  [...index].filter(([, wheres]) => wheres.length > 1);

/** The capture's faults: the ones a single box is guilty of in the order they were drawn,
 *  then the ones that take two sightings to see. A clean capture reports none.
 *
 *  A key is reported against the boxes that bound it after the first, because the first
 *  binding is the one that works and the later ones are the unreachable ones. A row is
 *  reported under its own text, naming every box it turned up in: there is no first
 *  correct sighting of a row, only a row that belongs in one place and is in two. */
export function check(root: CapturedNode): readonly Finding[] {
  const seen: Sightings = { rows: new Map(), keys: new Map() };
  const found = walk(root, [], undefined, seen);

  for (const [row, wheres] of twice(seen.rows)) {
    found.push({ rule: "placed twice", node: row, says: `drawn in ${wheres.join(" and ")}` });
  }
  for (const [key, wheres] of twice(seen.keys)) {
    const [first, ...rest] = wheres;
    found.push({
      rule: "key bound twice",
      node: rest.join(" and "),
      says: `binds ${key}, which ${first!} already binds`,
    });
  }
  return found;
}
