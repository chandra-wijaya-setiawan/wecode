import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadComponents, type ComponentMap } from "@wecode/core";
import { describe, expect, it } from "vitest";
import {
  ArchitectureError,
  loadArchitecture,
  nodeAt,
  nodes,
  unclaimed,
  type ArchNode,
} from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** wecode's own checkout — the model every suite below that asks about the real thing
 *  binds the shipped map to. */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** A fixture checkout: two packages, four boxes over three layers, and one module the map
 *  will be asked about that is written as `.tsx` rather than `.ts` — the resolution a
 *  caller must not have to think about. */
const FIXTURE: Readonly<Record<string, string>> = {
  "packages/core/src/store.ts": "export const store = 1;\n",
  "packages/core/src/db.ts": "export const db = 1;\n",
  "packages/core/src/types.ts": "export type T = 1;\n",
  "packages/core/src/index.ts": "export {};\n",
  "packages/ui/src/panel.tsx": "export const Panel = () => null;\n",
  "packages/ui/src/index.ts": "export {};\n",
};

const MAP = `layers:
  gate: what may exist
  data: the store
  client: how a person reaches a verb
  surface: an entry point

components:
  model:
    package: core
    layer: gate
    component: true
    owns: the entities and their state machines
    modules: [types]

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

  view-index:
    package: ui
    layer: client
    component: true
    owns: the screens a person reads, stated as ports
    modules: [panel, index]
`;

/** Writes a checkout and a map beside it, and returns both paths. */
function fixture(body: string = MAP, files: Readonly<Record<string, string>> = FIXTURE): {
  root: string;
  map: ComponentMap;
} {
  const root = tmp("wecode-arch-");
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const mapPath = join(root, "components.yaml");
  writeFileSync(mapPath, body);
  return { root, map: loadComponents(mapPath) };
}

const paths = (nodeList: readonly ArchNode[]): readonly string[] => nodeList.map((n) => n.path);

describe("binding a map to a model", () => {
  it("resolves a component to the files the map claims for it", () => {
    const { root, map } = fixture();
    const arch = loadArchitecture(root, map);

    expect(nodeAt(arch, "wecode/core/data/store")?.files).toEqual([
      "packages/core/src/db.ts",
      "packages/core/src/store.ts",
    ]);
  });

  it("resolves a module written as .tsx as readily as one written as .ts", () => {
    const { root, map } = fixture();
    const arch = loadArchitecture(root, map);

    expect(nodeAt(arch, "wecode/ui/client/view-index")?.files).toEqual([
      "packages/ui/src/index.ts",
      "packages/ui/src/panel.tsx",
    ]);
  });

  it("gives every node an address, parents before children, in the map's own order", () => {
    const { root, map } = fixture();

    expect(paths(nodes(loadArchitecture(root, map)))).toEqual([
      "wecode",
      "wecode/core",
      "wecode/core/gate",
      "wecode/core/gate/model",
      "wecode/core/data",
      "wecode/core/data/store",
      "wecode/core/surface",
      "wecode/core/surface/core surface",
      "wecode/ui",
      "wecode/ui/client",
      "wecode/ui/client/view-index",
    ]);
  });

  it("answers nothing for an address the tree does not have", () => {
    const { root, map } = fixture();

    expect(nodeAt(loadArchitecture(root, map), "wecode/core/gate/engine")).toBeNull();
  });

  it("says which kind each node is, and which of them are boxes", () => {
    const { root, map } = fixture();
    const arch = loadArchitecture(root, map);

    expect(nodeAt(arch, "wecode")?.kind).toBe("system");
    expect(nodeAt(arch, "wecode/core")?.kind).toBe("package");
    expect(nodeAt(arch, "wecode/core/data")?.kind).toBe("layer");
    expect(nodeAt(arch, "wecode/core/data/store")?.kind).toBe("component");

    const boxes = nodes(arch).filter((n) => n.isComponent);
    expect(paths(boxes)).toEqual([
      "wecode/core/gate/model",
      "wecode/core/data/store",
      "wecode/ui/client/view-index",
    ]);
  });

  it("carries what the map says a box owns, and says nothing for a node above one", () => {
    const { root, map } = fixture();
    const arch = loadArchitecture(root, map);

    expect(nodeAt(arch, "wecode/core/data/store")?.owns).toBe(
      "opening the database, and every row",
    );
    expect(nodeAt(arch, "wecode/core/data")?.owns).toBe("");
    expect(nodeAt(arch, "wecode")?.owns).toBe("");
  });
});

