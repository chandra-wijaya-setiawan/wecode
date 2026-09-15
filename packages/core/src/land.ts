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
