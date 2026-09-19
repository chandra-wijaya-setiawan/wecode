import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadComponents } from "@wecode/core";
import { describe, expect, it } from "vitest";
import {
  agreement,
  asProposal,
  propose,
  type ModuleImports,
  type Proposal,
} from "../src/propose.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A tree stated the way a caller gathers one: module, then what it imports. */
const tree = (rows: Readonly<Record<string, readonly string[]>>): readonly ModuleImports[] =>
  Object.entries(rows).map(([module, imports]) => ({ module, imports }));

/** The proposal as `<package>:<name> -> modules`, which is what every assertion below is
 *  really about — which modules ended up together, and what the box got called. */
const shape = (proposal: Proposal): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries(proposal.components.map((c) => [`${c.package}:${c.name}`, c.modules]));

describe("clustering modules on their imports", () => {
  it("puts modules that import each other in one box", () => {
    const proposal = propose(
      tree({
        "core/store": ["core/db"],
        "core/db": [],
      }),
    );

    expect(shape(proposal)).toEqual({ "core:db": ["core/db", "core/store"] });
  });

  it("follows a chain, so two modules joined by a third are one box", () => {
    const proposal = propose(
      tree({
        "core/apply": ["core/cascade"],
        "core/cascade": ["core/guards"],
        "core/guards": [],
      }),
    );

    expect(shape(proposal)).toEqual({
      "core:cascade": ["core/apply", "core/cascade", "core/guards"],
    });
  });

  it("leaves modules that never mention each other in boxes of their own", () => {
    const proposal = propose(
      tree({
        "core/store": ["core/db"],
        "core/db": [],
        "core/board": [],
      }),
    );

    expect(shape(proposal)).toEqual({
      "core:db": ["core/db", "core/store"],
      "core:board": ["core/board"],
    });
  });

  it("names a box after the module the rest of it depends on most", () => {
    const proposal = propose(
      tree({
        "core/apply": ["core/types"],
        "core/edit": ["core/types"],
        "core/types": [],
      }),
    );

    expect(Object.keys(shape(proposal))).toEqual(["core:types"]);
  });

  it("breaks a tie for the most-imported module by name, not by input order", () => {
    const rows = { "core/zebra": [], "core/apple": ["core/zebra"], "core/mango": ["core/apple"] };
    const reversed = Object.fromEntries(Object.entries(rows).reverse());

    expect(Object.keys(shape(propose(tree(rows))))).toEqual(["core:apple"]);
    expect(Object.keys(shape(propose(tree(reversed))))).toEqual(["core:apple"]);
  });

  it("names a nested module's box by its last segment, and keeps its full spelling", () => {
    const proposal = propose(
      tree({ "runner/worker": ["runner/adapters/codex"], "runner/adapters/codex": [] }),
    );

    expect(shape(proposal)).toEqual({
      "runner:codex": ["runner/adapters/codex", "runner/worker"],
    });
  });

  it("sorts the modules of a box, whatever order the tree arrived in", () => {
    const proposal = propose(
      tree({ "core/store": [], "core/db": ["core/store"], "core/apply": ["core/db"] }),
    );

    expect(proposal.components[0]?.modules).toEqual(["core/apply", "core/db", "core/store"]);
  });

  it("proposes nothing for an empty tree", () => {
    expect(propose([]).components).toEqual([]);
  });
});

describe("what clustering refuses to count", () => {
  it("ignores an import that leaves the package, which would join every box to every box", () => {
    const proposal = propose(
      tree({
        "cli/run": ["core/apply"],
        "cli/plan": ["core/apply"],
        "core/apply": [],
      }),
    );

    expect(shape(proposal)).toEqual({
      "cli:run": ["cli/run"],
      "cli:plan": ["cli/plan"],
      "core:apply": ["core/apply"],
    });
  });

  it("ignores an import of something the tree does not have", () => {
    const proposal = propose(tree({ "core/store": ["core/deleted", "node:fs"] }));

    expect(shape(proposal)).toEqual({ "core:store": ["core/store"] });
  });

  it("ignores a module importing itself", () => {
    const proposal = propose(tree({ "core/store": ["core/store"], "core/db": [] }));

    expect(shape(proposal)).toEqual({ "core:store": ["core/store"], "core:db": ["core/db"] });
  });
});

