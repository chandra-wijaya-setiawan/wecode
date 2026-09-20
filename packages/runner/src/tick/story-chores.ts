import type { DatabaseSync } from "node:sqlite";
import { choreFor, choreRefusal, closeChore, ensureChore, recordChoreRefusal } from "@wecode/core";
import { queries } from "@wecode/core/dist/db.js";
import type { Trees } from "../git.js";
// The table descriptors and the shape the proving pass reports stay in `daemon.ts`, where
// `typed-daemon.test.ts` holds their column lists against the schema. Importing them back is
// a cycle on purpose: one definition beats a second copy that has to agree with it.
import { tbl, type Behind, type StoryRow } from "../daemon.js";

const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

/** What this phase needs of the runner, and nothing more. The reads of the ledger and of the
 *  graph that are shared with the other phases — the walk up the ERD, the trees, the two
 *  ancestry questions, the loss the orphan read names — are still the runner's, and are
 *  handed in rather than copied. */
export interface StoryChoresHost {
  readonly db: DatabaseSync;
  /** Only for tests: pretend every project lives here. */
  readonly repoRoot: string | undefined;
  readonly projectOf: (story: StoryRow) => { project: number; repo: string } | null;
  readonly treesFor: (repo: string) => Trees;
  readonly hasCommit: (repo: string, ref: string) => Promise<boolean>;
  readonly contains: (repo: string, branch: string, ref: string) => Promise<boolean>;
  readonly mergesCleanly: (repo: string, base: string, branch: string) => Promise<boolean>;
  readonly orphanedBy: (repo: string, branch: string, storyId: number) => Promise<string | null>;
}

/** docs/design/18. A story's branch will not merge into the base, or its tree will not
 *  take the base. Either way wecode owes itself the merge nobody can make deterministically.
 *
 *  Until now that was a sentence in a report: the merge in `landDoneTasks` swallowed the
 *  conflict, and a delivered story that could not be landed looked exactly like one that
 *  had been. A chore is the record of it — on the board, with a target and a check.
 *
 *  Every story with work under it is read, not only a delivered one, because `refresh` is
 *  owed while the work is in flight and not after it: story 165 was `in_progress` and a
 *  story behind the base, and because this read only `delivered`, the same acceptance test
 *  was re-proved in the same wrong tree with nothing on the board to say why. `planned` is
 *  left out because a story nobody has started has no branch, `dropped` because nothing is
 *  owed on it.
 *
 *  `merge` stays a delivered story's alone. A branch in flight is expected to diverge from
 *  the base, and that divergence is nobody's to fix until the story is finished; raising it
 *  early is a chore on every board in the workspace. That is why `refresh` is a second kind
 *  rather than a widened first: it is about the tree wecode is judging in right now.
 *
 *  "With work under it" is not a second clause in the query, because the branch is already
 *  the answer: `mergesCleanly` says yes to a ref that is not there, and a story with
 *  nothing under it has no branch, so it raises nothing without being asked separately.
 *
 *  This runs every tick and creates nothing on the second one: `ensureChore` is keyed on
 *  (kind, target), which is the condition itself. Level-triggered in both directions — the
 *  condition is re-read every tick and the chore follows it, true again re-raising one that
 *  had settled and false closing one that had not. Neither is a timer: this reads the
 *  branch against the base before it says either. */
export async function raiseStoryChores(host: StoryChoresHost, behind: readonly Behind[] = []): Promise<number[]> {
  const stories: { id: number; slug: string; project: number; repo: string; state: string }[] = [];
  for (const row of queries(host.db).selectFrom(tbl.story).all().sort(byId)) {
    if (!["in_progress", "on_hold", "delivered"].includes(row.state)) continue;
    const owner = host.projectOf(row);
    if (owner === null) continue;
    stories.push({ id: row.id, slug: row.slug, state: row.state, project: owner.project, repo: owner.repo });
  }

  const open: number[] = [];
  for (const story of stories) {
    const repo = host.repoRoot ?? story.repo;
    const base = await host.treesFor(repo).integrationBranch().catch(() => null);
    if (base === null) continue;
    const branch = `story/${story.slug}`;
    // `refresh` is about the tree wecode is judging in right now, and that is an
    // in_progress story's: only that story raises one. But a chore already on the board is
    // a claim about the branch, not about the story's state, so its check is re-read on
    // every tick whatever state the story has moved to — see `followRefresh`.
    open.push(...(await followRefresh(host, story, repo, branch, base, behind)));
    if (story.state !== "delivered") continue;
    if (await host.mergesCleanly(repo, base, branch)) {
      // The other half of the same rule. The conflict is gone, so an open chore for it is
      // a stale claim, and the row should say the world moved rather than sit in `failed`
      // being refused every tick.
      //
      // Unless the merge itself has been made — then the world did not move, a chore's
      // attempt did, and the chore's own check is what judges it. `merge` proves two
      // things and only one of them is the conflict; a story whose branch swallowed the
      // base and went red is drift to keep on the board, not a chore to close.
      const stale = choreFor(host.db, "merge", "story", story.id);
      if (stale !== null && !(await host.contains(repo, branch, base))) {
        closeChore(host.db, stale.id, `${branch} no longer conflicts with ${base}`, "runner");
      }
      continue;
    }

    const chore = ensureChore(host.db, {
      project_id: story.project,
      kind: "merge",
      target_type: "story",
      target_id: story.id,
      check: "the branch merges cleanly",
    });
    if (chore.state !== "done") open.push(chore.id);
  }
  return open;
}

