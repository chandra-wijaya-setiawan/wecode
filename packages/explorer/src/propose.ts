/** A map proposed from the import graph, and how far it agrees with the one we ship.
 *
 *  `components.yaml` is written by hand, and a hand-written map drifts: a module moves,
 *  a box grows a second responsibility, and the row that says who owns what keeps saying
 *  what was true last quarter. The code itself has an opinion about this — modules that
 *  import each other are one thing, and modules that never mention each other are two —
 *  and that opinion is derivable, so this module derives it.
 *
 *  What it proposes is boxes, not an architecture. A cluster is the connected component
 *  of the intra-package import graph: everything that reaches everything else, directly
 *  or through a chain, in one box. Layers are deliberately absent — `gate`, `data`,
 *  `client` are judgements about a box's role that no edge implies — and so is `owns`.
 *  A proposal is the shape of the map; the sentences stay a person's to write.
 *
 *  Two rules make the clustering say anything at all:
 *
 *    - Cross-package imports are ignored. `packages/cli` imports `@wecode/core` in nearly
 *      every file; counting those edges puts the whole repository in one box.
 *    - A package's entry points — `index`, `bin` — are lifted out into a surface row of
 *      their own before the graph is walked. They exist to import everything, and left in
 *      they collapse a package to a single cluster every time.
 *
 *  A pure function over a caller-gathered view, like `coverage.ts`. Nothing here opens a
 *  checkout or an index; the caller reads the tree and hands over modules and edges, so
 *  the same proposal is made of what is on disk, of a branch, and of a fixture. */
import type { ComponentMap } from "@wecode/core";

/** One module of the tree and what it imports, both as `<package>/<module>` — the
 *  spelling `claims`, `unclaimed` and `measure` already use. An import the caller could
 *  not resolve to a module of the tree is simply left out; an import of something outside
 *  `tree` is ignored rather than invented. */
export interface ModuleImports {
  readonly module: string;
  readonly imports: readonly string[];
}

/** A package's entry points: modules that import the rest of the package by design, and
 *  so say nothing about which of its parts belong together. Overridable because it is a
 *  fact about how this tree is written, not a law. */
export const ENTRY_POINTS: readonly string[] = ["index", "bin"];

/** One box a proposal would draw.
 *
 *  `name` is the cluster's most-imported module, which is the one a reader would name the
 *  box after — `store` for a cluster of `store`, `db`, `migrations`. `isComponent` is
 *  false for a surface row, matching what `components.yaml` means by it. */
export interface ProposedComponent {
  readonly name: string;
  readonly package: string;
  readonly isComponent: boolean;
  /** The modules of the box, as `<package>/<module>`, sorted. */
  readonly modules: readonly string[];
}

/** A map as the import graph would draw it. Packages in the order the tree gives them,
 *  and within a package, clusters in the order their first module appears, surface last. */
export interface Proposal {
  readonly components: readonly ProposedComponent[];
}

/** How far a proposal and a map agree about which modules belong together.
 *
 *  Pairwise, because two maps that group the same modules identically but name the boxes
 *  differently agree completely, and a count of boxes would not see it. Every unordered
 *  pair of modules inside one package is one question — are these two in the same box? —
 *  and the two maps either answer it the same way or do not. Pairs spanning two packages
 *  are not asked: no map this repository writes puts them together. */
export interface Agreement {
  /** Every intra-package pair both sides have an answer for. */
  readonly pairs: number;
  /** The pairs both answered the same way. */
  readonly same: number;
  /** `same / pairs`, and 1 when there is nothing to disagree about. */
  readonly ratio: number;
  /** The pairs they answered differently, each as `<module> <module>` with the two sides
   *  in sorted order, sorted. This is the list worth reading — every one is either a box
   *  the code has outgrown or an import that should not be there. */
  readonly disputed: readonly string[];
}

const packageOf = (module: string): string => module.slice(0, module.indexOf("/"));

const nameOf = (module: string): string => module.slice(module.indexOf("/") + 1);

const leafOf = (module: string): string => module.slice(module.lastIndexOf("/") + 1);

const sorted = (modules: Iterable<string>): readonly string[] => [...new Set(modules)].sort();

