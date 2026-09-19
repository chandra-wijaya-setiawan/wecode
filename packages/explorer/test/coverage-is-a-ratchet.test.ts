import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadComponents, type ComponentMap } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { judge, measure } from "../src/coverage.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A map with two boxes over three modules, written the way components.yaml is. */
const MAP = `layers:
  gate: what may exist
  data: the store

components:
  model:
    package: core
    layer: gate
    component: true
    owns: the entities and their state machines
    modules: [types, rules]

  store:
    package: core
    layer: data
    component: true
    owns: opening the database, and every row
    modules: [store]
`;

/** The map above, loaded the way the shipped one is — from a file. */
function written(body: string): ComponentMap {
  const path = join(tmp("wecode-coverage-"), "components.yaml");
  writeFileSync(path, body);
  return loadComponents(path);
}

const map: ComponentMap = written(MAP);

/** The tree as the map has it: every module claimed, nothing left over. */
const FULL = ["core/types", "core/rules", "core/store"];

describe("what coverage measures", () => {
  it("is the share of the tree the map claims", () => {
    const coverage = measure(map, [...FULL, "core/scratch"]);
    expect(coverage.claimed).toEqual(["core/rules", "core/store", "core/types"]);
    expect(coverage.unclaimed).toEqual(["core/scratch"]);
    expect(coverage.ratio).toBeCloseTo(0.75);
  });

  it("is 1 for a tree the map accounts for entirely", () => {
    expect(measure(map, FULL).ratio).toBe(1);
  });

  it("is 1 for an empty tree, because nothing is unaccounted for", () => {
    const coverage = measure(map, []);
    expect(coverage.ratio).toBe(1);
    expect(coverage.unclaimed).toEqual([]);
  });

  it("does not count a claim the tree does not have", () => {
    const coverage = measure(map, ["core/types"]);
    expect(coverage.modules).toEqual(["core/types"]);
    expect(coverage.ratio).toBe(1);
  });

  it("counts a module once however often the tree names it", () => {
    expect(measure(map, ["core/types", "core/types"]).modules).toEqual(["core/types"]);
  });
});

describe("what the ratchet refuses", () => {
  it("refuses a change that leaves a smaller share claimed", () => {
    const verdict = judge(measure(map, FULL), measure(map, [...FULL, "core/scratch"]));
    expect(verdict.refused).toBe(true);
    expect(verdict.exposed).toEqual(["core/scratch"]);
    expect(verdict.reason).toContain("core/scratch");
    expect(verdict.reason).toContain("100.0%");
    expect(verdict.reason).toContain("75.0%");
  });

  it("accepts a repository that is already behind and stays where it is", () => {
    const behind = measure(map, [...FULL, "core/scratch"]);
    const verdict = judge(behind, behind);
    expect(verdict.refused).toBe(false);
    expect(verdict.exposed).toEqual([]);
    expect(verdict.reason).toContain("holds at 75.0%");
  });

  it("accepts an unclaimed module when the same change claims enough to hold the share", () => {
    const before = measure(map, ["core/types", "core/loose"]);
    const after = measure(map, ["core/types", "core/rules", "core/loose", "core/spare"]);
    expect(before.ratio).toBe(0.5);
    expect(after.ratio).toBe(0.5);
    expect(judge(before, after).refused).toBe(false);
  });

  it("accepts a change that raises the share", () => {
    const verdict = judge(measure(map, [...FULL, "core/scratch"]), measure(map, FULL));
    expect(verdict.refused).toBe(false);
    expect(verdict.exposed).toEqual([]);
  });

  it("accepts a change that only deletes, leaving the share where it was", () => {
    const verdict = judge(measure(map, FULL), measure(map, ["core/types"]));
    expect(verdict.refused).toBe(false);
  });

  it("refuses on the share, not on the count of unclaimed modules", () => {
    const before = measure(map, ["core/types", "core/loose"]);
    const after = measure(map, [
      "core/types",
      "core/rules",
      "core/store",
      "core/loose",
      "core/spare",
    ]);
    expect(after.unclaimed.length).toBeGreaterThan(before.unclaimed.length);
    expect(after.ratio).toBeGreaterThan(before.ratio);
    expect(judge(before, after).refused).toBe(false);
  });

  it("names only what the change exposed, not what was already loose", () => {
    const before = measure(map, [...FULL, "core/old"]);
    const after = measure(map, [...FULL, "core/old", "core/new"]);
    expect(judge(before, after).exposed).toEqual(["core/new"]);
  });
});

describe("the map wecode ships", () => {
  it("claims the coverage module itself, so the ratchet is under its own rule", () => {
    const shipped = loadComponents();
    const tree = ["explorer/architecture", "explorer/coverage"];
    expect(measure(shipped, tree).unclaimed).toEqual([]);
  });
});
