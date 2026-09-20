import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** docs/design/14. Landing, rung 1: the runner attempts the merge inline, and clean is the
 *  common case that costs nothing. docs/design/18: when it is not clean, the merge wecode
 *  owes itself is a `land` chore — a kind, a target, a check and a reason.
 *
 *  Landing is the one merge whose target is the base branch, and design 14's rule about it
 *  is that the tree holding the base is not something wecode writes to. So the merge is
 *  made in a detached worktree of wecode's own, cut at the base tip, and the base branch is
 *  moved onto the result with a compare-and-swap `update-ref`. Nobody's checkout is written
 *  in, and a base that moved while the merge was being made loses the swap rather than the
 *  commit.
 *
 *  What that costs is worth saying out loud: a checkout that holds the base branch is left
 *  one commit behind the ref it is on, so an operator working there reads the story's files
 *  as staged deletions until they `git checkout .`. The alternative was merging in their
 *  tree, which is the thing design 14 forbids.
 *
 *  Kept out of daemon.ts so the rule and the git are one module: what a landing is owed,
 *  what one attempt came to, and nothing about the record. */

/** What the base branch must be true of for the chore to be discharged: it contains the
 *  story branch. Read off the graph, never off a report. */
export const LAND_CHECK = "the base branch contains the story branch";

/** One attempt to put a story branch in the base.
 *
 *  Three shapes, because the caller does three different things with them. `landed` is the
 *  base having moved, and there is a sha to show. `nothing` is nothing being owed — no
 *  branch, or the branch is already in the base — and is silent. `refused` is the attempt
 *  having been made and failed, which is what a `land` chore is raised for. */
export type LandAttempt =
  | { readonly kind: "landed"; readonly sha: string }
  | { readonly kind: "nothing"; readonly why: "no-branch" | "already-ancestor" }
  | { readonly kind: "refused"; readonly why: string };

