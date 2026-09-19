/** A scope that names a node of the architecture, resolved through the map at dispatch.
 *
 *  A write scope is a list of globs, and a person writing one by hand either knows the
 *  files or names the whole tree. The map already holds the middle answer: docs/design/01
 *  says which box owns which module, so "this task writes the trees component" is a scope
 *  somebody can actually write down, and the files it means are not their problem.
 *
 *  Resolved here rather than stored resolved. The record keeps what the operator wrote —
 *  the node — and every dispatch expands it against the map as it is on that tick, so a
 *  module moved from one box to another moves the scope with it instead of leaving a
 *  stale file list behind. The expansion is the assignment's scope; the node is what the
 *  task says.
 *
 *  A node is named by its address, rooted at `wecode` and slash-separated, exactly as the
 *  explorer's tree spells it — `wecode`, `wecode/core`, `wecode/core/gate`,
 *  `wecode/core/gate/model`. Every node resolves, not only a component: a layer is every
 *  file of its components, a package every file of its layers. Nothing else in the scope
 *  is touched, because only an address is rooted at `wecode` and a path in this repository
 *  never is — so a scope with no node in it resolves to itself.
 *
 *  A module becomes a glob and not a file, `packages/<pkg>/src/<module>.*`, because the
 *  map deliberately does not say what a module is written in. Resolving to `.ts` here
 *  would be this module deciding that, and it would be wrong the first time a box owns a
 *  `.tsx`. A checkout is the authority on the extension, and dispatch does not need to
 *  ask: a glob is enough for the ceiling, the commit and the harness alike.
 *
 *  An address the map does not have is refused and never dropped. A scope quietly emptied
 *  of the one node it named is a worker dispatched with nothing writable, which reads to
 *  everybody downstream as a worker that refused to write anything. */
import { loadComponents, type Component, type ComponentMap, type Scope } from "@wecode/core";

/** The root of every address. The system node's own name. */
export const ROOT = "wecode";

/** Is this scope entry a node address rather than a path? Only the prefix decides: a path
 *  in a repository whose packages live under `packages/` is never rooted at `wecode`. */
export const namesANode = (entry: string): boolean => entry === ROOT || entry.startsWith(`${ROOT}/`);

/** One node a scope named, and the globs it stood for. Kept beside the scope so a refusal,
 *  a prompt or an operator reading the assignment can say which files came from which
 *  node rather than showing a flat list nobody wrote. */
export interface ResolvedNode {
  readonly node: string;
  readonly write: readonly string[];
}

export interface ResolvedScope {
  /** The scope as dispatched: every node replaced by its globs, everything else as
   *  written, in the order the scope was written, with duplicates dropped. */
  readonly scope: Scope;
  /** One per node the scope named, in the order it named them. Empty when it named none,
   *  which is the case for every scope written before nodes could be named. */
  readonly nodes: readonly ResolvedNode[];
}

/** The address of a component node: `wecode/<package>/<layer>/<component>`. */
const addressOf = (c: Component): string => `${ROOT}/${c.package}/${c.layer}/${c.name}`;

/** What one component owns, as globs. Sorted, so two components in one node come out in a
 *  fixed order rather than the map's. */
const globsOf = (c: Component): readonly string[] =>
  [...c.modules].map((m) => `packages/${c.package}/src/${m}.*`).sort();

/** The components under an address. Empty when nothing is there, which is the refusal:
 *  a prefix match is what makes a layer and a package resolve without being listed
 *  anywhere, since their address is every component address's stem. */
const under = (map: ComponentMap, address: string): readonly Component[] =>
  address === ROOT
    ? map.components
    : map.components.filter((c) => {
        const a = addressOf(c);
        return a === address || a.startsWith(`${address}/`);
      });

/** The globs one address stands for, or null when the map has no node there. */
export function nodeGlobs(map: ComponentMap, address: string): readonly string[] | null {
  const components = under(map, address);
  if (components.length === 0) return null;
  return [...new Set(components.flatMap(globsOf))].sort();
}

/** The scope to dispatch under, or why it cannot be resolved.
 *
 *  `tools` is passed through untouched: the map says what a box owns, never what a worker
 *  may run. */
export function resolveScope(
  scope: Scope,
  map: ComponentMap = loadComponents(),
): { ok: true; resolved: ResolvedScope } | { ok: false; why: string } {
  const write: string[] = [];
  const nodes: ResolvedNode[] = [];

  for (const entry of scope.write) {
    if (!namesANode(entry)) {
      write.push(entry);
      continue;
    }
    const globs = nodeGlobs(map, entry);
    if (globs === null) return { ok: false, why: `no node at ${entry}: the map has nothing there` };
    nodes.push({ node: entry, write: globs });
    write.push(...globs);
  }

  return {
    ok: true,
    resolved: { scope: { write: [...new Set(write)], tools: scope.tools }, nodes },
  };
}
