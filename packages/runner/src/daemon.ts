import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  applyChore,
  clearRefusal,
  choreFor,
  closeChore,
  Engine,
  ensureChore,
  loadRoles,
  now,
  recordChoreRefusal,
  recordRefusal,
  Verbs,
  type Budget,
  type ChoreKind,
  type RoleConfig,
  type Scope,
  type Violation,
} from "@wecode/core";
// The dialect is core's, but core's barrel does not re-export it — `db.js` is imported by
// path so that porting this module needs no change to a file outside it.
import { excluded, queries, table } from "@wecode/core/dist/db.js";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { allocate, candidates as readyCandidates, type Candidate, type Pass } from "./allocator.js";
import type { BudgetConfig } from "./budget.js";
import { Foreman, type TickReport } from "./foreman.js";
import type { WorkerAdapter } from "./ports.js";
import { Doctor, type Invariant } from "./doctor.js";
import { Examiner, type Refused, type ScriptReport } from "./examiner.js";
import { Trees } from "./git.js";
import { attemptLanding, isLanded, LAND_CHECK } from "./land-chore.js";
import { proveRedAtBase, type RedAtBase } from "./tick/red-at-base.js";
import { proveStories, type Proven } from "./tick/prove-stories.js";
import { raiseStoryChores } from "./tick/story-chores.js";
import { beginLandChore, landedAttempts, performChores as performChorePass, type ChoreHost } from "./tick/story-chores.js";
import * as refresh from "./tick/refresh.js";
import { settleEnded, type Settled } from "./tick/settle.js";

const exec = promisify(execFile);

/** The tables this module reads, and only the columns it asks for.
 *
 *  Kept in one object rather than as bare consts because `task`, `story`, `chore`, `worker`
 *  and `test` are all local names in here: a bare `story` const would be shadowed in half
 *  the methods that need it, and the shadowing would typecheck.
 *
 *  A narrow column list is the ask, not a second copy of the schema — `typed-daemon.test.ts`
 *  holds every list below against `PRAGMA table_info`, so a column renamed out from under
 *  this module fails a test rather than a tick. */
interface TaskRow {
  id: number;
  slug: string;
  acceptance_test_id: number;
  attempts: number;
  max_retry: number;
  state: string;
}

interface AssignmentRow {
  id: number;
  objective_type: string;
  objective_id: number;
  worker_id: number;
  worktree: string;
  phase: string;
  session: string | null;
  commit_sha: string | null;
  updated_at: string;
}

interface TestRow {
  id: number;
  parent_id: number;
  kind: string;
  artefact: string | null;
  state: string;
  red_at_base_sha: string | null;
  red_at_base_at: string | null;
  red_at_base_reason: string | null;
  updated_at: string;
}

export interface StoryRow {
  id: number;
  slug: string;
  epic_id: number;
  state: string;
}

interface ScriptRunRow {
  entity: string;
  test_id: number;
  fingerprint: string;
  ran_at: string;
}

interface LandedRow {
  task_id: number;
  branch: string;
  sha: string;
  merged_at: string;
}

export const tbl = {
  task: table<TaskRow>("task", ["id", "slug", "acceptance_test_id", "attempts", "max_retry", "state"]),
  assignment: table<AssignmentRow>("assignment", ["id", "objective_type", "objective_id", "worker_id", "worktree", "phase", "session", "commit_sha", "updated_at"]),
  test: table<TestRow>("acceptance_test", ["id", "parent_id", "kind", "artefact", "state", "red_at_base_sha", "red_at_base_at", "red_at_base_reason", "updated_at"]),
  criteria: table<{ id: number; requirement_id: number }>("acceptance_criteria", ["id", "requirement_id"]),
  requirement: table<{ id: number; story_id: number }>("requirement", ["id", "story_id"]),
  story: table<StoryRow>("story", ["id", "slug", "epic_id", "state"]),
  epic: table<{ id: number; release_id: number }>("epic", ["id", "release_id"]),
  release: table<{ id: number; project_id: number }>("release", ["id", "project_id"]),
  project: table<{ id: number; repo: string }>("project", ["id", "repo"]),
  worker: table<{ id: number; role: string }>("worker", ["id", "role"]),
  refusal: table<{ task_id: number }>("refusal", ["task_id"]),
  chore: table<{ id: number; state: string; kind: ChoreKind }>("chore", ["id", "state", "kind"]),
  scriptRun: table<ScriptRunRow>("script_run", ["entity", "test_id", "fingerprint", "ran_at"]),
  landed: table<LandedRow>("landed_branch", ["task_id", "branch", "sha", "merged_at"]),
};

/** An assignment nobody has finished with, and one that has ended. Two names for one rule
 *  that used to be spelled out in five query strings. */
export const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];
export const ENDED_PHASES: readonly string[] = ["succeeded", "failed"];

const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

/** How many in a row it takes to call the model unreachable rather than the attempt
 *  unlucky, and what one of them looks like on the record. */
const UNREACHED = 2;
/** How long the pause holds before one attempt is let through at the model again. A pause
 *  nothing can lift is a wedge: an api error is usually a minute of weather. */
const PAUSE_MS = 10 * 60 * 1000;
const unreached = (a: { phase: string; session: string | null; commit_sha: string | null }): boolean =>
  a.phase === "failed" && (a.session ?? "") === "" && (a.commit_sha ?? "") === "";

