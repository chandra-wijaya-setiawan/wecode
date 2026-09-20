/** Two captures of the same screen, and what is different between them.
 *
 *  check.ts asks whether one capture is self-consistent. It cannot say that the panel a
 *  person was reading yesterday is no longer drawn, or that it is drawn forty columns to
 *  the left, because both captures are clean on their own: nothing is doubled, nothing is
 *  clipped, nothing is empty. The fault is only visible as a difference, so the difference
 *  is what this module reports.
 *
 *  It reads the before and the after and names each box that is not the same in both, under
 *  four words a person can act on:
 *
 *    - `gone` — a box the before drew and the after does not, which is the panel that
 *      folded away between two releases;
 *    - `arrived` — a box only the after draws, which is either the feature or the stray;
 *    - `moved` — the same box at different coordinates or a different size, which is how a
 *      column silently loses half its width;
 *    - `changed` — the same box in the same place holding different rows or opening on a
 *      different letter, which is the content drifting under a layout that looks settled.
 *
 *  A box is the same box when its path is the same — `"Board > Queue"` — for the same
 *  reason a finding names one that way: a name reused at two depths is two boxes. Renaming
 *  a box therefore reads as one `gone` and one `arrived`, and that is the honest report,
 *  because nothing in a capture says the new name is the old box under another word.
 *
 *  No product noun lives here, and nothing is ranked: a `moved` is not worse than a
 *  `changed`, and which differences matter is a person's call. This decides no geometry —
 *  every number it repeats was decided by whoever produced the captures. */
import type { CapturedNode } from "./check.js";
import type { Rect } from "./wireframe.js";

/** The four words a difference is reported under. */
export type Difference = "gone" | "arrived" | "moved" | "changed";

/** One difference: which word, which box it is about, and the detail that makes it
 *  actionable. `node` is the path down the capture, as in check.ts. `says` is for the
 *  person reading the report and is not a contract. */
export interface Change {
  readonly kind: Difference;
  readonly node: string;
  readonly says: string;
}

const rect = (at: Rect): string => `${at.x},${at.y} ${at.width}x${at.height}`;

const same = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const rows = (node: CapturedNode): readonly string[] => node.rows ?? [];

const sameRows = (a: CapturedNode, b: CapturedNode): boolean => {
  const [x, y] = [rows(a), rows(b)];
  return x.length === y.length && x.every((row, i) => row === y[i]);
};

/** Every box of a capture by its path, in the order it was drawn. A capture that drew one
 *  path twice is check.ts's business, not this module's: the first sighting is kept, so a
 *  doubled box is still compared once rather than swallowing the diff. */
function index(node: CapturedNode, above: readonly string[]): Map<string, CapturedNode> {
  const here = [...above, node.name];
  const out = new Map<string, CapturedNode>([[here.join(" > "), node]]);
  for (const child of node.children ?? []) {
    for (const [path, found] of index(child, here)) if (!out.has(path)) out.set(path, found);
  }
  return out;
}

/** What is different about one box present in both captures: where it is, then what it
 *  holds. Both are reported when both changed — a box that moved and lost its rows has two
 *  things wrong with it and a reader told only about the move would go looking in the
 *  wrong place. */
function differs(path: string, was: CapturedNode, now: CapturedNode): Change[] {
  const out: Change[] = [];
  if (!same(was.at, now.at)) {
    out.push({ kind: "moved", node: path, says: `was at ${rect(was.at)}, now ${rect(now.at)}` });
  }
  if (!sameRows(was, now)) {
    out.push({
      kind: "changed",
      node: path,
      says: `held ${rows(was).length} rows, now holds ${rows(now).length}`,
    });
  } else if (was.key !== now.key) {
    out.push({
      kind: "changed",
      node: path,
      says: `opened on ${was.key ?? "no key"}, now ${now.key ?? "no key"}`,
    });
  }
  return out;
}

/** The differences between two captures: what the before drew and the after does not, then
 *  what changed about the boxes both drew, in the before's drawing order, then what only
 *  the after draws, in the after's. Two captures of the same screen report none.
 *
 *  The before's order leads because a reader holds the old screen in their head: they are
 *  looking for what became of the boxes they know, and the ones that are new to them are
 *  the last thing to read. */
export function diff(before: CapturedNode, after: CapturedNode): Change[] {
  const was = index(before, []);
  const now = index(after, []);
  const out: Change[] = [];

  for (const [path, node] of was) {
    const then = now.get(path);
    if (then === undefined) out.push({ kind: "gone", node: path, says: `was at ${rect(node.at)}` });
    else out.push(...differs(path, node, then));
  }
  for (const [path, node] of now) {
    if (!was.has(path)) out.push({ kind: "arrived", node: path, says: `drawn at ${rect(node.at)}` });
  }
  return out;
}

/** The differences as the lines of a report, one per change: the word, then the box, then
 *  the detail. Written here rather than by each caller for the reason indexLines is — a
 *  second arrangement of the same findings is a second answer to one question. */
export const diffLines = (changes: readonly Change[]): readonly string[] =>
  changes.map((c) => `${c.kind}: ${c.node} — ${c.says}`);
