import { UnknownFile, UnknownSymbol, type RepoIndex } from "@wecode/explorer";

/** A task's scope, proposed from what the task promises to deliver.
 *
 *  A scope is written by hand today, which is why it is usually every source file there is
 *  — a person who cannot say which files the work touches names the whole tree, and a task
 *  that may change anything is not a task. But a task that says which symbols it will
 *  deliver has already said most of it: the module a promised symbol lands in has to be
 *  writable, and so does every file that names a symbol the task is about to rewrite,
 *  because a changed signature lands in its callers.
 *
 *  That is two of the repo-explorer's four questions and nothing else. Nothing here globs,
 *  lists a directory or reads a file: a proposal is only ever the files the index already
 *  knows about, so swapping the index underneath cannot change what it proposes without
 *  changing what is true about the tree. What it does not know it says it does not know —
 *  a promised module nothing has indexed yet is a new module, which is a fact about the
 *  promise rather than a failure of it.
 *
 *  The proposal is a proposal. It is printed for a person to paste, never written into a
 *  task: widening or narrowing a scope stays the operator's verb. */

/** One symbol a task promises, and the module it promises it in. Written `file:symbol` —
 *  `packages/tui/src/list.ts:renderList` — because a symbol without a module is not a
 *  promise anybody can check. */
export interface Promised {
  readonly file: string;
  readonly symbol: string;
}

/** Why one path is in the proposed scope, in the words the promise gives — so a person
 *  reading the proposal can disagree with a line rather than with the whole of it. */
export interface Reason {
  readonly path: string;
  readonly why: string;
}

/** What the port says a task may need to write. `write` is the scope, sorted, and
 *  `because` is one reason per path of it, in the same order. */
export interface Proposal {
  readonly write: readonly string[];
  readonly because: readonly Reason[];
}

/** One `file:symbol`, or null when it is neither. The module is everything before the last
 *  colon, so a path that carries one is still read the way it was written. */
export function promised(spec: string): Promised | null {
  const at = spec.lastIndexOf(":");
  if (at <= 0) return null;
  const file = spec.slice(0, at).trim();
  const symbol = spec.slice(at + 1).trim();
  return file === "" || symbol === "" ? null : { file, symbol };
}

/** What one path is in the scope for, gathered before it is put into a sentence. */
interface Facts {
  readonly promises: Set<string>;
  readonly uses: Set<string>;
  unindexed: boolean;
}

/** The scope the promises ask for.
 *
 *  Two questions per promise. `read` is not one of them: whether the module already
 *  declares the name is what `usesOf` answers by refusing — `UnknownSymbol` means the task
 *  is adding the name, and nothing can be using it yet, so there is nobody else to let in.
 *  `UnknownFile` means the module itself is new. Both are answers. */
export async function proposeScope(index: RepoIndex, promises: readonly Promised[]): Promise<Proposal> {
  const facts = new Map<string, Facts>();
  const at = (path: string): Facts => {
    const found = facts.get(path) ?? { promises: new Set<string>(), uses: new Set<string>(), unindexed: false };
    facts.set(path, found);
    return found;
  };

  for (const p of promises) {
    const mine = at(p.file);
    mine.promises.add(p.symbol);
    for (const use of await usesOf(index, p, mine)) {
      // The promised module is already in the scope for promising, and a use inside it is
      // not a second file to let in.
      if (use !== p.file) at(use).uses.add(p.symbol);
    }
  }

  const write = [...facts.keys()].sort();
  return { write, because: write.map((path) => ({ path, why: why(facts.get(path) as Facts) })) };
}

/** Every file that names the promised symbol, or none — a name the module does not declare
 *  yet has no uses, and a module the index does not hold has none either. The refusal is
 *  recorded rather than swallowed: "a module the index does not hold yet" is the one thing
 *  a reader of the proposal most needs to be told. */
async function usesOf(index: RepoIndex, p: Promised, mine: Facts): Promise<readonly string[]> {
  try {
    return (await index.usesOf(p.file, p.symbol)).map((u) => u.file);
  } catch (err) {
    if (err instanceof UnknownFile) {
      mine.unindexed = true;
      return [];
    }
    if (err instanceof UnknownSymbol) return [];
    throw err;
  }
}

/** The line a person reads. A path can be both promised and used, and both halves are said
 *  — a module the task rewrites and also calls from is in the scope twice over. */
function why(facts: Facts): string {
  const parts: string[] = [];
  if (facts.promises.size > 0) {
    const names = [...facts.promises].sort().join(", ");
    parts.push(facts.unindexed ? `promises ${names}, in a module the index does not hold yet` : `promises ${names}`);
  }
  if (facts.uses.size > 0) parts.push(`uses ${[...facts.uses].sort().join(", ")}`);
  return parts.join("; ");
}