export interface Tick {
  readonly allocated: Pass;
  readonly foreman: TickReport;
  readonly scripts: ScriptReport;
  readonly committed: readonly number[];
  readonly merged: readonly number[];
  /** Task merges that conflicted, and still do. Every one that is true as of this tick,
   *  whether or not the merge was re-attempted on it. */
  readonly conflicts: readonly Conflict[];
  /** Stories this tick put in the base branch, with the commit the base became. Empty is
   *  the ordinary answer: a story lands once, and every tick after that reads it as already
   *  there rather than landing it again. */
  readonly landed: readonly Landed[];
  /** Tasks that ran out of attempts on this tick. */
  readonly exhausted: readonly number[];
  /** Chores wecode owes itself, as of this tick. Every open one, not only the new ones:
   *  the number is the backlog, and a backlog that shrank is worth seeing. */
  readonly chores: readonly number[];
  /** What the system worker did with them: dispatched this tick, proved done, or failed
   *  with the reason the check was not proved. */
  readonly performed: ChorePass;
  /** Tasks that have used every attempt while the story that needs them is still open. */
  readonly drift: readonly Drift[];
  /** Completion transitions that fired because their guard had become true. */
  readonly settled: readonly string[];
  /** Acceptance tests this tick ran at their story's base: red there, or green and so
   *  unable to prove anything. */
  readonly redAtBase: RedAtBase;
  /** Stories whose tree is behind the base and could not be brought up to it. Nothing in
   *  them was judged this tick. */
  readonly behind: readonly Behind[];
  /** Stories left alone this tick because a `refresh` chore for them is still open. Nothing
   *  in them was judged, and the reason is here rather than nowhere. */
  readonly waiting: readonly Waiting[];
  /** What the invariant set found this tick. Recorded as well as returned, so a view reads
   *  the table rather than running the pass again. Empty is the healthy answer. */
  readonly doctor: readonly Violation[];
  /** Why nothing was dispatched this tick, or null on an ordinary one. See `apiErrorPause`. */
  readonly paused: string | null;
}

/** A story that reached the base branch on this tick, and the commit the base became.
 *  A sha, not a boolean: docs/design/14 — it says whether it landed, as what, and whether
 *  the base is still that. */
export interface Landed {
  readonly story: number;
  readonly sha: string;
  /** What the operator has to be told about their own checkout, when the ref moved under
   *  it and wecode was not allowed to bring it forward. Absent is the silent case: their
   *  folder shows the landed files already. */
  readonly notice?: string;
}

/** A task branch that will not merge into its story branch. The two tips it was attempted
 *  between are part of it: they are what says the conflict is still the same one, and a
 *  merge is not tried again until one of them moves. */
export interface Conflict {
  readonly task: number;
  readonly branch: string;
  readonly story: string;
  readonly why: string;
  readonly tips: string;
}

/** An exhausted task, and the story left waiting on it. Named, because the cost is the
 *  story: three tasks at 3 of 3 held two stories open for a day and the only thing that
 *  moved them was a person noticing. */
export interface Drift {
  readonly task: number;
  readonly slug: string;
  readonly story: string;
  readonly why: string;
}

/** A story whose tree is missing what the base has, and why wecode could not fix it.
 *
 *  An acceptance test judged in such a tree is not failing, it is uninformed: acceptance
 *  test 166 went red in loadViews because the branch predated the services box that landed
 *  with story 152, and re-proving could never help. So a story that is behind is named and
 *  nothing under it is judged — a red verdict out of a stale tree costs a whole budget. */
export interface Behind {
  readonly story: number;
  readonly why: string;
}

/** A story whose judgement is owed to a repair wecode has already asked for, and which
 *  repair that is.
 *
 *  Live proof, 15 Sep: chore 4, `refresh` on story 165, was running when acceptance_test 166
 *  was judged at 21:14 and went red on the same stale-tree loadViews error; the chore then
 *  finished, the branch gained the base, and the test passed at 21:17 untouched. So while
 *  that repair is open the story is not judged, and the operator reads "waiting on its
 *  refresh" instead of a failure that was never about the code. */
export interface Waiting {
  readonly story: number;
  readonly why: string;
}

/** The `script_run` entity a run at base is recorded under — its own, so it never collides
 *  with the examiner's verdict rows for the same test. Named once: the insert and the read
 *  that decides whether the run is owed have to agree, and two literals eventually do not. */
const BASE_RUN = "acceptance_test@base";

/** One tick's chore work. `failed` carries the reason, because a chore that could not prove
 *  its check leaves a story unmergeable and the reason is the only thing a person can act
 *  on. */
export interface ChorePass {
  readonly dispatched: readonly number[];
  readonly done: readonly number[];
  readonly failed: readonly { readonly id: number; readonly why: string }[];
}

/** A chore's brief is the foreman's; its budget is the operator's. The default mirrors
 *  `defaults.budget` in config/roles.yaml, which is where the number belongs — bin.ts has
 *  the file loaded and passes it. */
const CHORE_BUDGET: Budget = { tokens: 250000, seconds: 3600 };

/** Where a project declares its roles, relative to its repository. Named once, because the
 *  refusals quote it and a quoted path that is not the path read is a lie. */
const ROLES_FILE = "config/roles.yaml";

/** What git said, first line only. The conflict list behind it is the worker's to read in
 *  the tree; a refusal on the board wants the sentence, not the file list. */
export const reasonOf = (err: unknown): string => {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const said = (e.stderr ?? "").trim() || (e.stdout ?? "").trim() || (e.message ?? "").trim();
  return said.split("\n")[0] ?? "git said nothing";
};

export type { RedAtBase, Proven, Settled };

export interface RunnerOptions {
  readonly budget: BudgetConfig;
  readonly adapters: Readonly<Record<string, WorkerAdapter>>;
  readonly deadlineSeconds?: number;
  readonly integrationBranch?: string;
  /** Only for tests: pretend every project lives here. */
  readonly repoRoot?: string;
  /** The invariant set the tick's doctor runs. Defaults to core's. A caller substitutes
   *  one only to prove the boundary holds — that a check which throws costs its own
   *  result and nothing else. */
  readonly invariants?: readonly Invariant[];
  /** The budget a chore's attempt is given. Defaults to config/roles.yaml's default. */
  readonly choreBudget?: Budget;
}