describe("a package's entry points", () => {
  it("lifts index and bin into a surface row rather than clustering on them", () => {
    const proposal = propose(
      tree({
        "core/index": ["core/store", "core/board"],
        "core/bin": ["core/index"],
        "core/store": [],
        "core/board": [],
      }),
    );

    expect(shape(proposal)).toEqual({
      "core:store": ["core/store"],
      "core:board": ["core/board"],
      "core:core surface": ["core/bin", "core/index"],
    });
  });

  it("says a surface row is not a component, and every cluster is", () => {
    const proposal = propose(tree({ "core/index": ["core/store"], "core/store": [] }));

    expect(proposal.components.map((c) => [c.name, c.isComponent])).toEqual([
      ["store", true],
      ["core surface", false],
    ]);
  });

  it("puts the surface row last, after the boxes of its own package", () => {
    const proposal = propose(
      tree({ "core/index": [], "core/store": [], "ui/index": [], "ui/check": [] }),
    );

    expect(Object.keys(shape(proposal))).toEqual([
      "core:store",
      "core:core surface",
      "ui:check",
      "ui:ui surface",
    ]);
  });

  it("proposes a surface row and nothing else for a package that is only an entry point", () => {
    expect(shape(propose(tree({ "core/index": [] })))).toEqual({
      "core:core surface": ["core/index"],
    });
  });

  it("lets the caller say what an entry point is in this tree", () => {
    const rows = tree({ "core/main": ["core/store"], "core/store": [] });

    expect(shape(propose(rows, ["main"]))).toEqual({
      "core:store": ["core/store"],
      "core:core surface": ["core/main"],
    });
    expect(shape(propose(rows, []))).toEqual({ "core:store": ["core/main", "core/store"] });
  });
});

/** A map written the way `components.yaml` is, for the comparisons below. */
const MAP = `layers:
  gate: what may exist
  data: the store
  surface: an entry point

components:
  engine:
    package: core
    layer: gate
    component: true
    owns: applying a verb
    modules: [apply, cascade]

  store:
    package: core
    layer: data
    component: true
    owns: opening the database, and every row
    modules: [store, db]

  core surface:
    package: core
    layer: surface
    component: false
    owns: what a client of the package may import
    modules: [index]
`;

/** Loads a map from a file, since that is the only way `loadComponents` takes one. */
function mapOf(body: string = MAP): Proposal {
  const path = join(tmp("wecode-propose-"), "components.yaml");
  writeFileSync(path, body);
  return asProposal(loadComponents(path));
}

describe("a map stated as a proposal", () => {
  it("spells its modules as the tree does, package and all", () => {
    expect(shape(mapOf())).toEqual({
      "core:engine": ["core/apply", "core/cascade"],
      "core:store": ["core/db", "core/store"],
      "core:core surface": ["core/index"],
    });
  });

  it("keeps which of its rows are components", () => {
    expect(mapOf().components.filter((c) => !c.isComponent).map((c) => c.name)).toEqual([
      "core surface",
    ]);
  });
});

