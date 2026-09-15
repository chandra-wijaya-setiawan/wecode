import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claims,
  ComponentError,
  loadComponents,
  ownerOf,
  type ComponentMap,
} from "../src/index.js";
import { tmp } from "./tmpdir.js";

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));
const EXTENSIONS = [".ts", ".tsx"] as const;

/** Every module in the source tree, as `<package>/<module>` — a path relative to the
 *  package's `src/` with the extension dropped, which is how the map names one. */
function tree(): readonly string[] {
  const found: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    if (!existsSync(src)) continue;
    walk(src, "", (file) => found.push(`${pkg}/${file}`));
  }
  return found.sort();
}

function walk(dir: string, prefix: string, seen: (module: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walk(join(dir, entry.name), `${prefix}${entry.name}/`, seen);
      continue;
    }
    const ext = EXTENSIONS.find((e) => entry.name.endsWith(e));
    if (ext) seen(`${prefix}${entry.name.slice(0, -ext.length)}`);
  }
}

const map: ComponentMap = loadComponents();

const written = (body: string): string => {
  const path = join(tmp(), "components.yaml");
  writeFileSync(path, body);
  return path;
};

describe("the component map", () => {
  it("claims every module in the tree", () => {
    const unclaimed = tree().filter((m) => !claims(map).includes(m));
    expect(unclaimed, "modules no component owns").toEqual([]);
  });

  it("claims nothing that is not in the tree", () => {
    const missing = claims(map).filter((c) => !tree().includes(c));
    expect(missing, "modules a component owns that do not exist").toEqual([]);
  });

  it("claims no module twice", () => {
    const owners = new Map<string, string[]>();
    for (const c of map.components) {
      for (const m of c.modules) {
        const key = `${c.package}/${m}`;
        owners.set(key, [...(owners.get(key) ?? []), c.name]);
      }
    }
    const shared = [...owners].filter(([, names]) => names.length > 1);
    expect(shared, "modules more than one component owns").toEqual([]);
  });

  it("covers the tree exactly once", () => {
    expect(claims(map).length).toBe(tree().length);
    expect([...claims(map)].sort()).toEqual(tree());
  });

  it("names one owner per module, and says what it owns", () => {
    for (const m of tree()) {
      const [pkg, ...rest] = m.split("/");
      const owner = ownerOf(map, pkg as string, rest.join("/"));
      expect(owner, m).not.toBeNull();
      expect(owner?.owns.length, `${m}: ${owner?.name} says nothing about what it owns`)
        .toBeGreaterThan(10);
    }
  });

  it("puts every component in a declared layer of a real package", () => {
    for (const c of map.components) {
      expect(map.layers, `${c.name}: layer ${c.layer}`).toContain(c.layer);
      expect(existsSync(join(PACKAGES, c.package, "src")), `${c.name}: package ${c.package}`).toBe(
        true,
      );
    }
  });

  it("keeps the two rows that are not components, and no more", () => {
    const notComponents = map.components.filter((c) => !c.isComponent).map((c) => c.layer);
    expect([...new Set(notComponents)].sort()).toEqual(["files", "surface"]);
  });
});

describe("loading a component map", () => {
  it("refuses one with no components", () => {
    expect(() => loadComponents(written("layers:\n  gate: the gate\n"))).toThrow(ComponentError);
  });

  it("refuses a row that does not say what it owns", () => {
    const body = "components:\n  engine:\n    package: core\n    layer: gate\n    modules: [apply]\n";
    expect(() => loadComponents(written(body))).toThrow(/engine: a component needs/);
  });

  it("refuses a row that owns no module", () => {
    const body = "components:\n  notifier:\n    package: runner\n    layer: service\n    owns: tells somebody\n";
    expect(() => loadComponents(written(body))).toThrow(/notifier: owns no module/);
  });

  it("reads a row's modules and whether it is a component at all", () => {
    const body =
      "components:\n  files:\n    package: core\n    layer: files\n    component: false\n    owns: what is declared\n    modules: [roles, stacks]\n";
    const one = loadComponents(written(body));
    expect(one.components).toEqual([
      {
        name: "files",
        package: "core",
        layer: "files",
        isComponent: false,
        owns: "what is declared",
        modules: ["roles", "stacks"],
      },
    ]);
  });
});