describe("a node above a component", () => {
  it("resolves to every file of its children, and nothing else", () => {
    const { root, map } = fixture();
    const arch = loadArchitecture(root, map);

    for (const node of nodes(arch)) {
      if (node.children.length === 0) continue;
      const below = [...new Set(node.children.flatMap((c) => c.files))].sort();
      expect(node.files, node.path).toEqual(below);
    }
  });

  it("resolves the whole system to every file the map claims", () => {
    const { root, map } = fixture();

    expect(loadArchitecture(root, map).tree.files).toEqual([
      "packages/core/src/db.ts",
      "packages/core/src/index.ts",
      "packages/core/src/store.ts",
      "packages/core/src/types.ts",
      "packages/ui/src/index.ts",
      "packages/ui/src/panel.tsx",
    ]);
  });
});

describe("a map that has drifted from its model", () => {
  it("reports a claim with no file rather than throwing", () => {
    const { root, map } = fixture(`${MAP}
  ghost:
    package: core
    layer: gate
    component: true
    owns: a box whose module was deleted
    modules: [vanished]
`);
    const arch = loadArchitecture(root, map);

    expect(arch.missing).toEqual(["core/vanished"]);
    expect(nodeAt(arch, "wecode/core/gate/ghost")?.files).toEqual([]);
  });

  it("keeps the files of a box whose other claim is missing", () => {
    const body = MAP.replace("modules: [store, db]", "modules: [store, db, cache]");
    const { root, map } = fixture(body);
    const arch = loadArchitecture(root, map);

    expect(arch.missing).toEqual(["core/cache"]);
    expect(nodeAt(arch, "wecode/core/data/store")?.files).toEqual([
      "packages/core/src/db.ts",
      "packages/core/src/store.ts",
    ]);
  });

  it("names a module of the tree that no box claims", () => {
    const { map } = fixture();

    expect(unclaimed(map, ["core/store", "core/orphan", "ui/panel"])).toEqual(["core/orphan"]);
  });

  it("names nothing when every module of the tree is claimed", () => {
    const { map } = fixture();

    expect(unclaimed(map, ["core/types", "ui/panel"])).toEqual([]);
  });
});

describe("a model that is not a checkout", () => {
  it("refuses a path that is not a directory", () => {
    const { root, map } = fixture();

    expect(() => loadArchitecture(join(root, "components.yaml"), map)).toThrow(ArchitectureError);
  });

  it("refuses a directory with no packages in it", () => {
    expect(() => loadArchitecture(tmp("wecode-empty-"))).toThrow(/no packages directory/);
  });
});

describe("wecode's own architecture", () => {
  it("binds the shipped map to this checkout with nothing missing", () => {
    expect(loadArchitecture(REPO).missing).toEqual([]);
  });

  it("resolves every node to at least one file", () => {
    const withoutFiles = nodes(loadArchitecture(REPO)).filter((n) => n.files.length === 0);

    expect(paths(withoutFiles)).toEqual([]);
  });

  it("puts this package's modules in the box that claims them", () => {
    const arch = loadArchitecture(REPO);

    expect(nodeAt(arch, "wecode/explorer/service/repo-explorer")?.files).toEqual(
      nodeAt(arch, "wecode/explorer")?.files,
    );
    expect(nodeAt(arch, "wecode/explorer")?.files).toContain("packages/explorer/src/ports.ts");
  });

  it("resolves the system to every file of every package", () => {
    const arch = loadArchitecture(REPO);
    const perPackage = arch.tree.children.flatMap((p) => p.files);

    expect(arch.tree.files).toEqual([...new Set(perPackage)].sort());
    expect(arch.tree.files.length).toBe(perPackage.length);
  });
});
