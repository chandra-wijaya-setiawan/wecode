import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Every question the refresh and the behind-ness rules ask, in one module.
 *
 *  `tick/prove-stories.ts` refreshes the tree it judges in, `tick/story-chores.ts` decides
 *  whether a branch is behind its base and what a refresh threw away, and `daemon.ts` lands
 *  on the same reads when it merges a task or a delivered story. All three used to reach a
 *  private method on the runner for each, so the runner carried git ancestry in among the
 *  ledger and the dispatch. They are reads of the graph and of nothing else: no ledger, no
 *  trees, no state — which is why they are free functions here rather than a host interface.
 *
 *  The one exception is `orphanedBy`, which needs the attempt commits the ledger recorded
 *  for the story. Those are handed in, because the walk to them is the runner's. */

/** Is this ref a commit in this repository? */
export async function hasCommit(repo: string, ref: string): Promise<boolean> {
  return await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo })
    .then(() => true)
    .catch(() => false);
}

/** `git merge-base --is-ancestor`: the merge, read off the graph rather than off a report. */
export async function contains(repo: string, branch: string, base: string): Promise<boolean> {
  return await exec("git", ["merge-base", "--is-ancestor", base, branch], { cwd: repo })
    .then(() => true)
    .catch(() => false);
}

/** The commit a ref stands at, or null when it is not there or cannot be read. */
export async function tipOf(repo: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Would this branch merge into the base, without touching either?
 *
 *  `merge-tree --write-tree` answers it in the object store: no checkout, no index, and
 *  nothing to clean up if the answer is no.
 *
 *  Both refs are checked first, because merge-tree exits 1 for a ref that is not there
 *  as well as for a conflict. Read off the exit code alone, a story that never had a
 *  branch gets a merge chore that no merge could ever discharge. */
export async function mergesCleanly(repo: string, base: string, branch: string): Promise<boolean> {
  for (const ref of [base, branch]) if (!(await hasCommit(repo, ref))) return true;
  return await exec("git", ["merge-tree", "--write-tree", base, branch], { cwd: repo })
    .then(() => true)
    .catch(() => false);
}

/** The paths a base-into-branch merge would conflict on: empty when it conflicts on none,
 *  null when merge-tree gave no answer. Read off the object store, which writes no files
 *  and cannot wedge the tree the worker is about to be handed.
 *
 *  Exit 1 is an answer, not the failure — it is what git returns when the merge conflicts
 *  — and with `--name-only --no-messages` stdout is the written tree's oid on the first
 *  line and one conflicting path on each line after it. Exit 0 is the other answer, the
 *  clean merge, and it names no paths because there are none. Only some other exit —
 *  git too old, a ref that is gone — settled nothing, and only it is no answer. */
export async function conflictedPaths(repo: string, branch: string, base: string): Promise<string[] | null> {
  const args = ["merge-tree", "--write-tree", "--name-only", "--no-messages", branch, base];
  const out = await exec("git", args, { cwd: repo })
    .then(() => "")
    .catch((err: { code?: number; stdout?: string }) => (err.code === 1 ? (err.stdout ?? "") : null));
  if (out === null) return null;
  return out
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The scope a `refresh` chore is dispatched under: the role's, narrowed to the paths the
 *  merge will actually conflict on.
 *
 *  `system` is declared `write: ["**"]` because a conflict is wherever the conflict is, and
 *  for a `merge` chore — whose merge is the branch into the base, a graph this tree cannot
 *  be asked about — that stays the honest answer. A refresh is the other direction, and
 *  there the paths are knowable before a worker is hired.
 *
 *  A refresh that conflicts on nothing claims nothing: git makes that merge by itself. The
 *  role's scope is the ceiling — this only ever narrows — and it is the fallback for a
 *  merge-tree that could not be asked (git too old, a ref that is gone). */
export async function refreshScope<S extends { write: readonly string[] }>(
  repo: string,
  branch: string,
  base: string,
  role: S,
): Promise<S> {
  const conflicted = await conflictedPaths(repo, branch, base);
  return conflicted === null ? role : { ...role, write: conflicted };
}

const KEPT = "a refresh adds the base, it does not replace the branch";

/** What a refresh has thrown away, or null when it has thrown nothing away.
 *
 *  "Is the base an ancestor of the branch" is the whole check, and `git reset --hard base`
 *  passes it while doing the opposite of the work — as does a rebase that drops a commit.
 *
 *  Two records say what the branch held. `landed` names the tip `landDoneTasks` merged per
 *  task, and goes first because it names the task; an empty `sha` is left out by the caller,
 *  since a tip that could not be read then is not evidence a known commit is gone now. The
 *  branch's own reflog covers the rest. */
export async function orphanedBy(
  repo: string,
  branch: string,
  landed: readonly { task: number; sha: string }[],
): Promise<string | null> {
  const lost: string[] = [];
  for (const row of landed) {
    if (!(await contains(repo, branch, row.sha))) lost.push(`task ${row.task} at ${row.sha.slice(0, 12)}`);
  }
  if (lost.length > 0) return `it no longer reaches work wecode merged into it: ${lost.join(", ")} — ${KEPT}`;
  const tips = await droppedTips(repo, branch);
  return tips.length === 0 ? null : `it no longer reaches a commit it already held: ${tips.join(", ")} — ${KEPT}`;
}

/** The commits this branch has stood at and can no longer reach, newest first.
 *
 *  `landed` only knows the tips wecode merged in, so everything a worker committed on the
 *  branch itself — a settled conflict, a refresh's own merge commit, a story with no landed
 *  task at all — had nothing defending it, and a reset onto the base dropped it unseen. A
 *  story branch only ever moves forward: wecode merges into it and `update-ref`s it to a
 *  commit that already contained it, and every reset it makes is in a detached tree. So a
 *  former tip that is unreachable now was thrown away by hand. */
async function droppedTips(repo: string, branch: string): Promise<string[]> {
  const seen = await exec("git", ["reflog", "show", "--format=%H", `refs/heads/${branch}`], { cwd: repo })
    .then((r) => r.stdout.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l)))
    .catch(() => [] as string[]);
  const lost: string[] = [];
  for (const tip of new Set(seen)) if (!(await contains(repo, branch, tip))) lost.push(tip.slice(0, 12));
  return lost;
}
