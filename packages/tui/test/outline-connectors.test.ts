/** A level of the outline has to read at a glance rather than be counted. These tests hold
 *  the connectors to that: every row hangs off its parent by a tee, or by an elbow if it is
 *  the last of its siblings, and the columns between carry a rail exactly where the branch
 *  above is still going. They also hold the cost — the connectors are drawn inside the two
 *  columns per level the outline already spent, so a deep row loses no label width. */
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { open, tree, type Node } from "@wecode/core";
import { connector, foldedToDepth, INDENT, outlineRows } from "../src/outline.js";
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

/** Two roots: under the first, a branch is still to come below the one being drawn, and
 *  under the second it is not. That difference is the whole of what a rail says. */
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

describe("connector", () => {
  it("draws nothing for a root, which is flush", () => {
    expect(connector([])).toBe("");
  });

  it("hangs a row that has siblings to come off a tee", () => {
    expect(connector([false])).toBe("├─");
  });

  it("hangs the last of the siblings off an elbow instead", () => {
    expect(connector([true])).toBe("└─");
  });

  it("rails the column of an ancestor whose branch is still going", () => {
    expect(connector([false, false])).toBe("│ ├─");
    expect(connector([false, true])).toBe("│ └─");
  });

  it("clears the column of an ancestor that was the last of its siblings", () => {
    expect(connector([true, false])).toBe("  ├─");
    expect(connector([true, true])).toBe("  └─");
  });

  it("spends the same two columns per level the plain indent did", () => {
    for (const depth of [1, 2, 3, 9]) {
      const closed = Array.from({ length: depth }, () => false);
      expect([...connector(closed)]).toHaveLength(depth * INDENT);
    }
  });
});

describe("the rows the outline draws", () => {
  it("leaves the roots flush against the left edge", () => {
    expect(drawn().get("project-1")).toBe("- project-1");
    expect(drawn().get("project-2")).toBe("- project-2");
  });

  it("marks the last child of a parent, so a level closes where it ends", () => {
    expect(drawn().get("release-11")).toBe("├─- release-11");
    expect(drawn().get("release-12")).toBe("└─  release-12");
  });

  it("carries the rail down past a parent's later siblings", () => {
    // release-12 is still to come under project-1, so the epics under release-11 are drawn
    // with release-11's own column railed.
    expect(drawn().get("epic-111")).toBe("│ ├─  epic-111");
    expect(drawn().get("epic-112")).toBe("│ └─  epic-112");
  });

  it("clears the rail once the branch above has nothing left below it", () => {
    // release-21 is the last child of project-2, so its own child hangs under a gap.
    expect(drawn().get("release-21")).toBe("└─- release-21");
    expect(drawn().get("epic-211")).toBe("  └─  epic-211");
  });

  it("indents each level exactly one connector further than its parent", () => {
    const at = (label: string): number => drawn().get(label)!.search(/[-+ ] /);
    expect(at("release-11") - at("project-1")).toBe(INDENT);
    expect(at("epic-111") - at("release-11")).toBe(INDENT);
  });

  it("keeps the fold marker on the row, so the row still says what to press", () => {
    const folded = outlineRows(FOREST, foldedToDepth(FOREST, 1), null);
    const row = folded.find((r) => r.node.label === "release-11")!.row.what;
    expect(row).toBe("├─+ release-11");
  });

  it("draws an only child on an elbow", () => {
    const one = [node("project", 1, [node("release", 11)])];
    expect(drawn(one).get("release-11")).toBe("└─  release-11");
  });
});

describe("on the real tree", () => {
  it("gives every row below a root a connector, and every root none", () => {
    const forest = realForest();
    const rows = outlineRows(forest, foldedToDepth(forest, 99), null);
    expect(rows.length).toBeGreaterThan(5);
    const roots = new Set(forest.map((n) => n.label));
    for (const r of rows) {
      const connected = /^[│ ]*[├└]─/.test(r.row.what);
      const root = roots.has(r.node.label);
      expect(connected, `${r.row.what} should ${root ? "not " : ""}connect`).toBe(!root);
    }
  });

  it("never leaves a rail hanging under a branch that has closed", () => {
    const forest = realForest();
    const rows = outlineRows(forest, foldedToDepth(forest, 99), null).map((r) => r.row.what);
    // The column an elbow sits in is blank on every row under it: an elbow with a rail
    // below it would claim a sibling that is not there.
    for (const [i, what] of rows.entries()) {
      for (let c = 0; c < what.length; c += 1) {
        if (what[c] !== "└") continue;
        const next = rows[i + 1];
        if (next === undefined || next.length <= c) continue;
        expect(["│", "├", "└"], `${what} then ${next}`).not.toContain(next[c]);
      }
    }
  });
});
