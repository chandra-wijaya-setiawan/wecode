import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { choreFor } from "@wecode/core";
import { queries } from "@wecode/core/dist/db.js";
import type { Refused, ScriptReport } from "../examiner.js";
import type { Trees } from "../git.js";
// The table descriptors and the two shapes the tick already reports stay in `daemon.ts`,
// where `typed-daemon.test.ts` holds their column lists against the schema. Importing them
// back is a cycle on purpose: one definition beats a second copy that has to agree with it.
import { reasonOf, tbl, type Behind, type StoryRow, type Waiting } from "../daemon.js";

const exec = promisify(execFile);

const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

/** A `refresh` chore in these states is one nobody has discharged yet: raised and unstarted,
 *  queued, or with a worker in the tree right now. `done` and `failed` are both settled —
 *  the repair has had its pass, and the story is judged as it stands. */
const REFRESH_OPEN = ["planned", "ready", "running"];

/** What one story-proving pass leaves behind: the verdicts, the stories nothing was judged
 *  under, and the repairs judgement is owed to. */
export interface Proven {
  readonly scripts: ScriptReport;
  readonly behind: readonly Behind[];
  readonly waiting: readonly Waiting[];
}

/** What this phase needs of the runner, and nothing more. The reads of the ledger and of the
 *  graph that are shared with the other phases — the walk up the ERD, the trees, the two
 *  ancestry questions — are still the runner's, and are handed in rather than copied. */
export interface ProveStoriesHost {
  readonly db: DatabaseSync;
  /** Only for tests: pretend every project lives here. */
  readonly repoRoot: string | undefined;
  readonly storyOfCriteria: (criteriaId: number) => StoryRow | null;
  readonly projectOf: (story: StoryRow) => { project: number; repo: string } | null;
  readonly treesFor: (repo: string) => Trees;
  readonly worktreeRoot: (repo: string) => string;
  readonly hasCommit: (repo: string, ref: string) => Promise<boolean>;
  readonly contains: (repo: string, branch: string, ref: string) => Promise<boolean>;
  readonly runAcceptanceTests: (story: number, tree: string) => Promise<ScriptReport>;
}

/** Acceptance tests, in the story tree, once the story's tasks are finished — and never
 *  before that tree has what the base has, nor while the repair that gives it the base is
 *  still open. See `Waiting`. */
export async function proveStories(host: ProveStoriesHost): Promise<Proven> {
  // DISTINCT has no spelling in the dialect and needs none: the stories are collected
  // into a Map keyed by id, which is what DISTINCT was for.
  const found = new Map<number, { id: number; slug: string; repo: string }>();
  for (const test of queries(host.db).selectFrom(tbl.test).select(["parent_id", "state"]).where("kind", "=", "script").all()) {
    if (!["ready", "failed"].includes(test.state)) continue;
    const story = host.storyOfCriteria(test.parent_id);
    if (story === null || story.state !== "in_progress" || found.has(story.id)) continue;
    const owner = host.projectOf(story);
    if (owner === null) continue;
    found.set(story.id, { id: story.id, slug: story.slug, repo: owner.repo });
  }
  const stories = [...found.values()].sort(byId);

  const passed: number[] = [];
  const failed: number[] = [];
  const skipped: number[] = [];
  const refused: Refused[] = [];
  const behind: Behind[] = [];
  const waiting: Waiting[] = [];
  for (const story of stories) {
    // Before the tree is touched at all: a worker may be in it on the very repair this
    // would race, and its own merge would then be judged as the story's code.
    const repair = choreFor(host.db, "refresh", "story", story.id);
    if (repair !== null && REFRESH_OPEN.includes(repair.state)) {
      const why = `waiting on its refresh: chore #${repair.id} is ${repair.state}`;
      // Both lists, and they answer different questions. `waiting` is why this story was
      // not judged; `behind` is that nothing under it was judged, which is what the tick
      // already reports and stays true here. The chore pass is handed `waiting` and reads
      // it first, so this row never feeds the raise-or-close rule.
      waiting.push({ story: story.id, why });
      behind.push({ story: story.id, why });
      continue;
    }
    try {
      const repo = host.repoRoot ?? story.repo;
      const tree = await host.treesFor(repo).storyTree(story.slug, join(host.worktreeRoot(repo), `story-${story.slug}`));
      const fresh = await refreshStoryTree(host, story.slug, repo, tree);
      if (!fresh.ok) {
        // Nothing is judged here, and nothing is recorded against the tests: they stay
        // exactly as they were, and the tick says why instead.
        behind.push({ story: story.id, why: fresh.why });
        continue;
      }
      const r = await host.runAcceptanceTests(story.id, tree);
      passed.push(...r.passed);
      failed.push(...r.failed);
      skipped.push(...r.skipped);
      refused.push(...(r.refused ?? []));
    } catch {
      // a story with no branch yet has nothing to prove
    }
  }
  return { scripts: { passed, failed, skipped, refused }, behind, waiting };
}

/** docs/design/18 `refresh`: the base has moved and a story tree in flight is behind it.
 *
 *  The check the design names is that the base is an ancestor of the story branch, and
 *  that is what this asks — off the graph, with `merge-base --is-ancestor`, rather than
 *  off a report. When it is not, the base is merged in, here and now: a fast merge the
 *  runner can make itself needs no worker, no chore and no tick of latency, and the
 *  common case of a story that is merely behind is exactly that.
 *
 *  When it will not merge, the answer is not a red verdict — it is `behind`. Judging in
 *  a tree that is missing the world tells you about the tree, and re-proving can never
 *  help because the code was never what was wrong. The caller raises the chore. */
async function refreshStoryTree(host: ProveStoriesHost, slug: string, repo: string, tree: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const branch = `story/${slug}`;
  let base: string;
  try {
    base = await host.treesFor(repo).integrationBranch();
  } catch (err) {
    return { ok: false, why: (err as Error).message };
  }
  // A repository whose base has no commit yet, or a story cut on the base itself, has
  // nothing to be behind.
  if (branch === base || !(await host.hasCommit(repo, base))) return { ok: true };
  if (await host.contains(repo, branch, base)) return { ok: true };

  try {
    const identity = ["-c", "user.name=wecode", "-c", "user.email=wecode@localhost"];
    const message = ["-m", `refresh ${branch} from ${base}`];
    await exec("git", [...identity, "merge", "--no-ff", "-q", ...message, base], { cwd: tree });
  } catch (err) {
    // Leave no half-merge standing: the next tick, and the chore's worker, both want the
    // branch as it was. Whether that worked is read back off the tree rather than off the
    // abort's exit code — `merge --abort` also fails when there was no merge to abort, and
    // that tree is not wedged. A tree still holding MERGE_HEAD is, and the sentence says
    // so rather than leaving the next tick to discover it.
    await exec("git", ["merge", "--abort"], { cwd: tree }).catch(() => undefined);
    const wedged = await midMerge(tree);
    const after = wedged
      ? `and the merge would not abort: ${tree} is left mid-merge and wants a person`
      : "no merge is left standing: the tree is as it was";
    return {
      ok: false,
      why: `${branch} is behind ${base} and will not take it: ${reasonOf(err)} — ${after}`,
    };
  }
  if (!(await host.contains(repo, branch, base))) {
    return { ok: false, why: `${branch} still does not contain ${base} after the merge` };
  }
  return { ok: true };
}

/** Is this tree still in the middle of a merge? `MERGE_HEAD` is git's own record of it,
 *  and it survives an abort that could not run. */
async function midMerge(tree: string): Promise<boolean> {
  return await exec("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: tree })
    .then(() => true)
    .catch(() => false);
}
