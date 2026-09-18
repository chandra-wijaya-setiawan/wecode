/** docs/design/14. Field report 105. Where a landing merge is allowed to happen.
 *
 *  The merge that lands a story belongs in the checkout that holds the base branch, and
 *  nowhere else. Run from the story's own worktree, `git merge story/x` merges the branch
 *  into itself: git says "Already up to date", the operator is told it landed, and the base
 *  never gained the commit. Any other tree is worse — a wrong-tree merge is how a conflicted
 *  merge commit reached master once.
 *
 *  So land never retargets silently. It names the tree it was called in, names the tree it
 *  should be run in, and merges nothing. This module is the rule alone: no git, no clock, no
 *  filesystem, so the command half and the runner half can be held to the same words. */

/** One entry of `git worktree list --porcelain`. `branch` is null for a detached checkout. */
export interface Checkout {
  readonly path: string;
  readonly branch: string | null;
}

export interface LandingPlace {
  /** The repository root of the directory land was invoked in. */
  readonly here: string;
  /** The story branch being landed, e.g. `story/add-a-guard`. */
  readonly branch: string;
  /** The branch the story lands on, e.g. `master`. */
  readonly base: string;
  /** Every checkout of this repository, the invoking one included. */
  readonly trees: readonly Checkout[];
}

/** Why this tree may not land the story, or null when it may.
 *
 *  Paths are compared as given: a caller holding symlinked paths — a macOS `/tmp`, a
 *  worktree reached through one — resolves them before asking, or two names for one
 *  directory read as two trees and the operator is refused in the tree they are owed. */
export function refuseLand(place: LandingPlace): string | null {
  const { here, branch, base, trees } = place;
  const baseTree = trees.find((c) => c.branch === base);
  if (baseTree === undefined) {
    return (
      `land ${branch} refused in ${here}: no checkout has ${base} checked out, ` +
      `so there is no tree the merge into ${base} could happen in`
    );
  }
  if (here === baseTree.path) return null;
  return `land ${branch} refused in ${here}: ${whyNotHere(here, branch, base, trees)}. ` +
    `Run it in ${baseTree.path}, the checkout that holds ${base}.`;
}

/** The half of the refusal that says what this tree is. A story worktree is named as the
 *  self-merge it would be, because "wrong tree" does not tell an operator standing in
 *  `story/x` that the merge they asked for has no effect at all. */
function whyNotHere(
  here: string,
  branch: string,
  base: string,
  trees: readonly Checkout[],
): string {
  const holds = trees.find((c) => c.path === here)?.branch;
  if (holds === branch) {
    return `it is the ${branch} worktree, and merging ${branch} there merges it into itself`;
  }
  // Null is a detached checkout — every agent attempt tree is one — and undefined is a
  // directory no checkout claims. Neither holds the base, and neither has a branch to name.
  if (holds === null || holds === undefined) return "it is not the tree that holds the base branch";
  return `it holds ${holds}, not ${base}`;
}

/** What the base checkout looks like just before, or just after, a landing merge. */
export interface BaseState {
  /** The repository root of the base checkout. */
  readonly here: string;
  /** The branch the story lands on, e.g. `master`. */
  readonly base: string;
  /** `git status --porcelain -uno` split into lines, empty when no tracked file has changed.
   *  Untracked files are left out on purpose: they do not affect a merge, git refuses on its
   *  own if one would be overwritten, and counting them blocked a landing over wecode's own
   *  config directory. */
  readonly dirty: readonly string[];
  /** True when a merge is half-finished — `.git/MERGE_HEAD` exists. A tree can be mid-merge
   *  and report nothing dirty, so status alone does not see this. */
  readonly merging: boolean;
}

/** Why the base may not be merged onto, or null when it may.
 *
 *  A landing merge commits whatever is in the index, so a dirty base does not stay a dirty
 *  base: the operator's unrelated edits ship inside the landing commit under the story's
 *  name. Refusing is cheap and the mixed commit is not, so land refuses. */
