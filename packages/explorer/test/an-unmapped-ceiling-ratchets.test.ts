import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadComponents, type ComponentMap } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { against, ceilingOf, measure } from "../src/coverage.js";
import { tmp } from "../../core/test/tmpdir.js";

/** One box over two modules, written the way components.yaml is. */
const MAP = `layers:
  gate: what may exist

components:
  model:
    package: core
    layer: gate
    component: true
    owns: the entities and their state machines
    modules: [types, rules]
`;

function written(body: string): ComponentMap {
  const path = join(tmp("wecode-ceiling-"), "components.yaml");
  writeFileSync(path, body);
  return loadComponents(path);
}

const map: ComponentMap = written(MAP);

/** A tree with `loose` modules nothing claims, on top of the two the map owns. */
const tree = (...loose: string[]) => measure(map, ["core/types", "core/rules", ...loose]);

describe("what the ceiling counts", () => {
  it("is the number of modules the map leaves unclaimed", () => {
    expect(ceilingOf(tree("core/a", "core/b"))).toBe(2);
  });

  it("is 0 for a tree the map accounts for entirely", () => {
    expect(ceilingOf(tree())).toBe(0);
  });

  it("counts a module once however often the tree names it", () => {
    expect(ceilingOf(measure(map, ["core/a", "core/a"]))).toBe(1);
  });
});

describe("what the ceiling refuses", () => {
  it("refuses a tree that leaves more unclaimed than the ceiling allows", () => {
    const verdict = against(1, tree("core/a", "core/b"));
    expect(verdict.refused).toBe(true);
    expect(verdict.ceiling).toBe(1);
    expect(verdict.unmapped).toBe(2);
  });

  it("names every loose module on a refusal, so there is something to act on", () => {
    const verdict = against(0, tree("core/b", "core/a"));
    expect(verdict.loose).toEqual(["core/a", "core/b"]);
    expect(verdict.reason).toContain("core/a, core/b");
    expect(verdict.reason).toContain("components.yaml");
  });

  it("accepts a repository that is behind and stays where it is", () => {
    const verdict = against(2, tree("core/a", "core/b"));
    expect(verdict.refused).toBe(false);
    expect(verdict.loose).toEqual([]);
    expect(verdict.reason).toContain("at its ceiling");
  });

  it("accepts a change that leaves fewer unclaimed than the ceiling", () => {
    expect(against(3, tree("core/a")).refused).toBe(false);
  });

  it("accepts an unclaimed module when the same change claims one that was loose", () => {
    expect(against(1, tree("core/new")).refused).toBe(false);
  });

  it("refuses on the count, not on the share of the tree", () => {
    const before = measure(map, ["core/types", "core/a"]);
    const after = tree("core/a", "core/b");
    expect(after.ratio).toBe(before.ratio);
    expect(against(ceilingOf(before), after).refused).toBe(true);
  });
});

describe("the ceiling only falls", () => {
  it("falls to the tree's own number when the tree is under it", () => {
    const verdict = against(3, tree("core/a"));
    expect(verdict.lowered).toBe(1);
    expect(verdict.reason).toBe("the unmapped ceiling falls from 3 to 1.");
  });

  it("stays where it was when the tree sits on it", () => {
    expect(against(2, tree("core/a", "core/b")).lowered).toBe(2);
  });

  it("does not rise to meet a tree that broke it", () => {
    const verdict = against(0, tree("core/a"));
    expect(verdict.refused).toBe(true);
    expect(verdict.lowered).toBe(0);
  });

  it("never rises across a sequence of trees, whatever they do", () => {
    const trees = [tree("core/a", "core/b"), tree("core/a"), tree("core/a", "core/b"), tree()];
    let ceiling = ceilingOf(trees[0]!);
    const seen: number[] = [ceiling];
    for (const t of trees) {
      ceiling = against(ceiling, t).lowered;
      seen.push(ceiling);
    }
    expect(seen).toEqual([2, 2, 1, 1, 0]);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  it("adopts the tree's number when no ceiling has been recorded yet", () => {
    const verdict = against(-1, tree("core/a", "core/b"));
    expect(verdict.refused).toBe(false);
    expect(verdict.ceiling).toBe(2);
    expect(verdict.lowered).toBe(2);
  });
});

describe("the map wecode ships", () => {
  it("sits at or under a ceiling of its own unmapped count", () => {
    const shipped = loadComponents();
    const coverage = measure(shipped, ["explorer/coverage", "explorer/architecture"]);
    const verdict = against(ceilingOf(coverage), coverage);
    expect(verdict.refused).toBe(false);
    expect(verdict.lowered).toBe(0);
  });
});
