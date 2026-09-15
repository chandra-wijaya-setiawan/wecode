import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const STACKS = fileURLToPath(new URL("../config/stacks.yaml", import.meta.url));
const COMPONENTS = fileURLToPath(new URL("../config/components.yaml", import.meta.url));

export class StackError extends Error {}

export interface Stack {
  readonly name: string;
  readonly marker: string;
  readonly test: string;
  readonly typecheck: string | null;
  readonly source: readonly string[];
  readonly tests: readonly string[];
}

export function loadStacks(path: string = STACKS): readonly Stack[] {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  const stacks = (raw as Record<string, unknown> | null)?.["stacks"];
  if (stacks === null || typeof stacks !== "object") throw new StackError("stacks.yaml has no stacks");

  return Object.entries(stacks as Record<string, Record<string, unknown>>).map(([name, s]) => {
    const marker = s["marker"];
    const test = s["test"];
    if (typeof marker !== "string" || typeof test !== "string") {
      throw new StackError(`${name}: a stack needs a marker and a test command`);
    }
    return {
      name,
      marker,
      test,
      typecheck: typeof s["typecheck"] === "string" ? s["typecheck"] : null,
      source: list(s["source"]),
      tests: list(s["tests"]),
    };
  });
}

const list = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The first stack whose marker is in the repository. Order in the file is the tie-break,
 *  which is why lock files come before the manifests they sit beside. */
export function detect(repo: string, stacks: readonly Stack[] = loadStacks()): Stack | null {
  return stacks.find((s) => existsSync(join(repo, s.marker))) ?? null;
}

export class ComponentError extends Error {}

/** One row of docs/design/01's component table: a box, and the modules it owns.
 *
 *  `modules` are named without an extension, relative to the package's `src/` — the map
 *  says which box a module is in, not what it is written in. `isComponent` is false for
 *  the two rows that are in the table without being boxes: the declared files, and a
 *  package's entry point. */
export interface Component {
  readonly name: string;
  readonly package: string;
  readonly layer: string;
  readonly isComponent: boolean;
  readonly owns: string;
  readonly modules: readonly string[];
}

export interface ComponentMap {
  readonly layers: readonly string[];
  readonly components: readonly Component[];
}

export function loadComponents(path: string = COMPONENTS): ComponentMap {
  const raw = (parse(readFileSync(path, "utf8")) as Record<string, unknown> | null) ?? {};
  const components = raw["components"];
  if (components === null || typeof components !== "object") {
    throw new ComponentError("components.yaml has no components");
  }
  const layers = raw["layers"];
  return {
    layers: layers !== null && typeof layers === "object" ? Object.keys(layers) : [],
    components: Object.entries(components as Record<string, Record<string, unknown>>).map(
      ([name, c]) => {
        const pkg = c["package"];
        const layer = c["layer"];
        const owns = c["owns"];
        if (typeof pkg !== "string" || typeof layer !== "string" || typeof owns !== "string") {
          throw new ComponentError(`${name}: a component needs a package, a layer and what it owns`);
        }
        const modules = list(c["modules"]);
        if (modules.length === 0) throw new ComponentError(`${name}: owns no module`);
        return { name, package: pkg, layer, isComponent: c["component"] !== false, owns, modules };
      },
    ),
  };
}

/** Every module the map claims, as `<package>/<module>` — the key the tree is compared by. */
export const claims = (map: ComponentMap): readonly string[] =>
  map.components.flatMap((c) => c.modules.map((m) => `${c.package}/${m}`));

/** What owns a module, or null when the map does not claim it. */
export const ownerOf = (map: ComponentMap, pkg: string, module: string): Component | null =>
  map.components.find((c) => c.package === pkg && c.modules.includes(module)) ?? null;

/** What onboarding learned. Everything else defaults to it rather than retyping it. */
export interface ProjectConfig {
  readonly stack: string;
  readonly test: string;
  readonly typecheck: string | null;
  readonly source: readonly string[];
  readonly tests: readonly string[];
}

export function writeProjectConfig(path: string, stack: Stack): ProjectConfig {
  const config: ProjectConfig = {
    stack: stack.name,
    test: stack.test,
    typecheck: stack.typecheck,
    source: stack.source,
    tests: stack.tests,
  };
  writeFileSync(path, stringify(config));
  return config;
}

export function readProjectConfig(path: string): ProjectConfig | null {
  if (!existsSync(path)) return null;
  const raw: unknown = parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c["test"] !== "string") return null;
  return {
    stack: typeof c["stack"] === "string" ? c["stack"] : "unknown",
    test: c["test"],
    typecheck: typeof c["typecheck"] === "string" ? c["typecheck"] : null,
    source: list(c["source"]),
    tests: list(c["tests"]),
  };
}
