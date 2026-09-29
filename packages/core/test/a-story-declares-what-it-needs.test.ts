/** A story says what it needs finished before it can start, and nothing may say it in a
 *  circle.
 *
 *  Three things are held here. The edge goes in and comes back out both ways round, so
 *  `prerequisitesOf` and `dependentsOf` cannot disagree about whether it is there. The
 *  refusal bites on a path of any length and names the chain it would have closed. And
 *  the shapes that only *look* like a cycle — a second route to the same story, the same
 *  edge declared twice — are allowed, because a check that refused those would be a check
 *  nobody could plan around.
 *
 *  Last, the owner row: `depends.ts` is a module under `packages/core/src`, and the map is
 *  what says which box owns it. The tree-wide version of that is
 *  `components-cover-the-tree.test.ts`; what is proved here is that this module in
 *  particular is claimed, and that it is the row doing the claiming. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DependsError,
  NO_DEPENDENCIES,
  dependentsOf,
  dependsOn,
  prerequisitesOf,
  type Dependencies,
} from "../src/depends.js";
import { claims, loadComponents, ownerOf, type ComponentMap } from "../src/index.js";

/** Declare a run of edges from `[dependent, prerequisite]` pairs. Every fixture below is
 *  a handful of these, and spelling `dependsOn` five times says nothing the pairs do not. */
const declare = (...edges: readonly (readonly [number, number])[]): Dependencies =>
  edges.reduce<Dependencies>((so, [dependent, prerequisite]) => dependsOn(so, dependent, prerequisite), NO_DEPENDENCIES);

describe("a story declares what it needs", () => {
  it("reads back the one story it was given", () => {
    const declared = dependsOn(NO_DEPENDENCIES, 2, 1);
    expect(prerequisitesOf(declared, 2)).toEqual([1]);
  });

  it("says nothing about a story nobody has declared anything about", () => {
    expect(prerequisitesOf(NO_DEPENDENCIES, 7)).toEqual([]);
    expect(dependentsOf(declare([2, 1]), 7)).toEqual([]);
  });

  it("needs a story that needs nothing, which is the same empty answer", () => {
    expect(prerequisitesOf(declare([2, 1]), 1)).toEqual([]);
  });

  it("holds several prerequisites at once, in id order however they were declared", () => {
    expect(prerequisitesOf(declare([4, 3], [4, 1], [4, 2]), 4)).toEqual([1, 2, 3]);
  });

  it("names a prerequisite once, even in declarations it did not make itself", () => {
    // `Dependencies` is a public type, so a caller may hand over a set it built rather
    // than one `dependsOn` grew. `dependsOn` records no edge twice; a read must not
    // report one twice either, whichever of the two it was given.
    const byHand: Dependencies = [
      { dependent: 2, prerequisite: 1 },
      { dependent: 2, prerequisite: 1 },
    ];
    expect(prerequisitesOf(byHand, 2)).toEqual([1]);
    expect(dependentsOf(byHand, 1)).toEqual([2]);
  });

  it("leaves the declarations it was handed alone", () => {
    const before = declare([2, 1]);
    const after = dependsOn(before, 3, 1);

    expect(after).not.toBe(before);
    expect(prerequisitesOf(before, 3)).toEqual([]);
    expect(prerequisitesOf(after, 3)).toEqual([1]);
  });

  it("records nothing twice, and gives the same declarations back", () => {
    const once = declare([2, 1]);
    const twice = dependsOn(once, 2, 1);

    expect(twice).toBe(once);
    expect(prerequisitesOf(twice, 2)).toEqual([1]);
  });

  it("refuses an id that is not a row's", () => {
    expect(() => dependsOn(NO_DEPENDENCIES, 0, 1)).toThrow(/the dependent is not a story id: 0/);
    expect(() => dependsOn(NO_DEPENDENCIES, 2, -1)).toThrow(/the prerequisite is not a story id: -1/);
    expect(() => dependsOn(NO_DEPENDENCIES, 2, 1.5)).toThrow(DependsError);
  });
});

describe("reading the other direction", () => {
  it("names who is waiting on a story", () => {
    const declared = declare([2, 1], [3, 1]);
    expect(dependentsOf(declared, 1)).toEqual([2, 3]);
  });

  it("agrees with the prerequisites on every edge there is", () => {
    const declared = declare([2, 1], [3, 1], [4, 2], [4, 3]);
    const stories = [1, 2, 3, 4];

    const forwards = stories.flatMap((s) => prerequisitesOf(declared, s).map((p) => `${s} needs ${p}`));
    const backwards = stories.flatMap((s) => dependentsOf(declared, s).map((d) => `${d} needs ${s}`));

    expect([...forwards].sort()).toEqual([...backwards].sort());
    expect(forwards).toHaveLength(4);
  });

  it("reads what was declared and not what follows from it", () => {
    // 3 → 2 → 1. 3 is held up by 2, and 2 is what is held up by 1: a caller asking what
    // may start reads one edge deep, and 1 is already spoken for by 2 not having finished.
    const declared = declare([2, 1], [3, 2]);

    expect(prerequisitesOf(declared, 3)).toEqual([2]);
    expect(dependentsOf(declared, 1)).toEqual([2]);
  });
});

