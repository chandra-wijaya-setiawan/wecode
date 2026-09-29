/** A level of the outline has to read at a glance rather than be counted. These tests hold
 *  the indent to that: every row is moved right two columns for every level above it, a
 *  root is flush, and a level is read off the column the labels line up in rather than off
 *  any one row's width. They also hold what replaced the rail — by approval 1560 the tees,
 *  elbows and rails are retired, so no row carries a connector glyph at all. */
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { open, tree, type Node } from "@wecode/core";
import { foldedToDepth, indentOf, INDENT, outlineRows } from "../src/outline.js";
import { seed } from "./seed.js";

const node = (entity: string, id: number, children: readonly Node[] = []): Node => ({
  entity,
  id,
  label: `${entity}-${id}`,
  state: "in_progress",
  children,
  rollup: {} as Node["rollup"],
  folded: false,
});

/** Two roots, and under the first a branch that closes before the tree does — the case a
 *  rail used to be drawn for, and the one the indent has to read on without it. */
const FOREST: readonly Node[] = [
  node("project", 1, [
    node("release", 11, [node("epic", 111), node("epic", 112)]),
    node("release", 12),
  ]),
  node("project", 2, [node("release", 21, [node("epic", 211)])]),
];

/** The rows as a reader sees them, fully open, by label. */
const drawn = (forest: readonly Node[] = FOREST): Map<string, string> => {
  const rows = outlineRows(forest, foldedToDepth(forest, 99), null);
  return new Map(rows.map((r) => [r.node.label, r.row.what]));
};

const realForest = (): readonly Node[] => {
  const db: DatabaseSync = open(":memory:");
  seed(db);
  return tree(db);
};

/** Any glyph a rail, a tee or an elbow was drawn with. None of them is a row's any more. */
const GUIDE = /[│├└─]/;

describe("indentOf", () => {
  it("draws nothing for a root, which is flush", () => {
    expect(indentOf(0)).toBe("");
  });

  it("moves a row right two columns for every level above it", () => {
    expect(indentOf(1)).toBe("  ");
    expect(indentOf(2)).toBe("    ");
  });

  it("spends the same two columns per level, however deep the row is", () => {
    for (const depth of [1, 2, 3, 9]) {
      expect([...indentOf(depth)]).toHaveLength(depth * INDENT);
    }
  });

  it("spends them on blanks alone, so no column repeats the row's position", () => {
    expect(indentOf(9)).not.toMatch(GUIDE);
  });
});

describe("the rows the outline draws", () => {
  it("leaves the roots flush against the left edge", () => {
    expect(drawn().get("project-1")).toBe("- project-1");
    expect(drawn().get("project-2")).toBe("- project-2");
  });

  it("indents the children of a root by one level, last one and all", () => {
    expect(drawn().get("release-11")).toBe("  - release-11");
    expect(drawn().get("release-12")).toBe("    release-12");
  });

  it("indents a grandchild by two, whatever is still to come above it", () => {
    // release-12 is still to come under project-1 and nothing is still to come under
    // project-2, and the epics under each are drawn at the same column regardless: depth
    // is what the indent says, and the only thing it says.
    expect(drawn().get("epic-111")).toBe("      epic-111");
    expect(drawn().get("epic-112")).toBe("      epic-112");
    expect(drawn().get("release-21")).toBe("  - release-21");
    expect(drawn().get("epic-211")).toBe("      epic-211");
  });

  it("indents each level exactly one step further than its parent", () => {
    // The column the label itself begins at, which is what a reader compares rows on.
    const at = (label: string): number => drawn().get(label)!.indexOf(label);
    expect(at("release-11") - at("project-1")).toBe(INDENT);
    expect(at("epic-111") - at("release-11")).toBe(INDENT);
  });

  it("keeps the fold marker on the row, so the row still says what to press", () => {
    const folded = outlineRows(FOREST, foldedToDepth(FOREST, 1), null);
    const row = folded.find((r) => r.node.label === "release-11")!.row.what;
    expect(row).toBe("  + release-11");
  });

  it("draws an only child at the same column as any other child", () => {
    const one = [node("project", 1, [node("release", 11)])];
    expect(drawn(one).get("release-11")).toBe("    release-11");
  });
});

describe("on the real tree", () => {
  it("indents every row below a root, and no root", () => {
    const forest = realForest();
    const rows = outlineRows(forest, foldedToDepth(forest, 99), null);
    expect(rows.length).toBeGreaterThan(5);
    const roots = new Set(forest.map((n) => n.label));
    for (const r of rows) {
      const indented = r.row.what.startsWith(" ".repeat(INDENT));
      const root = roots.has(r.node.label);
      expect(indented, `${r.row.what} should ${root ? "not " : ""}be indented`).toBe(!root);
    }
  });

  it("draws no guide at all: the indent is the whole of what depth costs", () => {
    const forest = realForest();
    const rows = outlineRows(forest, foldedToDepth(forest, 99), null);
    for (const r of rows) expect(r.row.what, r.row.what).not.toMatch(GUIDE);
  });
});