/** Groups in first-seen order, so a proposal reads in the order the tree was gathered in
 *  rather than an alphabetical one nobody chose. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

/** The connected components of an undirected graph over `members`, each in the order its
 *  members were given, the clusters in the order their first member was given. */
function connected(
  members: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const seen = new Set<string>();
  const clusters: string[][] = [];
  for (const start of members) {
    if (seen.has(start)) continue;
    const cluster: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const at = stack.pop() as string;
      cluster.push(at);
      for (const next of edges.get(at) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    clusters.push(members.filter((m) => cluster.includes(m)));
  }
  return clusters;
}

/** The module of a cluster the rest of it depends on most, by how many of its siblings
 *  import it, ties broken by name so the answer never depends on input order. */
function hub(cluster: readonly string[], imports: ReadonlyMap<string, readonly string[]>): string {
  const score = (module: string): number =>
    cluster.filter((other) => other !== module && (imports.get(other) ?? []).includes(module))
      .length;
  const ranked = [...cluster].sort((a, b) => score(b) - score(a) || (a < b ? -1 : 1));
  return ranked[0] as string;
}

/** Clusters a tree's modules into the boxes its imports imply.
 *
 *  `tree` is every module of the tree with its imports; a module named only as an import
 *  is not part of the tree and is ignored. `entryPoints` is the module names lifted into
 *  a surface row before clustering. */
export function propose(
  tree: readonly ModuleImports[],
  entryPoints: readonly string[] = ENTRY_POINTS,
): Proposal {
  const known = new Set(tree.map((m) => m.module));
  const imports = new Map<string, readonly string[]>(
    tree.map((m) => [m.module, m.imports.filter((i) => known.has(i) && i !== m.module)]),
  );

  const components: ProposedComponent[] = [];
  for (const [pkg, inPackage] of groupBy([...tree], (m) => packageOf(m.module))) {
    const entries = inPackage.filter((m) => entryPoints.includes(nameOf(m.module)));
    const rest = inPackage.filter((m) => !entries.includes(m)).map((m) => m.module);

    const within = new Map<string, string[]>(rest.map((m) => [m, []]));
    for (const module of rest) {
      for (const target of imports.get(module) ?? []) {
        if (!within.has(target)) continue;
        (within.get(module) as string[]).push(target);
        (within.get(target) as string[]).push(module);
      }
    }

    for (const cluster of connected(rest, within)) {
      components.push({
        name: leafOf(hub(cluster, imports)),
        package: pkg,
        isComponent: true,
        modules: sorted(cluster),
      });
    }
    if (entries.length > 0) {
      components.push({
        name: `${pkg} surface`,
        package: pkg,
        isComponent: false,
        modules: sorted(entries.map((m) => m.module)),
      });
    }
  }
  return { components };
}

/** Which box each side puts a module in, for every module both sides know. */
function boxes(sides: readonly (readonly ProposedComponent[])[]): Map<string, string>[] {
  return sides.map((side) => {
    const out = new Map<string, string>();
    for (const c of side) for (const m of c.modules) out.set(m, `${c.package}:${c.name}`);
    return out;
  });
}

/** The components of a map, in the shape a proposal states them, so the two compare. */
export const asProposal = (map: ComponentMap): Proposal => ({
  components: map.components.map((c) => ({
    name: c.name,
    package: c.package,
    isComponent: c.isComponent,
    modules: sorted(c.modules.map((m) => `${c.package}/${m}`)),
  })),
});

/** Holds a proposal against a map, pair by pair. Either argument may be a proposal; a map
 *  is put in the same shape with `asProposal` first. */
export function agreement(proposal: Proposal, map: Proposal): Agreement {
  const [left, right] = boxes([proposal.components, map.components]) as [
    Map<string, string>,
    Map<string, string>,
  ];
  const shared = sorted([...left.keys()].filter((m) => right.has(m)));

  let pairs = 0;
  let same = 0;
  const disputed: string[] = [];
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      const [a, b] = [shared[i] as string, shared[j] as string];
      if (packageOf(a) !== packageOf(b)) continue;
      pairs++;
      if ((left.get(a) === left.get(b)) === (right.get(a) === right.get(b))) same++;
      else disputed.push(`${a} ${b}`);
    }
  }
  return { pairs, same, ratio: pairs === 0 ? 1 : same / pairs, disputed: sorted(disputed) };
}
