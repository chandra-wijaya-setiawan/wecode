/** The outline is read one depth at a time. These tests hold the depth keys to that: a
 *  step in opens the whole next level of the tree, not the one node under the cursor, and
 *  the two ends are walls rather than wraps. */
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { open, tree, type Node } from "@wecode/core";
import {
  atDepth,
  foldedTo,
  foldedToDepth,
  nodeKey,
  openDepth,
  outlineRows,
  OUTLINE,
  treeDepth,
} from "../src/outline.js";
import { seed } from "./seed.js";

/** The story's own branch was behind master, and the outline this work extends only exists
 *  on master. A suite that merely ran green proved nothing about that: it was green before
 *  the merge too. So the base is asserted first, two ways, and neither can be satisfied by
 *  a branch that has not actually taken master in.
 *
 *  The ancestry is checked against the commit master pointed at when the merge was made,
 *  not against whatever master has moved on to since — this test is about whether the base
 *  was merged, not about staying caught up with a branch other work keeps advancing. */
const BASE = "b0dea6ba12b9ba8d43b964b496498b37cf60ccf5";

describe("the base this work is built on", () => {
  it("is an ancestor of the commit under test", () => {
    const at = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const merged = execFileSync("git", ["merge-base", BASE, at], { encoding: "utf8" }).trim();
    expect(merged).toBe(BASE);
  });

  it("brought the outline it extends with it", () => {
    // foldedTo, outlineRows and OUTLINE are the base's own; only the depth walk is new.
    for (const f of [foldedTo, outlineRows, treeDepth, foldedToDepth, openDepth, atDepth]) {
      expect(typeof f).toBe("function");
    }
    expect(OUTLINE.key).toHaveLength(1);
    expect(OUTLINE.depth).not.toBe("");
  });
});

/** A forest that branches, so "the whole next level" can be told apart from "the node
 *  under the cursor". Two projects, each with two children, and one grandchild below. */
const node = (entity: string, id: number, children: readonly Node[] = []): Node => ({
  entity,
  id,
  label: `${entity}-${id}`,
  state: "in_progress",
  children,
  rollup: {} as Node["rollup"],
  folded: false,
});

const FOREST: readonly Node[] = [
  node("project", 1, [node("release", 11, [node("epic", 111)]), node("release", 12)]),
  node("project", 2, [node("release", 21)]),
];

const keys = (s: ReadonlySet<string>): string[] => [...s].sort();

describe("treeDepth", () => {
  it("counts levels of children below the roots", () => {
    expect(treeDepth(FOREST)).toBe(2);
  });

  it("is 0 for roots with nothing under them", () => {
    expect(treeDepth([node("project", 1), node("project", 2)])).toBe(0);
  });

  it("is 0 for an empty forest", () => {
    expect(treeDepth([])).toBe(0);
  });
});

describe("foldedToDepth", () => {
  it("opens nothing at depth 0, leaving the roots alone", () => {
    expect(keys(foldedToDepth(FOREST, 0))).toEqual([]);
  });

  it("opens every root at depth 1, and only the roots", () => {
    expect(keys(foldedToDepth(FOREST, 1))).toEqual(["project#1", "project#2"]);
  });

  it("opens the whole of the next level, not one branch of it", () => {
    // Both projects open, and the only release that has anything under it. release#12 and
    // release#21 are childless: there is nothing there to open.
    expect(keys(foldedToDepth(FOREST, 2))).toEqual(["project#1", "project#2", "release#11"]);
  });

  it("never keys a childless row, so two outlines drawing the same rows compare equal", () => {
    expect(keys(foldedToDepth(FOREST, 99))).not.toContain("epic#111");
  });

  it("asking past the bottom is the same as asking for the bottom", () => {
    expect(keys(foldedToDepth(FOREST, 99))).toEqual(keys(foldedToDepth(FOREST, 2)));
  });
});

describe("openDepth", () => {
  it("reads 0 when nothing is expanded", () => {
    expect(openDepth(FOREST, new Set())).toBe(0);
  });

  it("reads back whatever foldedToDepth set", () => {
    for (const d of [0, 1, 2]) {
      expect(openDepth(FOREST, foldedToDepth(FOREST, d))).toBe(d);
    }
  });

  it("reports the deepest row on show when one node was opened by hand", () => {
    const byHand = new Set([nodeKey(FOREST[0]!), nodeKey(FOREST[0]!.children[0]!)]);
    expect(openDepth(FOREST, byHand)).toBe(2);
  });

  it("ignores keys for nodes that are not on show", () => {
    // release#11 is expanded but its parent is not, so its children are not drawn.
    expect(openDepth(FOREST, new Set(["release#11"]))).toBe(0);
  });
});

describe("atDepth", () => {
  it("steps in one whole level at a time", () => {
    let expanded = foldedToDepth(FOREST, 0);
    expanded = atDepth(FOREST, expanded, +1);
    expect(openDepth(FOREST, expanded)).toBe(1);
    expanded = atDepth(FOREST, expanded, +1);
    expect(openDepth(FOREST, expanded)).toBe(2);
  });

  it("steps out one whole level at a time", () => {
    let expanded = foldedToDepth(FOREST, 2);
    expanded = atDepth(FOREST, expanded, -1);
    expect(openDepth(FOREST, expanded)).toBe(1);
    expanded = atDepth(FOREST, expanded, -1);
    expect(openDepth(FOREST, expanded)).toBe(0);
  });

  it("stepping in opens every branch, not just the first", () => {
    const rows = outlineRows(FOREST, atDepth(FOREST, new Set(), +1), null);
    expect(rows.map((r) => r.node.id)).toEqual([1, 11, 12, 2, 21]);
  });

  it("walls at the bottom rather than wrapping to the top", () => {
    const bottom = foldedToDepth(FOREST, 2);
    expect(keys(atDepth(FOREST, bottom, +1))).toEqual(keys(bottom));
  });

  it("walls at the top rather than wrapping to the bottom", () => {
    expect(keys(atDepth(FOREST, new Set(), -1))).toEqual([]);
  });

  it("normalises a hand-folded outline onto a whole level", () => {
    // One project opened by hand: depth reads 1, so a step in takes the whole tree to 2.
    const byHand = new Set([nodeKey(FOREST[0]!)]);
    expect(keys(atDepth(FOREST, byHand, +1))).toEqual(keys(foldedToDepth(FOREST, 2)));
  });
});

describe("on the real tree", () => {
  let db: DatabaseSync;
  let forest: readonly Node[];

  beforeEach(() => {
    db = open(":memory:");
    seed(db);
    forest = tree(db);
  });

  it("walks from the roots to the leaves one level per step", () => {
    const bottom = treeDepth(forest);
    expect(bottom).toBeGreaterThan(0);
    let expanded: ReadonlySet<string> = foldedToDepth(forest, 0);
    for (let d = 1; d <= bottom; d += 1) {
      expanded = atDepth(forest, expanded, +1);
      expect(openDepth(forest, expanded)).toBe(d);
    }
    // Every node in the tree is drawn once the outline is open to the bottom.
    expect(outlineRows(forest, expanded, null)).toHaveLength(countNodes(forest));
  });

  it("agrees with the entity the config folds to", () => {
    const byEntity = foldedTo(forest, "story");
    expect(keys(foldedToDepth(forest, openDepth(forest, byEntity)))).toEqual(keys(byEntity));
  });
});

function countNodes(forest: readonly Node[]): number {
  return forest.reduce((n, c) => n + 1 + countNodes(c.children), 0);
}
