import { describe, expect, it } from "vitest";
import { loadComponents, type ComponentMap } from "@wecode/core";
import { namesANode, nodeGlobs, resolveScope, ROOT } from "../src/scope.js";

/** A map of four boxes over two packages and three layers — enough that a layer holds two
 *  components and a package holds two layers, which is what makes "a parent is every file
 *  of its children" a claim worth testing. Written here rather than read from the
 *  repository's own map so a row moving in `components.yaml` cannot make these pass or
 *  fail for a reason that has nothing to do with resolution. */
const map: ComponentMap = {
  layers: ["gate", "data", "service"],
  components: [
    { name: "model", package: "core", layer: "gate", isComponent: true, owns: "the entities", modules: ["types", "entities"] },
    { name: "engine", package: "core", layer: "gate", isComponent: true, owns: "apply a verb", modules: ["apply"] },
    { name: "store", package: "core", layer: "data", isComponent: true, owns: "the database", modules: ["db"] },
    { name: "trees", package: "runner", layer: "service", isComponent: true, owns: "every branch", modules: ["git"] },
  ],
};

const resolve = (write: readonly string[], tools: readonly string[] = ["read"]) =>
  resolveScope({ write, tools }, map);

const writeOf = (write: readonly string[]): readonly string[] => {
  const r = resolve(write);
  if (!r.ok) throw new Error(r.why);
  return r.resolved.scope.write;
};

describe("a scope may name a node", () => {
  it("resolves a component to a glob per module it owns", () => {
    expect(writeOf(["wecode/core/gate/model"])).toEqual([
      "packages/core/src/entities.*",
      "packages/core/src/types.*",
    ]);
  });

  it("resolves a module to a glob rather than a file, because the map does not say what it is written in", () => {
    for (const glob of writeOf(["wecode/runner/service/trees"])) expect(glob).toMatch(/\.\*$/);
  });

  it("resolves a layer to every file of its components", () => {
    expect(writeOf(["wecode/core/gate"])).toEqual([
      "packages/core/src/apply.*",
      "packages/core/src/entities.*",
      "packages/core/src/types.*",
    ]);
  });

  it("resolves a package to every file of its layers", () => {
    expect(writeOf(["wecode/core"])).toEqual([
      "packages/core/src/apply.*",
      "packages/core/src/db.*",
      "packages/core/src/entities.*",
      "packages/core/src/types.*",
    ]);
  });

  it("resolves the system to the lot", () => {
    expect(writeOf([ROOT])).toHaveLength(5);
  });

  it("leaves a path alone: a scope with no node in it resolves to itself", () => {
    const write = ["packages/*/src/**", "packages/runner/test/scope.test.ts", "**"];
    expect(writeOf(write)).toEqual(write);
  });

  it("keeps paths and nodes in the order they were written", () => {
    expect(writeOf(["docs/**", "wecode/core/data/store", "config/roles.yaml"])).toEqual([
      "docs/**",
      "packages/core/src/db.*",
      "config/roles.yaml",
    ]);
  });

  it("names two nodes without repeating what they share", () => {
    const write = writeOf(["wecode/core/gate", "wecode/core/gate/model"]);
    expect(write).toEqual([...new Set(write)]);
    expect(write).toHaveLength(3);
  });

  it("passes the tools through: the map says what a box owns, never what a worker may run", () => {
    const r = resolve(["wecode/core"], ["bash", "edit"]);
    expect(r.ok && r.resolved.scope.tools).toEqual(["bash", "edit"]);
  });

  it("says which node each glob came from", () => {
    const r = resolve(["packages/cli/src/bin.ts", "wecode/core/data/store"]);
    expect(r.ok && r.resolved.nodes).toEqual([{ node: "wecode/core/data/store", write: ["packages/core/src/db.*"] }]);
  });

  it("reports no node when the scope named none", () => {
    expect(resolve(["packages/*/src/**"])).toEqual({
      ok: true,
      resolved: { scope: { write: ["packages/*/src/**"], tools: ["read"] }, nodes: [] },
    });
  });

  it("refuses an address the map has nothing at, rather than dropping it", () => {
    const r = resolve(["wecode/core/gate/enginne"]);
    expect(r).toEqual({ ok: false, why: "no node at wecode/core/gate/enginne: the map has nothing there" });
  });

  it("refuses a package the map does not have", () => {
    expect(resolve(["wecode/tui"]).ok).toBe(false);
  });

  it("refuses a node even when the rest of the scope would have resolved", () => {
    expect(resolve(["packages/core/src/apply.ts", "wecode/nowhere"]).ok).toBe(false);
  });

  it("does not match a node whose address merely starts with the one asked for", () => {
    // `wecode/core/gate/mod` is a prefix of `wecode/core/gate/model` as a string, and is
    // not a node. Only a whole segment counts.
    expect(resolve(["wecode/core/gate/mod"]).ok).toBe(false);
  });

  it("reads a node address by its root and nothing else", () => {
    expect(namesANode("wecode/core")).toBe(true);
    expect(namesANode(ROOT)).toBe(true);
    expect(namesANode("packages/core/src/apply.ts")).toBe(false);
    expect(namesANode("wecodex/core")).toBe(false);
    expect(namesANode("**")).toBe(false);
  });

  it("answers null for an address the map has nothing at", () => {
    expect(nodeGlobs(map, "wecode/core/gate/model")).toEqual(["packages/core/src/entities.*", "packages/core/src/types.*"]);
    expect(nodeGlobs(map, "wecode/core/presentation")).toBeNull();
  });

  it("resolves against the map wecode ships when it is given no other", () => {
    // Not a fixture: this is the claim that the addresses in the shipped map are the
    // addresses an operator would write, so a scope naming a real box really does dispatch.
    const shipped = resolveScope({ write: ["wecode/runner/service/trees"], tools: [] }, loadComponents());
    expect(shipped.ok && shipped.resolved.scope.write).toEqual(["packages/runner/src/git.*"]);
  });
});
