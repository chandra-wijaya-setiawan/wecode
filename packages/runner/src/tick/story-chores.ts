import { execFile } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  applyChore,
  choreById,
  choreFor,
  choreRefusal,
  clearChoreRefusal,
  closeChore,
  ensureChore,
  CHORE_KIND_DEFS,
  Maker,
  performedByTheRunner,
  recordChoreRefusal,
  reraiseChore,
  type Budget,
  type Chore,
  type Scope,
} from "@wecode/core";
import { queries } from "@wecode/core/dist/db.js";
import type { Trees } from "../git.js";
import { isLanded } from "../land-chore.js";
import { refreshScope } from "./refresh.js";
// The table descriptors and the shape the proving pass reports stay in `daemon.ts`, where
// `typed-daemon.test.ts` holds their column lists against the schema. Importing them back is
// a cycle on purpose: one definition beats a second copy that has to agree with it.
import { tbl, ENDED_PHASES, OPEN_PHASES, type Behind, type ChorePass, type StoryRow } from "../daemon.js";

const exec = promisify(execFile);

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

/** What performing the chores needs on top of raising them: the fleet, the slots, and the
 *  role file the runner reads once a tick. Same rule as above — everything the rest of the
 *  runner already owns is handed in rather than copied. */
export interface ChoreHost extends StoryChoresHost {
  readonly worktreeRoot: (repo: string) => string;
  readonly criteriaOfStory: (storyId: number) => Set<number>;
  readonly freeWorker: (role: string) => number | null;
  readonly scopeOfRole: (repo: string, role: string) => { ok: true; scope: Scope } | { ok: false; why: string };
  /** The ceiling on assignments open at once, and the budget a chore's attempt is given. */
  readonly maxOpen: number;
  readonly choreBudget: Budget;
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

/** docs/design/18. The other half of a chore: judge the attempt that has ended, then hand
 *  the next one out.
 *
 *  Judging first is what makes the slot free again within the tick, and what stops an
 *  agent's word being the record: a chore is done because the runner proved the check,
 *  never because the session exited zero. */
export async function performChores(host: ChoreHost, paused: string | null = null): Promise<ChorePass> {
  const done: number[] = [];
  const failed: { id: number; why: string }[] = [];
  const dispatched: number[] = [];

  for (const row of endedChoreAttempts(host.db)) {
    const chore = choreById(host.db, row.chore);
    // Only an attempt of a chore still in hand is judged. A chore already done or already
    // failed has a verdict, and the ended assignment beside it is only history.
    if (chore === null || chore.state !== "running") continue;
    const proved = await proveChore(host, chore);
    if (proved.ok) {
      if (applyChore(host.db, chore.id, "finish", "runner").ok) done.push(chore.id);
    } else if (applyChore(host.db, chore.id, "fail", "runner").ok) {
      // The verdict is written to the chore, not only reported in the pass. `fail` clears
      // whatever the last tick said about this chore, and the pass is a log line that
      // scrolls, so without this a failed chore sits on the board saying nothing at all —
      // and the one that has used its attempts sits there for good, never raised again and
      // never explained. Recorded after the verb, so the reason is the one this tick read.
      recordChoreRefusal(host.db, proved.why, chore.id);
      failed.push({ id: chore.id, why: proved.why });
    }
  }

  // Judged either way; handed out only when dispatch is running. A chore is an attempt
  // like any other, and a paused tick must not spend one on an unreachable model.
  for (const row of dispatchableChores(host.db)) {
    const chore = choreById(host.db, row.id);
    if (chore === null) continue;
    if (paused !== null) {
      refuseChore(host.db, chore, paused);
      continue;
    }
    const id = await dispatchChore(host, chore);
    if (id !== null) dispatched.push(chore.id);
  }
  return { dispatched, done, failed };
}

function endedChoreAttempts(db: DatabaseSync): { id: number; chore: number; worktree: string }[] {
  return queries(db)
    .selectFrom(tbl.assignment).select(["id", "objective_id", "worktree", "phase"]).where("objective_type", "=", "chore").all()
    .filter((a) => ENDED_PHASES.includes(a.phase)).sort(byId)
    .map((a) => ({ id: a.id, chore: a.objective_id, worktree: a.worktree }));
}

/** Chores with nothing already attempting them. The guard matters: without it a chore
 *  whose `begin` did not land is handed out again next tick while its first assignment
 *  is still running, and then two workers are in one tree. */
function dispatchableChores(db: DatabaseSync): { id: number }[] {
  const q = queries(db);
  const attempting = new Set(
    q.selectFrom(tbl.assignment).select(["objective_type", "objective_id", "phase"]).where("objective_type", "=", "chore").all()
      .filter((a) => OPEN_PHASES.includes(a.phase)).map((a) => a.objective_id),
  );
  // A kind wecode performs itself is never handed to a worker. `land` is one: its merge
  // is into the base branch, and the only tree an agent may be dispatched into is the
  // story tree, where that merge cannot be made at all. `landDeliveredStories` is where
  // its attempts happen, and the reason it is still open is already on its own row.
  return q.selectFrom(tbl.chore).all()
    .filter((c) => ["planned", "ready"].includes(c.state) && !attempting.has(c.id))
    .filter((c) => !performedByTheRunner(c.kind)).sort(byId).map((c) => ({ id: c.id }));
}

/** The attempt: a system worker, in a tree at the chore's target branch, with the role's
 *  own scope off the record.
 *
 *  Every refusal here is level-triggered — no worker free, no slot, no role on the record
 *  — because none of them is the chore's fault and all of them heal on a later tick. None
 *  of them is silent either: a chore that sits in `planned` for half an hour is only
 *  readable if it says which of these is holding it, so each is written to `chore_refusal`
 *  in the same voice a task's refusal uses, and cleared the moment it is dispatched.
 *
 *  The chore is left where it was and stays on the board: a `planned` chore is only
 *  started once there is somewhere for it to go. */
async function dispatchChore(host: ChoreHost, chore: Chore): Promise<number | null> {
  const def = CHORE_KIND_DEFS[chore.kind];
  if (def === undefined) return refuseChore(host.db, chore, `no kind on the record for a ${chore.kind} chore`);
  const target = storyTargetOf(host, chore);
  if (target === null) return refuseChore(host.db, chore, "the story it targets is gone");
  const scope = host.scopeOfRole(target.repo, def.role);
  if (!scope.ok) return refuseChore(host.db, chore, scope.why);
  const open = openAssignments(host.db);
  const max = host.maxOpen;
  if (open >= max) return refuseChore(host.db, chore, `${max - open} of ${max} slots are open`);
  const worker = host.freeWorker(def.role);
  if (worker === null) return refuseChore(host.db, chore, `no worker free for role ${def.role}`);

  try {
    const trees = host.treesFor(target.repo);
    const branch = `story/${target.slug}`;
    // The one thing a chore may never be given: a tree on the base branch. A merge made
    // there is a landing, and landing is the operator's verb.
    if (branch === (await trees.integrationBranch())) {
      return refuseChore(host.db, chore, `${branch} is the base branch: landing is yours to do, not a chore's`);
    }
    const tree = await trees.storyTree(target.slug, join(host.worktreeRoot(target.repo), `story-${target.slug}`));
    const claimed = await claimedScope(host, chore, target.repo, branch, scope.scope);
    // The approval guard lives in `start`, so a kind that needs one refuses here and
    // nothing is created for it.
    if (chore.state === "planned") {
      const started = applyChore(host.db, chore.id, "start", "runner");
      if (!started.ok) return refuseChore(host.db, chore, started.why);
    }
    const id = new Maker(host.db).assignment({
      objective_type: "chore" as "task",
      objective_id: chore.id,
      worker_id: worker,
      scope: claimed,
      budget: host.choreBudget,
      worktree: tree,
    });
    // Dispatched: the assignment exists, so whatever was holding it a tick ago is no
    // longer true of it. Cleared here rather than after `begin`, because every way out
    // from this line on is a way out with an assignment open — and a chore being
    // attempted must never also be showing a reason it is not.
    clearChoreRefusal(host.db, chore.id);
    const begun = applyChore(host.db, chore.id, "begin", `worker-${worker}`);
    if (!begun.ok) return refuseChore(host.db, chore, begun.why);
    return id;
  } catch (err) {
    // No branch, or no tree to be had. Which one it was is git's to say: the fixed
    // "no branch to merge into yet" read identically whether the branch was missing, the
    // worktree path was occupied by a file, or the index was locked, and the operator had
    // to go to the tree themselves to find out. Report what was actually caught.
    return refuseChore(host.db, chore, (err as Error).message);
  }
}

/** Write the reason down and hand back the answer dispatchChore already gives. One
 *  statement, so no branch of dispatchChore can record a reason and return the other
 *  thing, or return without recording. */
function refuseChore(db: DatabaseSync, chore: Chore, why: string): null {
  recordChoreRefusal(db, why, chore.id);
  return null;
}

/** The scope a chore is actually dispatched under: the role's, narrowed by the refresh's
 *  own read of what the merge will conflict on. Every other kind is dispatched at the
 *  role's, which for a `merge` is the honest answer — see `refreshScope`. */
async function claimedScope(host: ChoreHost, chore: Chore, repo: string, branch: string, role: Scope): Promise<Scope> {
  if (chore.kind !== "refresh") return role;
  try {
    return await refreshScope(repo, branch, await host.treesFor(repo).integrationBranch(), role);
  } catch {
    return role;
  }
}

function openAssignments(db: DatabaseSync): number {
  return queries(db)
    .selectFrom(tbl.assignment).select(["phase"]).all()
    .filter((a) => OPEN_PHASES.includes(a.phase)).length;
}

/** The check, proved by this machine. For `merge`: the base is an ancestor of the branch —
 *  which is the merge having been made, not an agent's report of it — and the suite the
 *  story carries is still green.
 *
 *  `refresh` proves the same two things, so it is the same code and not a copy of it.
 *  docs/design/18 words them from either end — "the branch merges cleanly into the base"
 *  and "the base merges into the story branch" — but one graph answers both: once the
 *  base is an ancestor of the branch there is nothing left to conflict. */
async function proveChore(host: ChoreHost, chore: Chore): Promise<{ ok: true } | { ok: false; why: string }> {
  const target = storyTargetOf(host, chore);
  if (chore.kind === "land") {
    // The landing's check is the mirror of the merge's: the *base* contains the branch.
    // Nothing dispatches a `land` chore, so being asked here at all means an assignment
    // outlived the rule — and the answer is still the graph's, not the assignment's.
    if (target === null) return { ok: false, why: "its target story is not on the record" };
    const branch = `story/${target.slug}`;
    const base = await host.treesFor(target.repo)
      .integrationBranch()
      .catch(() => null);
    if (base === null) return { ok: false, why: "there is no base branch to land on" };
    return (await isLanded(target.repo, base, branch))
      ? { ok: true }
      : { ok: false, why: `${base} does not contain ${branch}: the landing was not made` };
  }
  if (chore.kind !== "merge" && chore.kind !== "refresh") {
    return { ok: false, why: `nothing here knows how to prove a ${chore.kind} chore` };
  }
  if (target === null) return { ok: false, why: "its target story is not on the record" };

  const branch = `story/${target.slug}`;
  try {
    const base = await host.treesFor(target.repo).integrationBranch();
    if (!(await host.contains(target.repo, branch, base))) {
      return { ok: false, why: `${base} is not an ancestor of ${branch}: the merge was not made` };
    }
    // Asked before the suite, because a branch that dropped the work it was carrying is
    // green for the wrong reason: the tests that would have failed went with the commits.
    const orphaned = await host.orphanedBy(target.repo, branch, target.story);
    if (orphaned !== null) return { ok: false, why: `${branch} contains ${base}, but ${orphaned}` };
    const red = await suiteRed(host, target);
    if (red !== null) return { ok: false, why: `${branch} contains ${base}, but the suite is red: ${red}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, why: (err as Error).message };
  }
}

/** The first of the story's scripts that fails in the merged tree, or null when they all
 *  pass. Run, not recorded: a verdict belongs to the test's own pass, and this is only the
 *  chore's check asking whether the merge broke anything. */
async function suiteRed(host: ChoreHost, target: { slug: string; repo: string; story: number }): Promise<string | null> {
  const under = host.criteriaOfStory(target.story);
  const rows = queries(host.db)
    .selectFrom(tbl.test).select(["id", "artefact", "parent_id", "state"])
    .where("kind", "=", "script").where("artefact", "!=", null).where("state", "!=", "dropped").all()
    .filter((t) => under.has(t.parent_id)).sort(byId)
    .flatMap((t) => (t.artefact === null ? [] : [{ artefact: t.artefact }]));
  if (rows.length === 0) return null;

  const tree = await host.treesFor(target.repo).storyTree(
    target.slug,
    join(host.worktreeRoot(target.repo), `story-${target.slug}`),
  );
  for (const row of rows) {
    const green = await exec("bash", ["-lc", row.artefact], {
      cwd: tree,
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    })
      .then(() => true)
      .catch(() => false);
    if (!green) return row.artefact;
  }
  return null;
}

function storyTargetOf(host: ChoreHost, chore: Chore): { story: number; slug: string; repo: string } | null {
  if (chore.target_type !== "story") return null;
  const row = queries(host.db).selectFrom(tbl.story).where("id", "=", chore.target_id).get();
  if (row === null) return null;
  const owner = host.projectOf(row);
  if (owner === null) return null;
  return { story: row.id, slug: row.slug, repo: host.repoRoot ?? owner.repo };
}

/** Bring a `land` chore to `running` for this tick's attempt, or say there is not one to
 *  be had. `reraiseChore` is the ceiling: it refuses a chore that has used its attempts,
 *  and that refusal is what stops the runner retrying a landing for ever. */
export function beginLandChore(db: DatabaseSync, id: number): boolean {
  const found = choreById(db, id);
  if (found === null) return false;
  if ((found.state === "failed" || found.state === "done") && !reraiseChore(db, id, "runner").ok) return false;
  const planned = choreById(db, id);
  if (planned?.state === "planned" && !applyChore(db, id, "start", "runner").ok) return false;
  const ready = choreById(db, id);
  if (ready?.state === "running") return true;
  return applyChore(db, id, "begin", "runner").ok;
}

/** The attempt commits this story's tasks landed on its branch. The walk is
 *  task → acceptance_test → criteria, which is `criteriaOfStory` from the other end. */
export function landedAttempts(db: DatabaseSync, under: Set<number>): { task: number; sha: string }[] {
  const q = queries(db);
  const tests = new Set(
    q.selectFrom(tbl.test).select(["id", "parent_id"]).all().filter((t) => under.has(t.parent_id)).map((t) => t.id),
  );
  const tasks = new Set(
    q.selectFrom(tbl.task).select(["id", "acceptance_test_id"]).all()
      .filter((t) => tests.has(t.acceptance_test_id)).map((t) => t.id),
  );
  return q.selectFrom(tbl.landed).select(["task_id", "sha"]).all()
    .filter((r) => tasks.has(r.task_id) && r.sha !== "")
    .map((r) => ({ task: r.task_id, sha: r.sha }));
}