/** The `refresh` chore, read off the branch.
 *
 *  The condition is `merge-base --is-ancestor base branch` and nothing else — the same
 *  question `refreshStoryTree` asks, asked off the graph rather than inherited from what
 *  the proving pass happened to report. `proveStories` looks only at an in_progress story
 *  with a ready or failed *script* acceptance test, so one whose tests are not scripts yet
 *  was invisible to it and nothing was raised about a tree that was plainly behind. It
 *  also stops the two disagreeing the other way: a story skipped because this very chore
 *  is open no longer needs a `waiting` list to keep the skip from reading as "the tree
 *  took the base".
 *
 *  `behind` is still taken, for one thing only: when the proving pass did try the merge,
 *  its conflict is the better sentence to record against the chore than "does not contain".
 *  It never decides whether the chore is owed.
 *
 *  Raising is an in_progress story's alone, but re-reading is not: a story that moves to
 *  `on_hold` or `delivered` with a `failed` refresh chore on it would otherwise keep that
 *  verdict for good, refusing a tree that took the base an hour later. So the check is
 *  re-read whatever state the story is in, and a chore whose condition has cleared is
 *  closed. A story that cannot raise one also cannot have one re-raised here — when it is
 *  still behind, an existing chore is left as it stands, and not dispatched, because
 *  nothing is being proved in that tree. */
async function followRefresh(host: StoryChoresHost, story: { id: number; slug: string; project: number; state: string }, repo: string, branch: string, base: string, behind: readonly Behind[]): Promise<number[]> {
  const chore = choreFor(host.db, "refresh", "story", story.id);
  if (!(await isBehind(host, repo, branch, base))) {
    // Up to date is not the same as repaired. A branch reset onto the base contains it by
    // construction, so this test alone blesses the one refresh that must never be blessed:
    // the one that threw the story's own work away to make the check true. So the chore
    // stays where it is, still owed, with the loss recorded against it.
    const orphaned = await host.orphanedBy(repo, branch, story.id);
    if (orphaned !== null) {
      if (chore === null) return [];
      if (chore.state !== "running") recordChoreRefusal(host.db, orphaned, chore.id);
      return chore.state === "done" ? [] : [chore.id];
    }
    // The world moved: the branch took the base, so what was owed is not owed any more.
    // `running` is left alone — a worker is in the tree on it, and the verdict is that
    // attempt's to give.
    if (chore !== null && chore.state !== "running") {
      closeChore(host.db, chore.id, `${branch} is up to date with ${base}`, "runner");
    }
    return [];
  }
  // Still behind, and this story is not being proved in. The chore stands as it is.
  if (story.state !== "in_progress") return [];
  const why = behind.find((b) => b.story === story.id)?.why ?? `${branch} does not contain ${base}`;
  const raised = ensureChore(host.db, {
    project_id: story.project,
    kind: "refresh",
    target_type: "story",
    target_id: story.id,
    check: "the base is an ancestor of the branch",
  });
  // One row, two voices, and only one is worth an operator's attention. `chore_refusal`
  // holds one sentence per chore, and this one — why the work is owed — is already said by
  // the chore's kind and check, where the dispatcher's and the judge's say what the record
  // does not. Written unconditionally it landed on top of those every tick, resetting a
  // held dispatch refusal's `since`/`passes` and costing a `failed` chore its verdict. So
  // it seeds an empty row and never overwrites; `reraiseChore` clears it when the
  // condition comes back.
  if (choreRefusal(host.db, raised.id) === null) recordChoreRefusal(host.db, why, raised.id);
  return raised.state === "done" ? [] : [raised.id];
}

/** Is this story's branch missing the base? Two things are not being behind rather than
 *  being behind: a story cut on the base itself, and a branch that is not there at all —
 *  a story nobody has started owes no merge, and asking git about a missing ref would
 *  answer "no, it does not contain the base" and raise a chore with no tree to do it in. */
async function isBehind(host: StoryChoresHost, repo: string, branch: string, base: string): Promise<boolean> {
  if (branch === base) return false;
  if (!(await host.hasCommit(repo, base)) || !(await host.hasCommit(repo, branch))) return false;
  return !(await host.contains(repo, branch, base));
}