export function refuseDirtyBase(state: BaseState): string | null {
  const { here, base, dirty, merging } = state;
  if (merging) {
    return (
      `land refused in ${here}: a merge is already in progress on ${base}, so landing now ` +
      `would commit somebody else's half-finished merge.\n` +
      `  finish it with git merge --continue, or undo it with git merge --abort, then land again.`
    );
  }
  if (dirty.length === 0) return null;
  return (
    `land refused in ${here}: ${base} has uncommitted changes, and the landing merge would ` +
    `commit them as part of the story.\n${indent(dirty)}\n  commit or stash them first.`
  );
}

/** What to tell the operator after an aborted merge. `git merge --abort` is best effort, and
 *  when it does not restore the tree the old sentence — "your tree is as you left it" — was a
 *  lie that ends with conflict markers committed onto the base. So the state is read again
 *  after the abort, and a base that did not come back clean is said out loud. */
export function reportAbort(state: BaseState, branch: string): string {
  const chore =
    `  the story needs a merge chore: rebase or merge your branch into ${branch}, ` +
    `redeliver, then land again.`;
  const left = reportLeftover(state);
  if (left === null) {
    return `  the merge was aborted, so your tree is as you left it and the story has not landed.\n${chore}`;
  }
  return `  the merge was NOT undone.\n${left}\n${chore}`;
}

/** What the base was left holding that it did not start with, or null when it is clean.
 *
 *  Said after the merge as well as after an abort: land promises the base it touched is a
 *  base somebody else can land on next, and the only way to keep that promise is to look. */
export function reportLeftover(state: BaseState): string | null {
  const { here, base, dirty, merging } = state;
  if (!merging && dirty.length === 0) return null;
  const what = merging
    ? `${base} in ${here} is still mid-merge`
    : `${base} in ${here} was left with uncommitted changes`;
  return (
    `  ${what} — do not commit there until it is clean:\n` +
    `${dirty.length === 0 ? "  (no tracked file differs)" : indent(dirty)}\n` +
    `  run git merge --abort in that tree, or git status to see what is left.`
  );
}

/** The two path sets a landing merge has to be judged on, as git answers them.
 *
 *  Both are relative to the merge base, because that is what decides a merge: a path the
 *  base deleted *after* the fork point is deleted by the merge too and needs no rule, while
 *  a path the base deleted *before* it is absent from the merge base, so a branch that has
 *  the path is a branch that added it. */
export interface LandingDiff {
  readonly branch: string;
  readonly base: string;
  /** Paths the branch adds against the merge base —
   *  `git diff --name-only --diff-filter=A <merge-base> <branch>`. */
  readonly added: readonly string[];
  /** Paths the base's history removed and the base tip does not hold —
   *  `git log --diff-filter=D --name-only <base>` less `git ls-tree -r --name-only <base>`. */
  readonly removedByBase: readonly string[];
}

/** Why this branch may not land, or null when it may.
 *
 *  A removal is a decision, and a merge is the one place it can be undone without anybody
 *  deciding anything: git adds back a path the branch carries and the base's merge base does
 *  not hold, says nothing, and exits 0. That is how a deleted file reached master twice —
 *  an attempt commit re-added it and the landing merge carried it in.
 *
 *  So the path is named. Not "your branch conflicts" and not a count: the operator has to
 *  decide whether the removal or the re-add was the mistake, and they cannot do that without
 *  knowing which file it is about. */
export function refuseResurrection(diff: LandingDiff): string | null {
  const { branch, base, added, removedByBase } = diff;
  const gone = new Set(removedByBase);
  const back = [...new Set(added.filter((p) => gone.has(p)))].sort();
  if (back.length === 0) return null;
  const these = back.length === 1 ? "a path" : `${back.length} paths`;
  return (
    `land ${branch} refused: it would restore ${these} ${base} removed.\n${indent(back)}\n` +
    `  ${base} deleted ${back.length === 1 ? "it" : "them"} on purpose, and the merge would ` +
    `add ${back.length === 1 ? "it" : "them"} back without saying so.\n` +
    `  drop the commit on ${branch} that re-adds ${back.length === 1 ? "it" : "them"} — or ` +
    `delete ${back.length === 1 ? "it" : "them"} on ${branch} — then redeliver and land again.`
  );
}

const indent = (lines: readonly string[]): string => lines.map((l) => `  ${l}`).join("\n");
