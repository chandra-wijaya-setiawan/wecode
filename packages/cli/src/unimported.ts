import type { Violation } from "@wecode/core";
import { UnknownFile, UnknownSymbol, type Imported, type Reading, type RepoIndex } from "@wecode/explorer";

/** An invariant about the tree rather than about the record.
 *
 *  Every other check the doctor runs is a pure function of a `Snapshot` of rows. This one
 *  is a question about the source: a name a module exports that nothing in the repository
 *  brings in is either dead or a surface nobody declared, and both are drift a person
 *  settles. It is kept out of core's `INVARIANTS` for the reason `RUNNER_INVARIANTS` is —
 *  its subject is not in the snapshot, it cannot be answered synchronously, and nothing
 *  here is healable: deleting a name or declaring an entry point is a person's call.
 *
 *  The tree is read through the repo-explorer port and through nothing else. No parser, no
 *  glob of `export` lines, no `tsc`: the three questions the port asks are enough to answer
 *  this one, which is the test of whether the port was the right four questions. Swapping
 *  the index underneath must not change a single violation. */

/** The sentence, as the doctor prints it. Stated positively, like every other invariant:
 *  what is supposed to be true, not what went wrong. */
export const UNIMPORTED_EXPORT = "export_is_imported_somewhere";

/** What one pass over the tree is allowed to see. Nothing is discovered here — the caller
 *  says which files there are and which of them are the outward surface — because the port
 *  does not list a repository and a check that went and looked would be reading the tree
 *  by a second route. */
export interface Tree {
  readonly index: RepoIndex;
  /** Every file to ask about, repository-relative. One the index does not hold is skipped:
   *  a `.png` is not a module with unimported exports, it is not a module. */
  readonly files: readonly string[];
  /** The files whose exports are the repository's outward surface — a package entry point,
   *  a binary. Nothing inside the tree imports them by name and that is not drift, so they
   *  are named rather than guessed at from a filename. */
  readonly surface: ReadonlySet<string>;
}

/** Who brings a name in. Two facts, because a whole-module import takes everything and has
 *  no name to record: `byName` is what was asked for by name, `whole` is the modules that
 *  were taken entire. */
interface Brought {
  readonly byName: ReadonlyMap<string, ReadonlySet<string>>;
  readonly whole: ReadonlySet<string>;
}

/** Every export nothing imports, sorted by file and then by name.
 *
 *  Three passes, one per question the port asks. `read` says who brings what in. `purposeOf`
 *  says what each module offers. `usesOf` is the last word before an accusation: the port
 *  reports an import under the *local* name, so `import { greet as hello }` records `hello`
 *  and would convict `greet` of being unimported. A name referenced in another file is
 *  taken up whatever it was called on the way in, and asking costs one question per name
 *  that looked unused — which is the only place this check is allowed to be wrong. */
export async function unimportedExports(tree: Tree): Promise<readonly Violation[]> {
  const brought = await broughtIn(tree);
  const found: Violation[] = [];
  for (const file of [...tree.files].sort()) {
    if (tree.surface.has(file) || brought.whole.has(file)) continue;
    const offered = await offers(tree.index, file);
    const taken = brought.byName.get(file) ?? new Set<string>();
    for (const name of [...offered].sort()) {
      if (taken.has(name)) continue;
      if (await referencedElsewhere(tree.index, file, name)) continue;
      found.push({
        invariant: UNIMPORTED_EXPORT,
        entity: "module",
        id: null,
        slug: file,
        detail: `exports ${name}, which nothing in the repository imports`,
      });
    }
  }
  return found;
}

/** Every import in the tree, gathered once. A module that imports from itself is not a
 *  dependent of itself, and a specifier that leaves the repository resolves to null and
 *  says nothing about any file here. */
async function broughtIn(tree: Tree): Promise<Brought> {
  const byName = new Map<string, Set<string>>();
  const whole = new Set<string>();
  for (const file of tree.files) {
    const reading = await held(tree.index, file);
    if (reading === null) continue;
    for (const i of reading.imports) {
      const target = i.resolved;
      if (target === null || target === file) continue;
      if (takesEverything(i)) {
        whole.add(target);
        continue;
      }
      const named = byName.get(target) ?? new Set<string>();
      named.add(i.name);
      byName.set(target, named);
    }
  }
  return { byName, whole };
}

/** A namespace or star import names no export, so every export of the module it reached is
 *  brought in by it. */
const takesEverything = (i: Imported): boolean => i.kind === "namespace" || i.kind === "star";

/** What a module offers, including what it re-exports. A file the index does not hold
 *  offers nothing to be unimported. */
async function offers(index: RepoIndex, file: string): Promise<readonly string[]> {
  try {
    return (await index.purposeOf(file)).exports;
  } catch (err) {
    if (err instanceof UnknownFile) return [];
    throw err;
  }
}

/** Is the name written anywhere but where it is declared? The question that saves an
 *  aliased import, and a re-export, from being called dead. */
async function referencedElsewhere(index: RepoIndex, file: string, name: string): Promise<boolean> {
  try {
    return (await index.usesOf(file, name)).some((u) => u.file !== file);
  } catch (err) {
    // A name the file re-exports is not one it declares, so the port refuses the question.
    // That is not evidence either way, and the import pass above has already had its say.
    if (err instanceof UnknownSymbol || err instanceof UnknownFile) return false;
    throw err;
  }
}

async function held(index: RepoIndex, file: string): Promise<Reading | null> {
  try {
    return await index.read(file);
  } catch (err) {
    if (err instanceof UnknownFile) return null;
    throw err;
  }
}

/** The checks about the tree. A set of one today, and a set rather than a function because
 *  the doctor reports by invariant name and a second tree check must arrive without the
 *  doctor learning its name. */
export const TREE_INVARIANTS: readonly {
  readonly name: string;
  readonly check: (t: Tree) => Promise<readonly Violation[]>;
}[] = [{ name: UNIMPORTED_EXPORT, check: unimportedExports }];

/** One pass over the tree. A check that throws becomes a violation naming itself, the same
 *  way the record pass treats one: an invariant nobody could evaluate is a thing a person
 *  needs to see as much as one that failed. */
export async function checkTree(tree: Tree): Promise<readonly Violation[]> {
  const found: Violation[] = [];
  for (const i of TREE_INVARIANTS) {
    try {
      found.push(...(await i.check(tree)));
    } catch (err) {
      found.push({
        invariant: i.name,
        entity: "invariant",
        id: null,
        slug: i.name,
        detail: `the check itself failed: ${(err as Error).message}`,
      });
    }
  }
  return found;
}