/** The whole engine, one tick at a time: allocate, run, judge.
 *
 *  Level-triggered on purpose. Every pass reads the record and acts on what is there, so a
 *  missed signal, a crash or a hand edit all heal on the next one. Events would be an
 *  optimisation; the timer is the guarantee. */
export class Runner {
  private readonly foreman: Foreman;
  private readonly examiner: Examiner;
  private readonly engine: Engine;
  /** The record's verbs, one method per transition. `engine` survives beside it only for
   *  `settle()`, which is not a transition anybody invokes. */
  private readonly verbs: Verbs;
  private readonly doctor: Doctor;
  /** One per repository. A workspace holds many projects, and each has its own branches. */
  private readonly treesByRepo = new Map<string, Trees>();
  /** The task merges that conflicted, by task, holding the pair of tips they conflicted
   *  between. A daemon's own memory rather than a table: it is about attempts, not about
   *  the record, and a restarted daemon is entitled to look at the world once more. */
  private readonly conflicted = new Map<number, Conflict>();
  /** config/roles.yaml as read this tick, keyed by its path, good or bad. Cleared at the
   *  top of every tick: an edit to the file is in force on the next one. */
  private rolesByRepo = new Map<string, { ok: true; config: RoleConfig } | { ok: false; why: string }>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: RunnerOptions,
  ) {
    this.foreman = new Foreman(db, opts.adapters, opts.deadlineSeconds ?? 3600, {
      integrationBranch: opts.integrationBranch ?? null,
      repoRoot: opts.repoRoot,
    });
    this.examiner = new Examiner(db);
    this.engine = new Engine(db);
    this.verbs = new Verbs(this.engine);
    this.doctor = new Doctor(db, opts.invariants);
    // A merge is not derivable from the record: a done task with a commit stays done and
    // committed forever, so without this landDoneTasks re-merges it on every tick and every
    // log line carries every task that ever landed.
    db.exec(
      `CREATE TABLE IF NOT EXISTS landed_branch (
         task_id   INTEGER PRIMARY KEY,
         branch    TEXT NOT NULL,
         sha       TEXT NOT NULL,
         merged_at TEXT NOT NULL
       )`,
    );
  }

  /** allocate, run, prove, land. The order is the point: a task_test is run in the tree the
   *  attempt wrote in, before that tree is released, and an acceptance_test in the story
   *  tree, after the tasks it depends on have merged. */
  async tick(): Promise<Tick> {
    this.rolesByRepo.clear();
    // First of all, and on the record the last tick left behind: a landing moves the base
    // branch, and everything below reads the base — the run at base, the story trees, the
    // chores' checks. A story delivered on this tick is landed on the next one, so no pass
    // in a tick is ever judged against a base that moved underneath it mid-pass.
    const landing = await this.landDeliveredStories();
    // First of the work, because the point of it is that it happens before the work does.
    const redAtBase = await this.proveRedAtBase();
    // Before anything is handed out, and never after: a paused tick starts nothing at all.
    const paused = this.apiErrorPause();
    const allocated = paused === null ? await this.allocateOne() : this.holdDispatch(paused);
    const foreman = await this.foreman.tick();
    const settled = await this.settleEnded();
    // Level-triggered: a guard that became true for a reason other than the verb that just
    // ran settles here — including the task settleEnded proved, which lands just below.
    const settled2 = this.engine.settle();
    const landings = await this.landDoneTasks();
    const acceptance = await this.storyProvingPass();
    const exhausted = this.enforceRetryLimit();
    // Last, and after settle(): a story becomes delivered in settle(), and the condition
    // this reads is about a story that already is.
    const chores = await this.storyChoresPass(acceptance.behind);
    // Raised first, then performed: a chore created on this tick is dispatched on it, and a
    // chore whose attempt has ended is judged before the tick says what is still owed.
    const performed = await this.performChores(paused);
    // After enforcement, so a task that ran out of attempts on this very tick is already
    // named rather than named a minute later.
    const drift = this.exhaustedTasks();
    // Last, and reading only: the pass describes the record the tick has finished leaving
    // behind. Its own failure is not the tick's — Doctor.check throws for nothing, and the
    // guard here is the belt to that pair of braces.
    let doctor: readonly Violation[] = [];
    try {
      doctor = this.doctor.check();
    } catch {
      // A tick that did its work and could not say whether the record drifted is still a
      // tick that did its work.
    }
    return {
      paused,
      doctor,
      allocated,
      foreman,
      committed: settled.committed,
      merged: landings.merged,
      conflicts: landings.conflicts,
      landed: landing.landed,
      exhausted,
      performed,
      chores: [...chores, ...landing.chores].filter((id) => !performed.done.includes(id)),
      drift,
      redAtBase,
      behind: acceptance.behind,
      waiting: acceptance.waiting,
      settled: settled2.map((c) => `${c.entity} #${c.id} → ${c.to}`),
      scripts: {
        passed: [...settled.scripts.passed, ...acceptance.scripts.passed],
        failed: [...settled.scripts.failed, ...acceptance.scripts.failed],
        skipped: [...settled.scripts.skipped, ...acceptance.scripts.skipped],
        refused: [...(settled.scripts.refused ?? []), ...(acceptance.scripts.refused ?? [])],
      },
    };
  }

  /** Why dispatch is held, or null. Two attempts in a row that ended having reached nothing
   *  — failed, with no session id and no commit — is the model being unreachable, not the
   *  work being hard: the harness exits on an api error before there is a session to name.
   *  A third attempt into that is a crash loop billed by the minute, so nothing is handed
   *  out until one gets through. Level-triggered like everything else here: the pause is
   *  read off the record each tick, and the first attempt that reaches the model ends it.
   *
   *  It ends on its own too, `PAUSE_MS` after the attempt that caused it — otherwise the
   *  only thing that could lift it is an attempt, and the pause stops attempts. One goes
   *  out after the wait; failing the same way puts the pause back for another.
   *
   *  An attempt lost some other way before it started reads the same from the record, and
   *  is counted the same. Two of those in a row is also worth stopping for. */
  private apiErrorPause(): string | null {
    const ended = queries(this.db)
      .selectFrom(tbl.assignment).select(["id", "phase", "session", "commit_sha", "updated_at"]).all()
      .filter((a) => ENDED_PHASES.includes(a.phase)).sort(byId).slice(-UNREACHED);
    if (ended.length < UNREACHED || !ended.every(unreached)) return null;
    const last = Date.parse(ended[ended.length - 1]?.updated_at ?? "");
    if (Number.isNaN(last) || Date.now() - last > PAUSE_MS) return null;
    const which = ended.map((a) => `#${a.id}`).join(" and ");
    return `dispatch is paused: attempts ${which} ended without reaching the model`;
  }

  /** A paused tick's allocation: nothing started, and every task that would have been says
   *  the pause on the board rather than sitting there reading "waiting for a slot". */
  private holdDispatch(why: string): Pass {
    process.stderr.write(`${why}\n`);
    for (const c of readyCandidates(this.db)) recordRefusal(this.db, why, c.id);
    return { created: null, refused: [] };
  }

  /** The allocator chooses; this only places. It is handed a `place` it calls for the one
   *  candidate it picked, so a tree is never cut for a task the pass does not go on to
   *  choose, and the reason a task did not start is always that task's own reason. */
  private async allocateOne(): Promise<Pass> {
    const cut = new Map<number, string>();
    const pass = await allocate(this.db, this.opts.budget, async (c) => {
      const worker = this.freeWorker(c.role);
      if (worker === null) return { why: `no worker free for role ${c.role || "(none)"}` };
      const tree = await this.cutTree(c);
      if (typeof tree !== "string") return tree;
      cut.set(c.id, tree);
      return { worker_id: worker, worktree: tree };
    });

    // What the pass decided, on the record, so the board can say why nothing is running —
    // and so staleness is read from a reason rather than guessed from a timestamp.
    for (const r of pass.refused) {
      if (r.id !== 0) recordRefusal(this.db, r.why, r.id);
    }

    // Everything ready that this pass did not reach. One assignment per tick is deliberate,
    // but a task nobody has looked at should still be able to say how long it has waited.
    const decided = new Set(pass.refused.map((r) => r.id));
    for (const c of readyCandidates(this.db)) {
      if (!decided.has(c.id)) recordRefusal(this.db, "waiting for a slot", c.id);
      decided.add(c.id);
    }
    // A reason must not outlive the tick it was true in. Anything the pass did not speak
    // about this time round — it started, it finished, it is no longer ready — has no
    // current reason, so it must not still be showing yesterday's.
    for (const row of queries(this.db).selectFrom(tbl.refusal).select(["task_id"]).all()) {
      if (!decided.has(row.task_id)) clearRefusal(this.db, row.task_id);
    }
    if (pass.created !== null) {
      const started = queries(this.db).selectFrom(tbl.assignment).select(["objective_id"]).where("id", "=", pass.created).get();
      if (started !== null) clearRefusal(this.db, started.objective_id);
    }
    // A tree cut for a task the allocator then refused is released rather than left behind.
    for (const [id, worktree] of cut) {
      if (pass.created === null || !this.assignmentUses(pass.created, worktree)) {
        const slugs = this.slugsFor(id);
        if (slugs !== null) await this.treesFor(slugs.repo).release(worktree).catch(() => undefined);
      }
    }
    return pass;
  }

  private assignmentUses(assignment: number, worktree: string): boolean {
    const row = queries(this.db).selectFrom(tbl.assignment).select(["worktree"]).where("id", "=", assignment).get();
    return row?.worktree === worktree;
  }

  /** A path, or why there is not one. A tree that could not be cut is a git problem the
   *  operator has to see — it used to be reported as "no worker free". */
  private async cutTree(c: Candidate): Promise<string | { why: string }> {
    const slugs = this.slugsFor(c.id);
    if (slugs === null) return { why: "it has no story: nothing to cut a branch from" };
    try {
      const trees = this.treesFor(slugs.repo);
      const branch = await trees.taskBranch(slugs.story, slugs.task);
      const path = join(this.worktreeRoot(slugs.repo), `${slugs.task}-${Date.now()}`);
      await trees.cut(branch, path);
      return path;
    } catch (err) {
      return { why: (err as Error).message };
    }
  }

  /** A task's slugs and the repository it belongs to. The repo comes from its project, so
   *  one runner serves every project in the workspace. */
  private slugsFor(taskId: number): { task: string; story: string; repo: string } | null {
    const t = queries(this.db).selectFrom(tbl.task).select(["slug", "acceptance_test_id"]).where("id", "=", taskId).get();
    if (t === null) return null;
    const story = this.storyOfTest(t.acceptance_test_id);
    if (story === null) return null;
    const owner = this.projectOf(story);
    if (owner === null) return null;
    return { task: t.slug, story: story.slug, repo: this.opts.repoRoot ?? owner.repo };
  }

  /** The ERD walked one primary key at a time, which is all those seven-way joins were.
   *  A missing link is null, and every caller drops the row — exactly what an inner join
   *  did with it. */
  private storyOfTest(testId: number): StoryRow | null {
    const test = queries(this.db).selectFrom(tbl.test).select(["parent_id"]).where("id", "=", testId).get();
    return test === null ? null : this.storyOfCriteria(test.parent_id);
  }

  private storyOfCriteria(criteriaId: number): StoryRow | null {
    const q = queries(this.db);
    const c = q.selectFrom(tbl.criteria).select(["requirement_id"]).where("id", "=", criteriaId).get();
    if (c === null) return null;
    const r = q.selectFrom(tbl.requirement).select(["story_id"]).where("id", "=", c.requirement_id).get();
    if (r === null) return null;
    return q.selectFrom(tbl.story).where("id", "=", r.story_id).get();
  }

  /** The project a story belongs to, and the repository it names. */
  private projectOf(story: StoryRow): { project: number; repo: string } | null {
    const q = queries(this.db);
    const e = q.selectFrom(tbl.epic).select(["release_id"]).where("id", "=", story.epic_id).get();
    if (e === null) return null;
    const rel = q.selectFrom(tbl.release).select(["project_id"]).where("id", "=", e.release_id).get();
    if (rel === null) return null;
    const p = q.selectFrom(tbl.project).select(["repo"]).where("id", "=", rel.project_id).get();
    if (p === null) return null;
    return { project: rel.project_id, repo: p.repo };
  }

  /** The acceptance_criteria ids under one story: the `requirement → criteria` half of the
   *  join, as a set, so the tests of a story are picked out by membership. */
  private criteriaOfStory(storyId: number): Set<number> {
    const q = queries(this.db);
    const reqs = new Set(q.selectFrom(tbl.requirement).select(["id"]).where("story_id", "=", storyId).all().map((r) => r.id));
    return new Set(
      q.selectFrom(tbl.criteria).all().filter((c) => reqs.has(c.requirement_id)).map((c) => c.id),
    );
  }

  private treesFor(repo: string): Trees {
    const found = this.treesByRepo.get(repo);
    if (found !== undefined) return found;
    const made = new Trees(repo, this.opts.integrationBranch ?? null);
    this.treesByRepo.set(repo, made);
    return made;
  }

  private worktreeRoot(repo: string): string {
    return join(repo, ".wecode", "worktrees");
  }

  /** The free worker of this role that finished longest ago — least recently finished, not
   *  lowest id. Taking the lowest id kept the fleet's first worker in every tree and left the
   *  rest cold, so a fleet was only ever as wide as its busiest member; picking by how long
   *  ago a worker last ended spreads the work, and rotates through the roster on its own.
   *
   *  A worker that has never finished anything has waited longest of all, so it goes first.
   *  Ids break the tie, which is what makes a fleet with no history behave as it used to.
   *
   *  The dialect spells no NOT EXISTS, no ORDER BY and no LIMIT, so the busy set and the
   *  last-finished times are held here and the choice is made in TypeScript. */
  private freeWorker(role: string): number | null {
    const q = queries(this.db);
    const rows = q.selectFrom(tbl.assignment).select(["worker_id", "phase", "updated_at"]).all();
    const busy = new Set(rows.filter((a) => OPEN_PHASES.includes(a.phase)).map((a) => a.worker_id));

    // When a worker last ended an assignment. `updated_at` is stamped on every phase change,
    // so on an ended row it is the moment that attempt stopped being this worker's.
    const finished = new Map<number, string>();
    for (const a of rows) {
      if (!ENDED_PHASES.includes(a.phase)) continue;
      const seen = finished.get(a.worker_id);
      if (seen === undefined || a.updated_at > seen) finished.set(a.worker_id, a.updated_at);
    }

    const free = q.selectFrom(tbl.worker).select(["id"]).where("role", "=", role).all()
      .map((w) => w.id).filter((id) => !busy.has(id));
    if (free.length === 0) return null;

    const idle = (id: number): string => finished.get(id) ?? "";
    return free.reduce((best, id) => (idle(id) < idle(best) || (idle(id) === idle(best) && id < best) ? id : best));
  }

  /** The phase itself lives in `tick/settle.ts` — the pass and the refund rule only it
   *  used. What is left here is what the rest of the runner already owned: the walk up the
   *  ERD to a task's slugs, the trees, and the examiner. */
  private settleEnded(): Promise<Settled> {
    return settleEnded({
      db: this.db,
      slugsFor: (taskId) => this.slugsFor(taskId),
      treesFor: (repo) => this.treesFor(repo),
      runTaskTests: (task, tree, at) => this.examiner.runTaskTests(task, tree, at),
    });
  }

  /** Every task that has used its attempts while its story is still open.
   *
   *  Reported, never acted on: `retry` is an operator's verb, because the machine cannot
   *  know whether a task failed three times for a reason a fourth attempt would fix. So
   *  this is the doctor's read — one line per drift, naming the story that is waiting —
   *  and `wecode task retry <id> --reason` is the only thing that clears it.
   *
   *  A dropped task is not here: abandoning one is a decision, and a decision is not
   *  drift. */
  private exhaustedTasks(): Drift[] {
    // `attempts >= max_retry` compares two columns, which the dialect does not spell —
    // both are read and the comparison is made here.
    const rows = queries(this.db).selectFrom(tbl.task).all()
      .filter((t) => !["done", "dropped"].includes(t.state) && t.attempts >= t.max_retry).sort(byId);

    const drift: Drift[] = [];
    for (const row of rows) {
      const story = this.storyOfTest(row.acceptance_test_id);
      if (story === null || ["delivered", "dropped"].includes(story.state)) continue;
      drift.push({
        task: row.id,
        slug: row.slug,
        story: story.slug,
        why:
          `${row.attempts} of ${row.max_retry} attempts used, and story ${story.slug} is still ` +
          `${story.state} — wecode task retry ${row.id} --reason "…", or drop it`,
      });
    }
    return drift;
  }

  /** A task that has used its attempts stops, and says so. Without this the allocator
   *  retries a broken task forever — a crash loop with the machine holding the stopwatch.
   *
   *  It only ever stops one. The runner has no path back the other way: nothing here
   *  applies `retry`, because bringing an exhausted task back is a judgement about why it
   *  failed, and the machine has not got one. */
  private enforceRetryLimit(): number[] {
    const rows = queries(this.db)
      .selectFrom(tbl.task).select(["id", "attempts", "max_retry"]).where("state", "=", "ready").all()
      .filter((t) => t.attempts >= t.max_retry);

    const stopped: number[] = [];
    for (const row of rows) {
      if (this.verbs.giveUpTask(row.id, "runner").ok) stopped.push(row.id);
    }
    return stopped;
  }

  /** The phase itself lives in `tick/red-at-base.ts`. What is left here is what the rest of
   *  the runner already owned: the walk up the ERD, the trees, and the two rows the run is
   *  written into. */
  private proveRedAtBase(): Promise<RedAtBase> {
    return proveRedAtBase({
      db: this.db,
      repoRoot: this.opts.repoRoot,
      storyOfCriteria: (criteriaId) => this.storyOfCriteria(criteriaId),
      projectOf: (story) => this.projectOf(story),
      treesFor: (repo) => this.treesFor(repo),
      worktreeRoot: (repo) => this.worktreeRoot(repo),
      ranAtBase: (testId, base, artefact) => this.ranAtBase(testId, base, artefact),
      recordBaseRun: (testId, base, artefact, green) => this.recordBaseRun(testId, base, artefact, green),
    });
  }

  /** The same ledger of finished work the verdicts use, under an entity of its own: one run
   *  per test per base sha, so a tick does only the work that is owed. */
  private ranAtBase(testId: number, base: string, artefact: string): boolean {
    const row = queries(this.db)
      .selectFrom(tbl.scriptRun).select(["fingerprint"]).where("entity", "=", BASE_RUN).where("test_id", "=", testId).get();
    return row?.fingerprint === `${base}|${artefact}`;
  }

  /** The observation goes on the test itself, in the columns `test_has_been_red` reads.
   *  It used to go in a runner-owned side table, which left the guard reading a null
   *  column and refusing the pass of a test this machine had watched fail. */
  private recordBaseRun(testId: number, base: string, artefact: string, green: boolean): void {
    const at = now();
    const q = queries(this.db);
    q.update(tbl.test)
      .set({
        red_at_base_sha: green ? null : base,
        red_at_base_at: green ? null : at,
        red_at_base_reason: green ? "it passes at base, so it cannot fail" : null,
        updated_at: at,
      })
      .where("id", "=", testId)
      .run();
    q.insertInto(tbl.scriptRun, {
      entity: BASE_RUN,
      test_id: testId,
      fingerprint: `${base}|${artefact}`,
      ran_at: at,
    })
      .onConflict(["entity", "test_id"], {
        fingerprint: excluded<ScriptRunRow>("fingerprint"),
        ran_at: excluded<ScriptRunRow>("ran_at"),
      })
      .run();
  }

  /** The phase itself lives in `tick/prove-stories.ts` — the pass, the refresh of the tree
   *  it judges in, and the mid-merge read that refresh needs. What is left here is what the
   *  rest of the runner already owned: the walk up the ERD, the trees, the two ancestry
   *  questions, and the examiner. */
  private storyProvingPass(): Promise<Proven> {
    return proveStories({
      db: this.db,
      repoRoot: this.opts.repoRoot,
      storyOfCriteria: (criteriaId) => this.storyOfCriteria(criteriaId),
      projectOf: (story) => this.projectOf(story),
      treesFor: (repo) => this.treesFor(repo),
      worktreeRoot: (repo) => this.worktreeRoot(repo),
      hasCommit: (repo, ref) => refresh.hasCommit(repo, ref),
      contains: (repo, branch, ref) => refresh.contains(repo, branch, ref),
      runAcceptanceTests: (story, tree) => this.examiner.runAcceptanceTests(story, tree),
    });
  }

  /** Both chore phases live in `tick/story-chores.ts` — raising the `refresh` and `merge`
   *  rules, and performing what is owed. What is left here is what the rest of the runner
   *  already owned: the walk up the ERD, the trees, the graph reads, the fleet and the
   *  roles file, handed in as this one host rather than copied into the module. */
  private choreHost(): ChoreHost {
    return {
      db: this.db,
      repoRoot: this.opts.repoRoot,
      maxOpen: this.opts.budget.max_open,
      choreBudget: this.opts.choreBudget ?? CHORE_BUDGET,
      projectOf: (story) => this.projectOf(story),
      treesFor: (repo) => this.treesFor(repo),
      worktreeRoot: (repo) => this.worktreeRoot(repo),
      criteriaOfStory: (storyId) => this.criteriaOfStory(storyId),
      freeWorker: (role) => this.freeWorker(role),
      scopeOfRole: (repo, role) => this.scopeOfRole(repo, role),
      hasCommit: (repo, ref) => refresh.hasCommit(repo, ref),
      contains: (repo, branch, ref) => refresh.contains(repo, branch, ref),
      mergesCleanly: (repo, base, branch) => this.mergesCleanly(repo, base, branch),
      orphanedBy: (repo, branch, storyId) => this.orphanedBy(repo, branch, storyId),
    };
  }

  private storyChoresPass(behind: readonly Behind[] = []): Promise<number[]> {
    return raiseStoryChores(this.choreHost(), behind);
  }

  /** docs/design/18. The other half of a chore, in the same module: judge the attempt that
   *  has ended, then hand the next one out. */
  private performChores(paused: string | null = null): Promise<ChorePass> {
    return performChorePass(this.choreHost(), paused);
  }

  /** docs/design/14. A delivered story reaches the base branch without a person merging it.
   *
   *  Rung 1 of the three: the runner attempts the merge inline, and clean is the common case
   *  that costs nothing — nothing on the board, nothing in the chore table, one line in the
   *  tick saying the base moved and as what. `land` printed by hand in one checkout was the
   *  only way a story reached master, so a story delivered on Friday sat there until somebody
   *  remembered it.
   *
   *  When the attempt cannot be made, the chore is the record of it: raised on the refusal
   *  rather than on the condition, because a chore raised for work wecode is about to do
   *  itself is a row that is planned and done in the same tick and tells nobody anything.
   *  What the operator needs on the board is the landing that did *not* happen, with the
   *  reason and the attempts behind it.
   *
   *  Three conditions are silence rather than a landing, and each is a different fact: a
   *  story with no branch has nothing to land, a base that already contains the branch is
   *  landed already — and a branch that will not merge owes a `merge` chore, which the pass
   *  above has just raised. Landing never queues behind itself: it is attempted every tick
   *  and the graph is what says whether it is owed, so nothing here is a timer or a memo. */
  private async landDeliveredStories(): Promise<{ landed: Landed[]; chores: number[] }> {
    const landed: Landed[] = [];
    const chores: number[] = [];

    for (const row of queries(this.db).selectFrom(tbl.story).all().sort(byId)) {
      if (row.state !== "delivered") continue;
      const owner = this.projectOf(row);
      if (owner === null) continue;
      const repo = this.opts.repoRoot ?? owner.repo;
      const base = await this.treesFor(repo)
        .integrationBranch()
        .catch(() => null);
      if (base === null) continue;
      const branch = `story/${row.slug}`;
      if (branch === base || !(await refresh.hasCommit(repo, branch))) continue;
      if (!this.gateHasPermitted(row.id)) continue;

      const raised = choreFor(this.db, "land", "story", row.id);
      if (await isLanded(repo, base, branch)) {
        // The other half of the same rule. The story is in the base, so nothing is owed, and
        // a chore still open for it is a stale claim rather than work.
        if (raised !== null && raised.state !== "done") {
          closeChore(this.db, raised.id, `${base} already contains ${branch}`, "runner");
        }
        continue;
      }
      if (!(await this.mergesCleanly(repo, base, branch))) continue;

      // An attempt is a `begin` on the record, so a chore that has used its attempts is not
      // attempted again behind the board's back: it stays there saying so.
      if (raised !== null && !beginLandChore(this.db, raised.id)) {
        chores.push(raised.id);
        continue;
      }
      // Read before the merge: the landing moves the ref, and the tip it moved *from* is
      // what says whether the operator's checkout is merely stale or holds work of theirs.
      const wasAt = await refresh.tipOf(repo, `refs/heads/${base}`);
      const attempt = await attemptLanding({
        repo,
        base,
        branch,
        tree: join(this.worktreeRoot(repo), `land-${row.slug}`),
      });
      if (attempt.kind === "landed") {
        // The ref moved in a tree of wecode's own, so the folder the operator works in is
        // still showing the pre-land files. Bringing it forward, or saying the command
        // that will, is part of the landing — not an extra nobody runs.
        const notice =
          wasAt === null
            ? null
            : await this.treesFor(repo)
                .syncPrimaryCheckout(base, wasAt, attempt.sha)
                .catch((err: unknown) => `${base} moved, and ${repo} could not be brought forward: ${String(err)}`);
        landed.push(notice === null ? { story: row.id, sha: attempt.sha } : { story: row.id, sha: attempt.sha, notice });
        // Proved, not reported: the chore is finished because the base contains the branch
        // when this asks the graph, never because the merge exited zero.
        if (raised !== null && (await isLanded(repo, base, branch))) {
          applyChore(this.db, raised.id, "finish", "runner");
        }
        continue;
      }
      if (attempt.kind === "nothing") continue;

      const chore =
        raised ??
        ensureChore(this.db, {
          project_id: owner.project,
          kind: "land",
          target_type: "story",
          target_id: row.id,
          check: LAND_CHECK,
        });
      // The first refusal raises the chore and is itself its first attempt, so the board
      // reads `attempt 2 of 3` on the tick after — the count is of landings tried, and one
      // has been.
      if (raised === null) beginLandChore(this.db, chore.id);
      if (applyChore(this.db, chore.id, "fail", "runner").ok) recordChoreRefusal(this.db, attempt.why, chore.id);
      chores.push(chore.id);
    }
    return { landed, chores };
  }

  /** Has the gate already permitted this merge?
   *
   *  The invariant behind the unattended landing is that wecode performs the merges the gate
   *  permits — not that it merges whatever is called delivered. The gate's word is the
   *  acceptance tests: every one under the story passed, and there is at least one. A story
   *  with none proves nothing, which is 19's own language for it, and landing it unattended
   *  would put work in the base that nothing ever judged.
   *
   *  `dropped` tests are left out rather than counted against it: an abandoned test is a
   *  decision somebody made, and the criterion it hung off is the thing that has to be
   *  satisfied some other way. A story where every test is dropped therefore has none that
   *  passed, and does not land. */
  private gateHasPermitted(storyId: number): boolean {
    const under = this.criteriaOfStory(storyId);
    const tests = queries(this.db)
      .selectFrom(tbl.test).select(["id", "parent_id", "state"]).all()
      .filter((t) => under.has(t.parent_id) && t.state !== "dropped");
    return tests.length > 0 && tests.every((t) => t.state === "passed");
  }

  /** The trial merge, for the phase that raises a `merge` chore by it and for the landing
   *  that only attempts one it says is clean. */
  private mergesCleanly(repo: string, base: string, branch: string): Promise<boolean> {
    return refresh.mergesCleanly(repo, base, branch);
  }

  /** What a refresh has thrown away. The read itself is `tick/refresh.ts`'s, and the walk
   *  to the attempt commits the ledger recorded is `tick/story-chores.ts`'s; what is the
   *  runner's is the story the two are asked about. */
  private orphanedBy(repo: string, branch: string, storyId: number): Promise<string | null> {
    return refresh.orphanedBy(repo, branch, landedAttempts(this.db, this.criteriaOfStory(storyId)));
  }

  /** The role's scope, out of the file that declares it. Never a literal here: docs/design/18
   *  declares what `system` may write in config/roles.yaml, and a copy in this file is a
   *  second definition that nothing checks against the first.
   *
   *  Read from the project's own config, not from a table: nothing fills `role`, so a
   *  lookup there refused every chore in every workspace while the file said `write: **`.
   *  The two refusals are kept apart because the operator's next move differs — a role
   *  absent from the file is a line to add, an unreadable file is a file to fix. */
  private scopeOfRole(repo: string, role: string): { ok: true; scope: Scope } | { ok: false; why: string } {
    const loaded = this.rolesOf(repo);
    if (!loaded.ok) return loaded;
    const def = loaded.config.roles[role];
    if (def === undefined) return { ok: false, why: `no role ${role} in ${ROLES_FILE}` };
    return { ok: true, scope: def.scope };
  }

  /** One read per repository per tick. A tick dispatches every planned chore, and six of
   *  them targeting one project is one read of the file, not six. */
  private rolesOf(repo: string): { ok: true; config: RoleConfig } | { ok: false; why: string } {
    const path = join(repo, ROLES_FILE);
    const cached = this.rolesByRepo.get(path);
    if (cached !== undefined) return cached;
    let read: { ok: true; config: RoleConfig } | { ok: false; why: string };
    try {
      read = { ok: true, config: loadRoles(path) };
    } catch (err) {
      read = { ok: false, why: `cannot read ${ROLES_FILE}: ${(err as Error).message}` };
    }
    this.rolesByRepo.set(path, read);
    return read;
  }

  /** A task whose tests passed lands on its story branch — once. The merge is recorded
   *  against the branch tip it merged, so a branch that grows a commit afterwards lands
   *  again and one that has not is left alone.
   *
   *  A merge that conflicts is reported rather than swallowed, and remembered by the pair
   *  of tips it was attempted between: two branches that have not moved conflict the same
   *  way every tick, so the merge is not run again until one of them does. The conflict is
   *  still named on every tick it is true for — it is a claim about the world now, not a
   *  memo about the tick it first appeared on. */
  private async landDoneTasks(): Promise<{ merged: number[]; conflicts: Conflict[] }> {
    const q = queries(this.db);
    const committed = new Set(
      q
        .selectFrom(tbl.assignment)
        .select(["objective_id"])
        .where("objective_type", "=", "task")
        .where("commit_sha", "!=", null)
        .all()
        .map((a) => a.objective_id),
    );
    const rows = q
      .selectFrom(tbl.task)
      .select(["id"])
      .where("state", "=", "done")
      .all()
      .filter((t) => committed.has(t.id));

    const merged: number[] = [];
    const conflicts: Conflict[] = [];
    for (const row of rows) {
      const slugs = this.slugsFor(row.id);
      if (slugs === null) continue;
      const branch = `task/${slugs.task}`;
      const story = `story/${slugs.story}`;
      const tip = await refresh.tipOf(slugs.repo, branch);
      if (this.alreadyLanded(row.id, branch, tip)) continue;
      // Neither branch has moved since the conflict, so git would say the same thing again
      // and take a worktree and a merge to say it. The remembered sentence is that answer.
      const stale = this.conflicted.get(row.id);
      if (stale !== undefined) {
        if (stale.tips === (await this.tipsOf(slugs.repo, tip, story))) {
          conflicts.push(stale);
          continue;
        }
        this.conflicted.delete(row.id);
      }
      try {
        await this.treesFor(slugs.repo).mergeTaskIntoStory(
          branch,
          slugs.story,
          join(this.worktreeRoot(slugs.repo), `story-${slugs.story}`),
        );
        q.insertInto(tbl.landed, { task_id: row.id, branch, sha: tip ?? "", merged_at: now() })
          .onConflict(["task_id"], {
            branch: excluded<LandedRow>("branch"),
            sha: excluded<LandedRow>("sha"),
            merged_at: excluded<LandedRow>("merged_at"),
          })
          .run();
        merged.push(row.id);
      } catch (err) {
        // The merge nobody can make deterministically. Not landed, so nothing is recorded
        // against `landed_branch`; named here, so it is not a silence.
        const seen: Conflict = {
          task: row.id,
          branch,
          story,
          why: reasonOf(err),
          tips: await this.tipsOf(slugs.repo, tip, story),
        };
        this.conflicted.set(row.id, seen);
        conflicts.push(seen);
      }
    }
    return { merged, conflicts };
  }

  /** The pair of tips a task merge stands between, as one comparable string. A ref that is
   *  not there is the empty half — a world that has not moved either. */
  private async tipsOf(repo: string, tip: string | null, story: string): Promise<string> {
    return `${tip ?? ""}|${(await refresh.tipOf(repo, story)) ?? ""}`;
  }

  /** A tip we could not read is no proof, so the merge is attempted; git itself refuses a
   *  second merge of an unchanged branch, and that refusal stays the backstop. */
  private alreadyLanded(taskId: number, branch: string, tip: string | null): boolean {
    if (tip === null) return false;
    const row = queries(this.db).selectFrom(tbl.landed).select(["branch", "sha"]).where("task_id", "=", taskId).get();
    return row?.branch === branch && row.sha === tip;
  }

}

/** Wake on a timer, forever, until something says stop. */
export async function loop(
  runner: Runner,
  everyMs: number,
  stop: AbortSignal,
  onTick: (t: Tick) => void = () => {},
): Promise<void> {
  while (!stop.aborted) {
    try {
      onTick(await runner.tick());
    } catch (err) {
      process.stderr.write(`tick failed: ${(err as Error).message}\n`);
    }
    await sleep(everyMs, stop);
  }
}

const sleep = (ms: number, stop: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    stop.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