export interface LandPlace {
  /** The repository the branches live in. */
  readonly repo: string;
  /** The branch the story lands on, e.g. `master`. */
  readonly base: string;
  /** The story branch being landed, e.g. `story/password-reset`. */
  readonly branch: string;
  /** Where the detached tree the merge is made in goes. Removed either way. */
  readonly tree: string;
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await exec("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const quiet = async (cwd: string, args: readonly string[]): Promise<string | null> =>
  await git(cwd, args).catch(() => null);

/** True when `base` already contains `branch` — the landing having been made, rather than
 *  anybody's word for it. The same question `wecode doctor` asks of a story it accuses. */
export async function isLanded(repo: string, base: string, branch: string): Promise<boolean> {
  return (await quiet(repo, ["merge-base", "--is-ancestor", branch, base])) !== null;
}

const has = async (repo: string, ref: string): Promise<boolean> =>
  (await quiet(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null;

/** Where a raised `land` chore stands, read off the graph rather than off the chore.
 *
 *  A chore is a thing wecode owes itself, and the only thing that may retire one is the
 *  world. Three answers, because a `land` chore leaves the board three different ways:
 *
 *  - `owed` — the branch is there, the base does not contain it, the merge is still to make.
 *  - `landed` — the base contains the branch. Discharged: the check is answered yes.
 *  - `gone` — the target no longer resolves. Dropped: the check can never be answered at
 *    all, because the branch it is a check *about* is not in the repository any more.
 *
 *  The last is the one that used to sit forever. A story branch deleted after the chore was
 *  raised — rewound, renamed, cleaned up by hand — left `land` open asking for a merge of
 *  nothing, attempt after attempt, with nobody able to satisfy it and nothing on the board
 *  saying why. A chore whose target is gone is not work, and it is not a pass either: it is
 *  dropped, with the reason standing as its epitaph.
 *
 *  The order matters, and it is the only order that is honest. `landed` cannot be asked of
 *  a branch that is not there — `merge-base --is-ancestor` wants two commits — so a branch
 *  that is gone reads as `gone` whatever became of its commits. That is the truthful answer
 *  rather than a convenient one: wecode does not know whether it landed, and says so by
 *  dropping the chore instead of claiming a landing it cannot see.
 *
 *  A missing *base* is not this. That is the repository being wrong rather than the target
 *  being gone, it is owed still, and `attemptLanding` refuses it with a sentence naming the
 *  base. Nothing here drops a chore for it. */
export type LandStanding =
  | { readonly kind: "owed" }
  | { readonly kind: "landed"; readonly why: string }
  | { readonly kind: "gone"; readonly why: string };

/** The epitaph a dropped `land` chore carries. One spelling, so the board and this module
 *  say the same thing about the same fact. */
export const targetGone = (branch: string): string =>
  `${branch} no longer resolves: there is no branch left to land, and "${LAND_CHECK}" can never be answered of it`;

export async function landStanding(repo: string, base: string, branch: string): Promise<LandStanding> {
  if (!(await has(repo, branch))) return { kind: "gone", why: targetGone(branch) };
  if (!(await has(repo, base))) return { kind: "owed" };
  if (await isLanded(repo, base, branch)) return { kind: "landed", why: `${base} already contains ${branch}` };
  return { kind: "owed" };
}

/** Is this tree still in the middle of a merge? `MERGE_HEAD` is git's own record of it, and
 *  it lives in the tree's own git dir rather than the repository's. */
async function midMerge(tree: string): Promise<boolean> {
  const dir = await quiet(tree, ["rev-parse", "--absolute-git-dir"]);
  return dir !== null && existsSync(join(dir, "MERGE_HEAD"));
}

/** The subject every landing commit carries, and the one the doctor reads a `landed_sha`
 *  off. One spelling, so the commit wecode writes and the commit wecode looks for cannot
 *  drift apart. */
export const landSubject = (branch: string): string => `land ${branch}`;

/** One landing, attempted.
 *
 *  Nothing here is destructive on the way out. A conflicted merge is aborted, the tree it
 *  was made in is removed, and the base branch is left exactly where it was — the criterion
 *  is that a conflict leaves no merge in progress, because the next tick and a person both
 *  have to find a tree they can use.
 *
 *  The order matters. `already-ancestor` is asked *before* the merge, because git answers
 *  "Already up to date" with exit 0 and afterwards the two are indistinguishable. */
export async function attemptLanding(place: LandPlace): Promise<LandAttempt> {
  const { repo, base, branch, tree } = place;
  if (!(await has(repo, branch))) return { kind: "nothing", why: "no-branch" };
  if (!(await has(repo, base))) return { kind: "refused", why: `there is no ${base} to land on` };
  if (await isLanded(repo, base, branch)) return { kind: "nothing", why: "already-ancestor" };

  const tip = await quiet(repo, ["rev-parse", `refs/heads/${base}`]);
  if (tip === null) return { kind: "refused", why: `${base} is not a branch: nothing to move onto the merge` };

  // Whatever an interrupted tick left at this path is not work: the branch is the only copy
  // of anything that matters, and the tree is cut afresh at the base tip below.
  await quiet(repo, ["worktree", "remove", "--force", tree]);
  await quiet(repo, ["worktree", "prune"]);
  const cut = await quiet(repo, ["worktree", "add", "--detach", tree, base]);
  if (cut === null) return { kind: "refused", why: `no tree to merge in: ${tree} could not be cut at ${base}` };

  try {
    const merged = await merge(tree, branch);
    if (merged !== null) return { kind: "refused", why: merged };
    const sha = await git(tree, ["rev-parse", "HEAD"]);
    // Compare-and-swap. The old tip is named, so a base that moved under the merge — a
    // second runner, a person pushing — refuses the swap and leaves the merge unclaimed
    // rather than overwriting what arrived.
    const moved = await quiet(repo, ["update-ref", `refs/heads/${base}`, sha, tip]);
    if (moved === null) {
      return { kind: "refused", why: `${base} moved while ${branch} was being merged: the landing is not made` };
    }
    return { kind: "landed", sha };
  } finally {
    await quiet(repo, ["worktree", "remove", "--force", tree]);
  }
}

/** The merge itself, or the sentence saying why there is not one.
 *
 *  A conflict exits non-zero with the tree left mid-merge — a conflicted index, `MERGE_HEAD`
 *  written, half of another branch in the working files. The conflicted paths are read
 *  before the abort, because the abort is what throws that index away, and whether the abort
 *  worked is read back off the tree rather than off its exit code: `merge --abort` also
 *  fails when there was no merge to abort, and such a tree is not wedged. */
async function merge(tree: string, branch: string): Promise<string | null> {
  try {
    await git(tree, [
      "-c",
      "user.name=wecode",
      "-c",
      "user.email=wecode@localhost",
      "merge",
      "--no-ff",
      "-q",
      "-m",
      landSubject(branch),
      branch,
    ]);
    return null;
  } catch (err) {
    const conflicted = (await quiet(tree, ["diff", "--name-only", "--diff-filter=U"])) ?? "";
    await quiet(tree, ["merge", "--abort"]);
    const left = (await midMerge(tree))
      ? `the merge would not abort: ${tree} is left mid-merge and wants a person`
      : "no merge is left standing";
    const where = conflicted === "" ? "" : ` — conflicted in: ${conflicted.split("\n").join(", ")}`;
    return `${landSubject(branch)} failed${where} — ${left}`;
  }
}
