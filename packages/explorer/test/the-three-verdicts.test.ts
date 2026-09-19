import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { loadComponents } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { loadArchitecture, type Architecture } from "../src/architecture.js";
import { UnknownFile, type Imported, type Reading, type RepoIndex } from "../src/ports.js";
import { reflect, type Model } from "../src/reflexion.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The fixture checkout: two packages and three boxes, chosen so the model has something
 *  to forbid and the tree something to break.
 *
 *    shared/src/types.ts   the words every package uses, and the plant
 *    api/src/routes.ts     the verbs a client may call — reaches shared, as it should
 *    api/src/index.ts      the package's surface, which reaches nothing at all
 *
 *  `shared` is the node a model puts at the bottom: everything may reach it, and it may
 *  reach nothing. The plant is one import in `types.ts` that reaches back up into `api`,
 *  which is precisely the edge the model forbids and precisely the edge nobody notices in
 *  a diff. */
const SHARED_CLEAN = `export type Id = string;\n`;

/** The plant. One line, reaching up out of the bottom of the model. */
const SHARED_BROKEN = `import type { Route } from "../../api/src/routes.js";

export type Id = string;
export type Named = Route;
`;

const FIXTURE: Readonly<Record<string, string>> = {
  "packages/shared/src/types.ts": SHARED_CLEAN,
  "packages/api/src/routes.ts": `import type { Id } from "../../shared/src/types.js";

export interface Route {
  readonly id: Id;
}
`,
  "packages/api/src/index.ts": `export {};\n`,
};

const MAP = `layers:
  gate: what may exist
  service: what the system does
  surface: an entry point

components:
  words:
    package: shared
    layer: gate
    component: true
    owns: the words every package uses
    modules: [types]

  routes:
    package: api
    layer: service
    component: true
    owns: the verbs a client may call
    modules: [routes]

  api surface:
    package: api
    layer: surface
    component: false
    owns: what a client of the package may import
    modules: [index]
`;

const WORDS = "wecode/shared/gate/words";
const ROUTES = "wecode/api/service/routes";
const SURFACE = "wecode/api/surface/api surface";

/** The model the suite holds the tree against.
 *
 *  `words` reaches nothing — that is how it forbids reaching `api`. `routes` may reach
 *  `words`, and does. The surface may reach `routes`, and does not, which is the absence.
 */
const MODEL: Model = {
  nodes: [
    { path: WORDS, reaches: [] },
    { path: ROUTES, reaches: [WORDS] },
    { path: SURFACE, reaches: [ROUTES] },
  ],
};

/** An index of the planted tree, reading the files that were actually written.
 *
 *  The port exists so the answers are the contract and the thing computing them is
 *  replaceable; this is the second implementation. It reads each file off disk and reports
 *  the specifiers it writes, so the plant below is what drives every verdict — not a list
 *  of edges the test also wrote down, which would prove only that the test agrees with
 *  itself. */
function planted(root: string): RepoIndex {
  const read = async (file: string): Promise<Reading> => {
    let source: string;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch {
      throw new UnknownFile(file, root);
    }
    const imports: Imported[] = [...source.matchAll(/^import[^"']*["']([^"']+)["'];$/gm)].map(
      (match) => ({
        name: "*",
        kind: "named" as const,
        from: match[1] ?? "",
        resolved: resolve(file, match[1] ?? ""),
      }),
    );
    return { file, defines: [], imports };
  };
  return {
    root,
    read,
    usesOf: () => {
      throw new Error("the three verdicts do not ask who uses a symbol");
    },
    purposeOf: () => {
      throw new Error("the three verdicts do not ask what a module is for");
    },
  };
}

/** Where a specifier written in `file` lands, repository-relative and POSIX-separated, or
 *  null when it leaves the tree. `.js` is what the source writes; `.ts` is what is there. */
function resolve(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  return target.replace(/\.js$/, ".ts");
}

/** Writes a checkout with the given overrides, and binds the map to it. */
function fixture(overrides: Readonly<Record<string, string>> = {}): {
  arch: Architecture;
  index: RepoIndex;
} {
  const root = tmp("wecode-reflexion-");
  for (const [rel, content] of Object.entries({ ...FIXTURE, ...overrides })) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const mapPath = join(root, "components.yaml");
  writeFileSync(mapPath, MAP);
  return { arch: loadArchitecture(root, loadComponents(mapPath)), index: planted(root) };
}

describe("an edge the model forbids", () => {
  it("names both nodes and the file that proves it", async () => {
    const { arch, index } = fixture({ "packages/shared/src/types.ts": SHARED_BROKEN });

    const { findings } = await reflect(MODEL, arch, index);

    expect(findings).toContainEqual({
      verdict: "divergence",
      from: WORDS,
      to: ROUTES,
      file: "packages/shared/src/types.ts",
    });
  });

  it("is not reported when nothing writes it", async () => {
    const { arch, index } = fixture();

    const { findings } = await reflect(MODEL, arch, index);

    expect(findings.filter((f) => f.verdict === "divergence")).toEqual([]);
  });
});

describe("an edge the model allows", () => {
  it("converges when a file makes it, naming the importer", async () => {
    const { arch, index } = fixture();

    const { findings } = await reflect(MODEL, arch, index);

    expect(findings).toContainEqual({
      verdict: "convergence",
      from: ROUTES,
      to: WORDS,
      file: "packages/api/src/routes.ts",
    });
  });

  it("is absent, with no file, when no file makes it", async () => {
    const { arch, index } = fixture();

    const { findings } = await reflect(MODEL, arch, index);

    expect(findings).toContainEqual({
      verdict: "absence",
      from: SURFACE,
      to: ROUTES,
      file: null,
    });
  });
});

describe("the three verdicts together", () => {
  it("says one thing about every pair worth saying anything about", async () => {
    const { arch, index } = fixture({ "packages/shared/src/types.ts": SHARED_BROKEN });

    const { findings } = await reflect(MODEL, arch, index);

    expect(findings).toEqual([
      { verdict: "divergence", from: WORDS, to: ROUTES, file: "packages/shared/src/types.ts" },
      { verdict: "convergence", from: ROUTES, to: WORDS, file: "packages/api/src/routes.ts" },
      { verdict: "absence", from: SURFACE, to: ROUTES, file: null },
    ]);
  });

  it("keeps quiet about a pair the model forbids and no file writes", async () => {
    const { arch, index } = fixture();

    const { findings } = await reflect(MODEL, arch, index);

    expect(findings.map((f) => [f.from, f.to])).not.toContainEqual([WORDS, SURFACE]);
  });
});

describe("a model that has drifted from the architecture", () => {
  it("reports an address the tree has no node at rather than throwing", async () => {
    const { arch, index } = fixture();
    const drifted: Model = {
      nodes: [...MODEL.nodes, { path: "wecode/api/service/ghost", reaches: ["wecode/nowhere"] }],
    };

    const { unknown } = await reflect(drifted, arch, index);

    expect(unknown).toEqual(["wecode/api/service/ghost", "wecode/nowhere"]);
  });

  it("judges no edge that touches such a node", async () => {
    const { arch, index } = fixture();
    const drifted: Model = {
      nodes: [...MODEL.nodes, { path: "wecode/api/service/ghost", reaches: [WORDS] }],
    };

    const { findings } = await reflect(drifted, arch, index);

    expect(findings.map((f) => f.from)).not.toContain("wecode/api/service/ghost");
  });
});
