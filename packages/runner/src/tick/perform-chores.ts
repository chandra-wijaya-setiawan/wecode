import { execFile } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  applyChore,
  choreById,
  clearChoreRefusal,
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
import { isLanded } from "../land-chore.js";
import { refreshScope } from "./refresh.js";
import type { StoryChoresHost } from "./story-chores.js";
// The table descriptors and the shape the chore pass reports stay in `daemon.ts`, where
// `typed-daemon.test.ts` holds their column lists against the schema. Importing them back is
// a cycle on purpose: one definition beats a second copy that has to agree with it.
import { tbl, ENDED_PHASES, OPEN_PHASES, type ChorePass } from "../daemon.js";

const exec = promisify(execFile);

const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

/** What performing the chores needs on top of raising them: the fleet, the slots, and the
 *  role file the runner reads once a tick. Same rule as raising — everything the rest of the
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
