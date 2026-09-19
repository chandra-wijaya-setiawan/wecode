/** The architecture, as a tree of nodes over the files that are really there.
 *
 *  Two inputs, and neither is written here. The **model** is a checkout — the source tree
 *  as it exists on disk, which is the only authority on what files a repository has. The
 *  **map** is `components.yaml`, which says which box owns which module and nothing about
 *  where a module lives. Put together they answer the question a reader of docs/design/01
 *  actually has: for this box, which files am I looking at?
 *
 *  Every node resolves to files, not only the leaves. A component resolves to the modules
 *  the map gives it; a layer to every file of its components; a package to every file of
 *  its layers; the system to the lot. So "what is in the data layer of core" and "what is
 *  in core" are the same question asked at two heights, and are answered the same way.
 *
 *  A claim the tree does not have is not an exception. It is reported as `missing`,
 *  because a map that has drifted from the tree is a fact about the repository and the
 *  caller asking is usually the one who wants to know. */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { claims, loadComponents, type Component, type ComponentMap } from "@wecode/core";

/** The extensions a module may be written in, in the order a claim is resolved. */
const EXTENSIONS = [".ts", ".tsx"] as const;

export class ArchitectureError extends Error {}

/** How high in the tree a node sits. Only a `component` is a box in docs/design/01; the
 *  three above it are the groupings the map already implies. */
export type NodeKind = "system" | "package" | "layer" | "component";

/** One node, and everything under it.
 *
 *  `path` is the node's address, slash-separated from the root — `wecode`,
 *  `wecode/core`, `wecode/core/gate`, `wecode/core/gate/model`. It is how a caller names
 *  a node without holding a reference to one.
 *
 *  `files` is repository-relative, POSIX-separated and sorted, exactly as the repo port
 *  spells a path, and is the union over the node's descendants — so a parent's files are
 *  every file of its children, with nothing added and nothing lost. */
export interface ArchNode {
  readonly kind: NodeKind;
  readonly name: string;
  readonly path: string;
  /** What the map says this box owns; empty above a component, which owns by containing. */
  readonly owns: string;
  /** False for the rows docs/design/01 keeps without drawing a box — `files`, `surface` —
   *  and for every node above a component. */
  readonly isComponent: boolean;
  readonly files: readonly string[];
  readonly children: readonly ArchNode[];
}

/** A model bound to a map: the tree, and where the two disagree. */
export interface Architecture {
  /** The checkout the files are relative to. */
  readonly root: string;
  readonly tree: ArchNode;
  /** Every claim of the map with no file in the tree, as `<package>/<module>`, sorted. A
   *  map that matches its checkout leaves this empty. */
  readonly missing: readonly string[];
}

/** The file a claim resolves to, relative to the root, or null when the tree has none. */
function resolve(root: string, pkg: string, module: string): string | null {
  for (const ext of EXTENSIONS) {
    const rel = `packages/${pkg}/src/${module}${ext}`;
    if (existsSync(join(root, rel))) return rel;
  }
  return null;
}

const sorted = (files: Iterable<string>): readonly string[] => [...new Set(files)].sort();

/** Groups in first-seen order, which keeps the tree in the order the map is written in —
 *  the order docs/design/01 reads in, rather than an alphabetical one nobody chose. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

/** Binds the map to the model.
 *
 *  `root` is a checkout — the directory holding `packages/`. `map` defaults to the map
 *  wecode ships, so asking about wecode itself takes no arguments at all. */
export function loadArchitecture(root: string, map: ComponentMap = loadComponents()): Architecture {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new ArchitectureError(`no model at ${root}: it is not a directory`);
  }
  if (!existsSync(join(root, "packages"))) {
    throw new ArchitectureError(`no model at ${root}: it has no packages directory`);
  }

  const missing: string[] = [];
  const filesOf = (c: Component): readonly string[] => {
    const found: string[] = [];
    for (const module of c.modules) {
      const file = resolve(root, c.package, module);
      if (file === null) missing.push(`${c.package}/${module}`);
      else found.push(file);
    }
    return sorted(found);
  };

  const componentNode = (c: Component, parent: string): ArchNode => ({
    kind: "component",
    name: c.name,
    path: `${parent}/${c.name}`,
    owns: c.owns,
    isComponent: c.isComponent,
    files: filesOf(c),
    children: [],
  });

  const above = (
    kind: "system" | "package" | "layer",
    name: string,
    path: string,
    children: readonly ArchNode[],
  ): ArchNode => ({
    kind,
    name,
    path,
    owns: "",
    isComponent: false,
    files: sorted(children.flatMap((child) => child.files)),
    children,
  });

  const packages = [...groupBy([...map.components], (c) => c.package)].map(([pkg, inPackage]) => {
    const layers = [...groupBy(inPackage, (c) => c.layer)].map(([layer, inLayer]) =>
      above(
        "layer",
        layer,
        `wecode/${pkg}/${layer}`,
        inLayer.map((c) => componentNode(c, `wecode/${pkg}/${layer}`)),
      ),
    );
    return above("package", pkg, `wecode/${pkg}`, layers);
  });

  return { root, tree: above("system", "wecode", "wecode", packages), missing: sorted(missing) };
}

/** Every node, parents before children, in the order the map is written in. */
export function nodes(arch: Architecture): readonly ArchNode[] {
  const out: ArchNode[] = [];
  const walk = (node: ArchNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(arch.tree);
  return out;
}

/** The node at an address, or null when nothing is there. */
export const nodeAt = (arch: Architecture, path: string): ArchNode | null =>
  nodes(arch).find((n) => n.path === path) ?? null;

/** What claims the tree has that the map does not, as `<package>/<module>` — the other
 *  half of `missing`, asked of a map rather than of a checkout. A file nothing claims has
 *  no box, and so is not in the architecture at all. */
export const unclaimed = (
  map: ComponentMap,
  tree: readonly string[],
): readonly string[] => tree.filter((m) => !claims(map).includes(m)).sort();