describe("an edge that would close a path", () => {
  it("refuses a story that needs itself", () => {
    expect(() => dependsOn(NO_DEPENDENCIES, 1, 1)).toThrow(DependsError);
    expect(() => dependsOn(NO_DEPENDENCIES, 1, 1)).toThrow("story 1 cannot need itself");
  });

  it("refuses the edge straight back", () => {
    const declared = declare([2, 1]);
    expect(() => dependsOn(declared, 1, 2)).toThrow(
      "story 1 cannot need story 2: 2 already needs 1, by 2 → 1",
    );
  });

  it("refuses one that closes a longer path, and names the chain", () => {
    const declared = declare([2, 1], [3, 2]);
    expect(() => dependsOn(declared, 1, 3)).toThrow(
      "story 1 cannot need story 3: 3 already needs 1, by 3 → 2 → 1",
    );
  });

  it("names the shortest chain when there is more than one", () => {
    // 9 reaches 1 two ways: through 2, and the long way round through 3, 4 and 5. The
    // long branch is the one a depth-first walk goes down first — 2 sorts before 3, so it
    // is queued first and popped last — and the chain a person has to check by eye is the
    // short one.
    const declared = declare([9, 2], [2, 1], [9, 3], [3, 4], [4, 5], [5, 1]);
    expect(() => dependsOn(declared, 1, 9)).toThrow(
      "story 1 cannot need story 9: 9 already needs 1, by 9 → 2 → 1",
    );
  });

  it("leaves the declarations exactly as they were", () => {
    const declared = declare([2, 1], [3, 2]);
    expect(() => dependsOn(declared, 1, 3)).toThrow(DependsError);

    expect(prerequisitesOf(declared, 1)).toEqual([]);
    expect(dependentsOf(declared, 3)).toEqual([]);
    expect(declared).toHaveLength(2);
  });

  it("comes back with an answer about declarations that already went round", () => {
    // `Dependencies` is a caller's value, so a caller may hand over a set this module did
    // not grow — including one that is already circular, which `dependsOn` would never
    // have built. Asking about story 4 walks 1 → 2 → 1, and the walk has to come back
    // rather than go round: if this test does not finish, that is the failure.
    const circular: Dependencies = [
      { dependent: 1, prerequisite: 2 },
      { dependent: 2, prerequisite: 1 },
    ];
    expect(prerequisitesOf(dependsOn(circular, 4, 1), 4)).toEqual([1]);
  });

  it("allows a second route to the same story, which is no cycle at all", () => {
    // 4 needs 2 and 3, both of which need 1. Two paths from 4 to 1, and nothing circular:
    // a check that counted paths rather than direction would refuse this.
    const declared = declare([2, 1], [3, 1], [4, 2], [4, 3]);
    expect(prerequisitesOf(declared, 4)).toEqual([2, 3]);
    expect(dependentsOf(declared, 1)).toEqual([2, 3]);
  });

  it("allows two stories to need the same one, and one story to need two", () => {
    const declared = declare([3, 1], [3, 2], [4, 1]);
    expect(prerequisitesOf(declared, 3)).toEqual([1, 2]);
    expect(dependentsOf(declared, 1)).toEqual([3, 4]);
  });

  it("still refuses the closing edge after the graph has grown around it", () => {
    // Every edge below is fine on its own; only the last one comes back round.
    const declared = declare([2, 1], [3, 2], [4, 3], [5, 1], [5, 4]);
    expect(() => dependsOn(declared, 1, 5)).toThrow("story 1 cannot need story 5");
    expect(() => dependsOn(declared, 1, 4)).toThrow("by 4 → 3 → 2 → 1");
    expect(() => dependsOn(declared, 2, 5)).toThrow(DependsError);
  });
});

describe("the module's owner", () => {
  const map: ComponentMap = loadComponents();

  it("is on disk, so the map has something to claim", () => {
    expect(existsSync(fileURLToPath(new URL("../src/depends.ts", import.meta.url)))).toBe(true);
  });

  it("is the model, which is where a rule about the entities belongs", () => {
    const owner = ownerOf(map, "core", "depends");
    expect(owner?.name).toBe("model");
    expect(owner?.layer).toBe("gate");
    expect(owner?.owns).toContain("what one story needs finished before it may start");
  });

  it("claims it exactly once", () => {
    expect(claims(map).filter((c) => c === "core/depends")).toEqual(["core/depends"]);
  });

  it("would leave the module unclaimed without that row, which is what the map refuses", () => {
    // The check is only worth having if it fails on the shape it is meant to catch:
    // `components-cover-the-tree.test.ts` compares `claims(map)` against the source tree,
    // and with `depends` struck out of the row it is the module nobody owns.
    const struck: ComponentMap = {
      ...map,
      components: map.components.map((c) => ({ ...c, modules: c.modules.filter((m) => m !== "depends") })),
    };
    expect(claims(struck)).not.toContain("core/depends");
    expect(ownerOf(struck, "core", "depends")).toBeNull();
  });
});