describe("holding a proposal against a map", () => {
  const AS_MAPPED = tree({
    "core/apply": ["core/cascade"],
    "core/cascade": [],
    "core/store": ["core/db"],
    "core/db": [],
    "core/index": ["core/apply", "core/store"],
  });

  it("agrees completely when the two group the same modules, whatever the boxes are called", () => {
    const verdict = agreement(propose(AS_MAPPED), mapOf());

    expect(verdict.ratio).toBe(1);
    expect(verdict.disputed).toEqual([]);
    expect(verdict.same).toBe(verdict.pairs);
  });

  it("names the pairs the code puts together that the map keeps apart", () => {
    const merged = tree({ ...Object.fromEntries(AS_MAPPED.map((m) => [m.module, m.imports])) });
    const proposal = propose([
      ...merged.filter((m) => m.module !== "core/store"),
      { module: "core/store", imports: ["core/db", "core/cascade"] },
    ]);

    expect(agreement(proposal, mapOf()).disputed).toEqual([
      "core/apply core/db",
      "core/apply core/store",
      "core/cascade core/db",
      "core/cascade core/store",
    ]);
  });

  it("counts the pairs it asked about, and calls a disagreement a fall in the ratio", () => {
    const apart = propose(AS_MAPPED.map((m) => ({ module: m.module, imports: [] })));
    const verdict = agreement(apart, mapOf());

    expect(verdict.pairs).toBe(10);
    expect(verdict.same).toBe(8);
    expect(verdict.ratio).toBeCloseTo(0.8);
    expect(verdict.disputed).toEqual(["core/apply core/cascade", "core/db core/store"]);
  });

  it("asks nothing of a pair from two packages, which no map puts together", () => {
    const verdict = agreement(
      propose(tree({ "core/store": [], "ui/check": [] })),
      mapOf(`${MAP}
  view-index:
    package: ui
    layer: gate
    component: true
    owns: the screens a person reads
    modules: [check]
`),
    );

    expect(verdict.pairs).toBe(0);
    expect(verdict.ratio).toBe(1);
  });

  it("asks nothing of a module only one side knows", () => {
    const verdict = agreement(propose(tree({ "core/store": ["core/db"], "core/db": [] })), mapOf());

    expect(verdict.pairs).toBe(1);
    expect(verdict.disputed).toEqual([]);
  });
});

/** This package, read off disk — every `.ts` under `src`, and the relative imports it
 *  makes, which is enough to cluster on without an index. */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sources(dir: string, prefix = ""): readonly ModuleImports[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sources(join(dir, entry.name), `${prefix}${entry.name}/`);
    if (!entry.name.endsWith(".ts")) return [];
    const body = readFileSync(join(dir, entry.name), "utf8");
    const here = prefix.split("/").slice(0, -1);
    const imports = [...body.matchAll(/from "(\.[^"]+)"/g)].map(([, spec]) => {
      const parts = [...here, ...(spec as string).replace(/\.js$/, "").split("/")];
      const out: string[] = [];
      for (const part of parts) {
        if (part === ".") continue;
        else if (part === "..") out.pop();
        else out.push(part);
      }
      return `explorer/${out.join("/")}`;
    });
    return [{ module: `explorer/${prefix}${entry.name.replace(/\.ts$/, "")}`, imports }];
  });
}

describe("the explorer's own source", () => {
  const proposal = propose(sources(SRC));

  it("clusters the port with the two modules that are written against it", () => {
    const withPorts = proposal.components.find((c) => c.modules.includes("explorer/ports"));

    expect(withPorts?.modules).toEqual(
      expect.arrayContaining([
        "explorer/adapters/codegraph",
        "explorer/architecture",
        "explorer/ports",
        "explorer/reflexion",
      ]),
    );
  });

  it("keeps the two pure measurements out of it, since neither imports a thing here", () => {
    expect(shape(proposal)["explorer:coverage"]).toEqual(["explorer/coverage"]);
    expect(shape(proposal)["explorer:propose"]).toEqual(["explorer/propose"]);
  });

  it("puts the package's entry point in a surface row", () => {
    expect(shape(proposal)["explorer:explorer surface"]).toEqual(["explorer/index"]);
  });

  it("disagrees with the shipped map exactly where the map draws one box round the lot", () => {
    const verdict = agreement(proposal, asProposal(loadComponents()));

    expect(verdict.ratio).toBeLessThan(1);
    expect(verdict.disputed).toContain("explorer/coverage explorer/ports");
  });
});
