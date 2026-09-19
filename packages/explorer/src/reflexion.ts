/** The model, held against the import graph, one edge at a time.
 *
 *  A model says which node may reach which. The tree says which file imports which. Until
 *  something puts the two side by side, a forbidden edge is found only by a person reading
 *  a diff and remembering the rule — which is to say, not found. This module asks the
 *  question mechanically, of every ordered pair of nodes the model names.
 *
 *  Three answers, because an edge can disagree with a model in two directions and agree in
 *  one:
 *
 *    convergence  the model allows the edge, and a file proves it exists
 *    divergence   a file proves the edge exists, and the model forbids it
 *    absence      the model expects the edge, and no file makes it
 *
 *  A pair that is neither allowed nor made is not a finding: a model that forbids an edge
 *  nobody writes has nothing to report, and listing every such pair would bury the three
 *  that matter under the square of the node count.
 *
 *  Every finding names both nodes and the file that proves it. For a convergence or a
 *  divergence that file is the importer — the line a reader would change. An absence has
 *  no file by construction, and says so with `null` rather than with a path that would
 *  have to be invented.
 *
 *  A model that names a node the architecture has no address for is drift, not a failure,
 *  and is reported as `unknown` for the same reason `Architecture.missing` is: the caller
 *  asking is usually the one who wants to know. Edges touching such a node are not
 *  judged — a verdict computed over no files would read as an absence and mean nothing. */
import { nodes, type Architecture } from "./architecture.js";
import type { RepoIndex } from "./ports.js";

/** What holding one edge against the model says about it. */
export type Verdict = "convergence" | "divergence" | "absence";

/** One node of the model, and what it is allowed to reach.
 *
 *  `path` and every entry of `reaches` are node addresses as `ArchNode.path` spells them —
 *  `wecode/core/gate/model`. A node with an empty `reaches` may reach nothing, which is
 *  how a model forbids. */
export interface ModelNode {
  readonly path: string;
  readonly reaches: readonly string[];
}

/** What the architecture is meant to be: nodes, and the edges between them that are
 *  allowed. Nothing here knows a file — that is the tree's business, and the point is that
 *  the two are written down separately and then compared. */
export interface Model {
  readonly nodes: readonly ModelNode[];
}

/** One edge, and what the model and the tree together say about it. */
export interface Finding {
  readonly verdict: Verdict;
  /** The node the edge leaves, as an address. */
  readonly from: string;
  /** The node the edge arrives at, as an address. */
  readonly to: string;
  /** The file whose import proves the edge exists, repository-relative — the first of
   *  `from`'s files that reaches one of `to`'s. Null for an absence, which no file
   *  proves. */
  readonly file: string | null;
}

/** The whole comparison: what every named pair came to, and what the model named that the
 *  architecture does not have. */
export interface Reflexion {
  /** Every pair that converged, diverged or was absent, in the order the model names its
   *  nodes — `from` in the outer order, `to` in the same order within it. */
  readonly findings: readonly Finding[];
  /** Addresses the model names — as a node or as something to reach — that the
   *  architecture has no node at, sorted. A model that matches its architecture leaves
   *  this empty. */
  readonly unknown: readonly string[];
}

/** Holds a model against the import graph of an architecture already bound to a tree.
 *
 *  `index` answers for the same checkout `arch` was loaded from; every path on both sides
 *  is repository-relative, so the two compare without either side converting. */
export async function reflect(
  model: Model,
  arch: Architecture,
  index: RepoIndex,
): Promise<Reflexion> {
  const byPath = new Map(nodes(arch).map((node) => [node.path, node]));

  /** Every address the model mentions, in first-seen order — a node it declares, or one it
   *  says something may reach. A node that only ever appears as a target still has files
   *  and still takes edges, so leaving it out would silence its absences. */
  const mentioned = [...new Set(model.nodes.flatMap((n) => [n.path, ...n.reaches]))];
  const known = mentioned.filter((path) => byPath.has(path));
  const unknown = mentioned.filter((path) => !byPath.has(path)).sort();

  const reaches = new Map<string, ReadonlySet<string>>(
    model.nodes.map((n) => [n.path, new Set(n.reaches)]),
  );

  /** What each file of each named node imports, resolved into the tree. A specifier that
   *  leaves the repository resolves to null and can prove no edge between two nodes. */
  const imports = new Map<string, readonly string[]>();
  for (const file of new Set(known.flatMap((path) => byPath.get(path)?.files ?? []))) {
    const reading = await index.read(file);
    imports.set(
      file,
      reading.imports.map((i) => i.resolved).filter((r): r is string => r !== null),
    );
  }

  /** The first file of `from` that imports a file of `to`, or null when none does. The
   *  files of a node are sorted, so the same tree always names the same proof. */
  const proof = (from: string, to: string): string | null => {
    const target = new Set(byPath.get(to)?.files ?? []);
    const found = (byPath.get(from)?.files ?? []).find((file) =>
      (imports.get(file) ?? []).some((resolved) => target.has(resolved)),
    );
    return found ?? null;
  };

  const findings: Finding[] = [];
  for (const from of known) {
    const allowed = reaches.get(from) ?? new Set<string>();
    for (const to of known) {
      if (to === from) continue;
      const file = proof(from, to);
      if (file !== null) {
        findings.push({ verdict: allowed.has(to) ? "convergence" : "divergence", from, to, file });
      } else if (allowed.has(to)) {
        findings.push({ verdict: "absence", from, to, file: null });
      }
    }
  }

  return { findings, unknown };
}
