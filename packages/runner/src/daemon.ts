import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  applyChore,
  choreAttempts,
  choreById,
  CHORE_KIND_DEFS,
  performedByTheRunner,
  clearChoreRefusal,
  clearRefusal,
  choreFor,
  choreRefusal,
  closeChore,
  Engine,
  ensureChore,
  loadRoles,
  Maker,
  now,
  recordChoreRefusal,
  recordRefusal,
  reraiseChore,
  Verbs,
  type Budget,
  type Chore,
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

interface StoryRow {
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

const tbl = {
  task: table<TaskRow>("task", ["id", "slug", "acceptance_test_id", "attempts", "max_retry", "state"]),
  assignment: table<AssignmentRow>("assignment", [
    "id",
    "objective_type",
    "objective_id",
    "worker_id",
    "worktree",
    "phase",
    "commit_sha",
    "updated_at",
  ]),
  test: table<TestRow>("acceptance_test", [
    "id",
    "parent_id",
    "kind",
    "artefact",
    "state",
    "red_at_base_sha",
    "red_at_base_at",
    "red_at_base_reason",
    "updated_at",
  ]),
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
const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];
const ENDED_PHASES: readonly string[] = ["succeeded", "failed"];

const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

export interface Tick {
  readonly allocated: Pass;
  readonly foreman: TickReport;
  readonly scripts: ScriptReport;
  readonly committed: readonly number[];
  readonly merged: readonly number[];
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
 *  with story 152, and re-proving could never help because the tree was wrong rather than
 *  the code. So a story that is behind is named and nothing under it is judged — a red
 *  verdict out of a stale tree is a lie, and it costs the next attempt its whole budget. */
export interface Behind {
  readonly story: number;
  readonly why: string;
}

/** A story whose judgement is owed to a repair wecode has already asked for, and which
 *  repair that is.
 *
 *  Live proof, 15 Sep: chore 4, kind `refresh`, target story 165, was running when
 *  acceptance_test 166 was judged at 21:14 and went red on the same stale-tree loadViews
 *  error; the chore then finished, the branch gained the base, and the test passed at 21:17
 *  untouched. The red verdict was noise from a race against a repair the tick itself had
 *  raised — so while that repair is open the story is not judged, and the operator reads
 *  "waiting on its refresh" instead of a failure that was never about the code. */
export interface Waiting {
  readonly story: number;
  readonly why: string;
}

/** A `refresh` chore in these states is one nobody has discharged yet: raised and unstarted,
 *  queued, or with a worker in the tree right now. `done` and `failed` are both settled —
 *  the repair has had its pass, and the story is judged as it stands. */
const REFRESH_OPEN = ["planned", "ready", "running"];

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
const reasonOf = (err: unknown): string => {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const said = (e.stderr ?? "").trim() || (e.stdout ?? "").trim() || (e.message ?? "").trim();
  return said.split("\n")[0] ?? "git said nothing";
};

export interface RedAtBase {
  readonly proven: readonly number[];
  readonly unproven: readonly number[];
}

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
    const allocated = await this.allocateOne();
    const foreman = await this.foreman.tick();
    const settled = await this.settleEnded();
    const merged = await this.landDoneTasks();
    const acceptance = await this.proveStories();
    // Level-triggered: anything whose guard became true for a reason other than the verb
    // that just ran settles here, rather than waiting for an event that already happened.
    const settled2 = this.engine.settle();
    const exhausted = this.enforceRetryLimit();
    // Last, and after settle(): a story becomes delivered in settle(), and the condition
    // this reads is about a story that already is.
    const chores = await this.raiseStoryChores(acceptance.behind);
    // Raised first, then performed: a chore created on this tick is dispatched on it, and a
    // chore whose attempt has ended is judged before the tick says what is still owed.
    const performed = await this.performChores();
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
      doctor,
      allocated,
      foreman,
      committed: settled.committed,
      merged,
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
      const started = queries(this.db)
        .selectFrom(tbl.assignment)
        .select(["objective_id"])
        .where("id", "=", pass.created)
        .get();
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
      q
        .selectFrom(tbl.criteria)
        .all()
        .filter((c) => reqs.has(c.requirement_id))
        .map((c) => c.id),
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

    const free = q
      .selectFrom(tbl.worker)
      .select(["id"])
      .where("role", "=", role)
      .all()
      .map((w) => w.id)
      .filter((id) => !busy.has(id));
    if (free.length === 0) return null;

    const idle = (id: number): string => finished.get(id) ?? "";
    return free.reduce((best, id) => (idle(id) < idle(best) || (idle(id) === idle(best) && id < best) ? id : best));
  }

  /** An attempt that has ended: commit whatever it wrote onto its task branch, then let the
   *  tree go. The branch is the surviving copy; the directory is a checkout held against a
   *  retry nobody has promised. */
  private async settleEnded(): Promise<{ committed: number[]; scripts: ScriptReport }> {
    const rows = queries(this.db)
      .selectFrom(tbl.assignment)
      .select(["id", "worktree", "objective_id", "phase"])
      .where("objective_type", "=", "task")
      .all()
      .filter((a) => ENDED_PHASES.includes(a.phase) && a.worktree !== "")
      .map((a) => ({ id: a.id, worktree: a.worktree, task: a.objective_id }));

    const committed: number[] = [];
    const passed: number[] = [];
    const failed: number[] = [];
    const skipped: number[] = [];
    const refused: Refused[] = [];

    for (const row of rows) {
      if (!existsSync(row.worktree)) continue;
      const slugs = this.slugsFor(row.task);
      if (slugs === null) continue;
      try {
        // The attempt is judged in the tree it wrote in, before that tree goes.
        // The assignment is what makes this attempt distinct: a retry cuts a fresh tree at
        // the same branch tip, so the tip alone would read as "already judged".
        const r = await this.examiner.runTaskTests(row.task, row.worktree, { attempt: row.id });
        passed.push(...r.passed);
        failed.push(...r.failed);
        skipped.push(...r.skipped);
        refused.push(...(r.refused ?? []));

        const trees = this.treesFor(slugs.repo);
        const sha = await trees.commitAttempt(row.worktree, `task/${slugs.task}`, `${slugs.task}: attempt`);
        if (sha !== null) {
          queries(this.db).update(tbl.assignment).set({ commit_sha: sha }).where("id", "=", row.id).run();
          committed.push(row.id);
        }
        await trees.release(row.worktree);
      } catch {
        // leave the tree standing rather than lose work nobody has seen
      }
    }
    return { committed, scripts: { passed, failed, skipped, refused } };
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
    const rows = queries(this.db)
      .selectFrom(tbl.task)
      .all()
      .filter((t) => !["done", "dropped"].includes(t.state) && t.attempts >= t.max_retry)
      .sort(byId);

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
      .selectFrom(tbl.task)
      .select(["id", "attempts", "max_retry"])
      .where("state", "=", "ready")
      .all()
      .filter((t) => t.attempts >= t.max_retry);

    const stopped: number[] = [];
    for (const row of rows) {
      if (this.verbs.giveUpTask(row.id, "runner").ok) stopped.push(row.id);
    }
    return stopped;
  }

  /** A test nobody has seen fail proves nothing by passing. So each ready acceptance test is
   *  run once at the commit its story was cut from — the merge-base of the story branch and
   *  the integration branch — before any of its tasks has written a line. Red there is the
   *  proof, and is recorded. Green there is a test that cannot fail, and the reason it
   *  proves nothing is recorded against it instead. */
  private async proveRedAtBase(): Promise<RedAtBase> {
    // `artefact IS NOT NULL` and `red_at_base_sha IS NULL` are spelled as comparisons with
    // null, which the dialect compiles to IS / IS NOT rather than to an `= NULL` that never
    // matches. The story's own state is the one condition that needs the walk up the ERD.
    const tests = queries(this.db)
      .selectFrom(tbl.test)
      .select(["id", "artefact", "parent_id"])
      .where("state", "=", "ready")
      .where("kind", "=", "script")
      .where("artefact", "!=", null)
      .where("red_at_base_sha", "=", null)
      .all();

    const rows: { id: number; artefact: string; story: string; repo: string }[] = [];
    for (const test of tests) {
      if (test.artefact === null) continue;
      const story = this.storyOfCriteria(test.parent_id);
      if (story === null || story.state !== "in_progress") continue;
      const owner = this.projectOf(story);
      if (owner === null) continue;
      rows.push({ id: test.id, artefact: test.artefact, story: story.slug, repo: owner.repo });
    }

    const proven: number[] = [];
    const unproven: number[] = [];
    for (const row of rows) {
      const repo = this.opts.repoRoot ?? row.repo;
      try {
        const trees = this.treesFor(repo);
        const tree = await trees.storyTree(row.story, join(this.worktreeRoot(repo), `story-${row.story}`));
        const base = await this.mergeBase(repo, `story/${row.story}`, await trees.integrationBranch());
        if (base === null || this.ranAtBase(row.id, base, row.artefact)) continue;
        const green = await this.runAtBase({ repo, story: row.story, tree, base, artefact: row.artefact });
        this.recordBaseRun(row.id, base, row.artefact, green);
        (green ? unproven : proven).push(row.id);
      } catch {
        // no branch, or no tree to be had: there is no base to prove anything against yet
      }
    }
    return { proven, unproven };
  }

  private async mergeBase(repo: string, a: string, b: string): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["merge-base", a, b], { cwd: repo });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** The same ledger of finished work the verdicts use, under an entity of its own: one run
   *  per test per base sha, so a tick does only the work that is owed. */
  private ranAtBase(testId: number, base: string, artefact: string): boolean {
    const row = queries(this.db)
      .selectFrom(tbl.scriptRun)
      .select(["fingerprint"])
      .where("entity", "=", BASE_RUN)
      .where("test_id", "=", testId)
      .get();
    return row?.fingerprint === `${base}|${artefact}`;
  }

  /** True when the artefact passed at base. The story tree is put back on its branch either
   *  way: the merge and the ordinary prove-the-story pass both expect to find it there. */
  private async runAtBase(at: {
    repo: string;
    story: string;
    tree: string;
    base: string;
    artefact: string;
  }): Promise<boolean> {
    await exec("git", ["checkout", "--detach", "-q", at.base], { cwd: at.tree });
    await exec("git", ["reset", "--hard", "-q", at.base], { cwd: at.tree });
    try {
      await exec("bash", ["-lc", at.artefact], {
        cwd: at.tree,
        timeout: 10 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return true;
    } catch {
      return false;
    } finally {
      await this.treesFor(at.repo).storyTree(at.story, at.tree);
    }
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

  /** Acceptance tests, in the story tree, once the story's tasks are finished — and never
   *  before that tree has what the base has, nor while the repair that gives it the base is
   *  still open. See `Waiting`. */
  private async proveStories(): Promise<{
    readonly scripts: ScriptReport;
    readonly behind: readonly Behind[];
    readonly waiting: readonly Waiting[];
  }> {
    // DISTINCT has no spelling in the dialect and needs none: the stories are collected
    // into a Map keyed by id, which is what DISTINCT was for.
    const found = new Map<number, { id: number; slug: string; repo: string }>();
    for (const test of queries(this.db).selectFrom(tbl.test).select(["parent_id", "state"]).where("kind", "=", "script").all()) {
      if (!["ready", "failed"].includes(test.state)) continue;
      const story = this.storyOfCriteria(test.parent_id);
      if (story === null || story.state !== "in_progress" || found.has(story.id)) continue;
      const owner = this.projectOf(story);
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
      const repair = choreFor(this.db, "refresh", "story", story.id);
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
        const repo = this.opts.repoRoot ?? story.repo;
        const tree = await this.treesFor(repo).storyTree(story.slug, join(this.worktreeRoot(repo), `story-${story.slug}`));
        const fresh = await this.refreshStoryTree(story.slug, repo, tree);
        if (!fresh.ok) {
          // Nothing is judged here, and nothing is recorded against the tests: they stay
          // exactly as they were, and the tick says why instead.
          behind.push({ story: story.id, why: fresh.why });
          continue;
        }
        const r = await this.examiner.runAcceptanceTests(story.id, tree);
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
  private async refreshStoryTree(
    slug: string,
    repo: string,
    tree: string,
  ): Promise<{ ok: true } | { ok: false; why: string }> {
    const branch = `story/${slug}`;
    let base: string;
    try {
      base = await this.treesFor(repo).integrationBranch();
    } catch (err) {
      return { ok: false, why: (err as Error).message };
    }
    // A repository whose base has no commit yet, or a story cut on the base itself, has
    // nothing to be behind.
    if (branch === base || !(await this.hasCommit(repo, base))) return { ok: true };
    if (await this.contains(repo, branch, base)) return { ok: true };

    try {
      await exec(
        "git",
        [
          "-c",
          "user.name=wecode",
          "-c",
          "user.email=wecode@localhost",
          "merge",
          "--no-ff",
          "-q",
          "-m",
          `refresh ${branch} from ${base}`,
          base,
        ],
        { cwd: tree },
      );
    } catch (err) {
      // Leave no half-merge standing: the next tick, and the chore's worker, both want the
      // branch as it was. Whether that worked is read back off the tree rather than off the
      // abort's exit code — `merge --abort` also fails when there was no merge to abort, and
      // that tree is not wedged. A tree still holding MERGE_HEAD is, and then the sentence
      // has to say so: a wedged tree is what the next tick and the chore's worker will find,
      // and a silent abort left them to discover it.
      await exec("git", ["merge", "--abort"], { cwd: tree }).catch(() => undefined);
      const wedged = await this.midMerge(tree);
      const after = wedged
        ? `and the merge would not abort: ${tree} is left mid-merge and wants a person`
        : "no merge is left standing: the tree is as it was";
      return {
        ok: false,
        why: `${branch} is behind ${base} and will not take it: ${reasonOf(err)} — ${after}`,
      };
    }
    if (!(await this.contains(repo, branch, base))) {
      return { ok: false, why: `${branch} still does not contain ${base} after the merge` };
    }
    return { ok: true };
  }

  /** Is this tree still in the middle of a merge? `MERGE_HEAD` is git's own record of it,
   *  and it survives an abort that could not run. */
  private async midMerge(tree: string): Promise<boolean> {
    return await exec("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: tree })
      .then(() => true)
      .catch(() => false);
  }

  private async hasCommit(repo: string, ref: string): Promise<boolean> {
    return await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo })
      .then(() => true)
      .catch(() => false);
  }

  /** docs/design/18. A story's branch will not merge into the base, or its tree will not
   *  take the base. Either way wecode owes itself the merge nobody can make deterministically.
   *
   *  Until now that was a sentence in a report: the merge in `landDoneTasks` swallowed the
   *  conflict, and a delivered story that could not be landed looked exactly like one that
   *  had been. Four of them sat that way for a day. A chore is the record of it — on the
   *  board, with a target and a check, and takeable by a worker.
   *
   *  Every story with work under it is read, not only a delivered one, because `refresh`
   *  is owed while the work is in flight and not after it: story 165 was `in_progress`, its
   *  tree was a story behind the base, and because this read only `delivered` nothing was
   *  raised — so the same acceptance test was re-proved in the same wrong tree, with nothing
   *  on the board to say why. `planned` is left out because a story nobody has started has
   *  no branch, and `dropped` because nothing is owed on it.
   *
   *  `merge` stays a delivered story's alone. A branch in flight is expected to diverge from
   *  the base, and that divergence is neither owed nor anybody's to fix until the story is
   *  finished; raising it early is a chore on every board in the workspace. `refresh` is the
   *  opposite case and that is why it is a second kind rather than a widened first: it is
   *  about the tree wecode is judging in right now.
   *
   *  "With work under it" is not a second clause in the query, because the branch is already
   *  the answer: `mergesCleanly` says yes to a ref that is not there, and a story with
   *  nothing under it has no branch, so it raises nothing without being asked separately.
   *
   *  This runs every tick and creates nothing on the second one: `ensureChore` is keyed on
   *  (kind, target), which is the condition itself.
   *
   *  Level-triggered in both directions. The condition is re-read every tick and the chore
   *  follows it: true again re-raises a chore that had settled, false closes one that had
   *  not. Neither is a timer and neither is a guess — this reads the branch against the base
   *  before it says either. */
  private async raiseStoryChores(behind: readonly Behind[] = []): Promise<number[]> {
    const stories: { id: number; slug: string; project: number; repo: string; state: string }[] = [];
    for (const row of queries(this.db).selectFrom(tbl.story).all().sort(byId)) {
      if (!["in_progress", "on_hold", "delivered"].includes(row.state)) continue;
      const owner = this.projectOf(row);
      if (owner === null) continue;
      stories.push({ id: row.id, slug: row.slug, state: row.state, project: owner.project, repo: owner.repo });
    }

    const open: number[] = [];
    for (const story of stories) {
      const repo = this.opts.repoRoot ?? story.repo;
      const base = await this.treesFor(repo)
        .integrationBranch()
        .catch(() => null);
      if (base === null) continue;
      const branch = `story/${story.slug}`;
      // `refresh` is about the tree wecode is judging in right now, and that is an
      // in_progress story's: only that story raises one. But a chore already on the board is
      // a claim about the branch, not about the story's state, so its check is re-read on
      // every tick whatever state the story has moved to — see `followRefresh`.
      open.push(...(await this.followRefresh(story, repo, branch, base, behind)));
      if (story.state !== "delivered") continue;
      if (await this.mergesCleanly(repo, base, branch)) {
        // The other half of the same rule. The conflict is gone, so an open chore for it is
        // a stale claim, and the row should say the world moved rather than sit in `failed`
        // being refused every tick.
        //
        // Unless the merge itself has been made — then the world did not move, a chore's
        // attempt did, and the chore's own check is what judges it. `merge` proves two
        // things and only one of them is the conflict; a story whose branch swallowed the
        // base and went red is drift to keep on the board, not a chore to close.
        const stale = choreFor(this.db, "merge", "story", story.id);
        if (stale !== null && !(await this.contains(repo, branch, base))) {
          closeChore(this.db, stale.id, `${branch} no longer conflicts with ${base}`, "runner");
        }
        continue;
      }

      const chore = ensureChore(this.db, {
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
   *  question `refreshStoryTree` asks, asked again here rather than inherited from what the
   *  proving pass happened to report. That is the whole point of the change: `proveStories`
   *  looks only at an in_progress story with a ready or failed *script* acceptance test, so
   *  an in_progress story whose tests are not scripts yet, or has none written, was invisible
   *  to it and nothing was ever raised about a tree that was plainly behind. The graph knows
   *  about all of them.
   *
   *  It also means the two can no longer disagree in the other direction. A story
   *  `proveStories` skipped because this very chore is open used to need a `waiting` list to
   *  stop the skip reading as "the tree took the base"; now the branch answers that itself,
   *  and it says no, so the chore stays raised without being told.
   *
   *  `behind` is still taken, for one thing only: when the proving pass did try the merge,
   *  its conflict is the better sentence to record against the chore than "does not contain".
   *  It never decides whether the chore is owed.
   *
   *  Raising is an in_progress story's alone, but re-reading is not. A story that moves to
   *  `on_hold` or `delivered` with a `failed` refresh chore on it used to take that chore
   *  out of reach of the only pass that ever revisits it: the branch could take the base an
   *  hour later and the row would still be `failed`, refusing a tree that is fine, for good.
   *  So the check is re-read whatever state the story is in, and a chore whose condition has
   *  cleared is closed. A story that cannot raise one also cannot have one re-raised here —
   *  when it is still behind, an existing chore is left exactly as it stands, and not
   *  dispatched, because nothing is being proved in that tree. */
  private async followRefresh(
    story: { id: number; slug: string; project: number; state: string },
    repo: string,
    branch: string,
    base: string,
    behind: readonly Behind[],
  ): Promise<number[]> {
    const chore = choreFor(this.db, "refresh", "story", story.id);
    if (!(await this.isBehind(repo, branch, base))) {
      // Up to date is not the same as repaired. A branch reset onto the base contains it by
      // construction, so this test alone blesses the one refresh that must never be blessed:
      // the one that threw the story's own work away to make the check true. Closing here
      // would then overwrite the `failed` verdict `proveChore` gave it, and the orphaned
      // commits would be nowhere on the board. So the chore stays exactly where it is, still
      // owed, with the loss recorded against it.
      const orphaned = await this.orphanedBy(repo, branch, story.id);
      if (orphaned !== null) {
        if (chore === null) return [];
        if (chore.state !== "running") recordChoreRefusal(this.db, orphaned, chore.id);
        return chore.state === "done" ? [] : [chore.id];
      }
      // The world moved: the branch took the base, so what was owed is not owed any more.
      // `running` is left alone — a worker is in the tree on it, and the verdict is that
      // attempt's to give.
      if (chore !== null && chore.state !== "running") {
        closeChore(this.db, chore.id, `${branch} is up to date with ${base}`, "runner");
      }
      return [];
    }
    // Still behind, and this story is not being proved in. The chore stands as it is.
    if (story.state !== "in_progress") return [];
    const why = behind.find((b) => b.story === story.id)?.why ?? `${branch} does not contain ${base}`;
    const raised = ensureChore(this.db, {
      project_id: story.project,
      kind: "refresh",
      target_type: "story",
      target_id: story.id,
      check: "the base is an ancestor of the branch",
    });
    // One row, two voices, and only one of them is worth an operator's attention.
    //
    // `chore_refusal` holds a single sentence per chore. This one is the note that raised the
    // chore — why the work is owed — and the chore's own existence, kind and check already
    // say that. The dispatcher's and the judge's sentences say the thing the record does not:
    // no worker free, no slot, the tree would not open, the attempt proved nothing. Written
    // unconditionally, this note landed on top of one of those on every tick, which cost two
    // readings at once: the dispatch refusal's `since` and `passes` were reset each pass, so
    // a chore held for half an hour read as first-seen-now; and a `failed` chore out of
    // `max_retry` — the one row nothing ever comes back to rewrite — lost its verdict to
    // "does not contain" for good.
    //
    // So it seeds an empty row and never overwrites. Nothing is lost by that: the row is
    // empty on the first raise, and `reraiseChore` clears it whenever the condition comes
    // back, which is the only other moment this note is the newest thing known.
    if (choreRefusal(this.db, raised.id) === null) recordChoreRefusal(this.db, why, raised.id);
    return raised.state === "done" ? [] : [raised.id];
  }

  /** Is this story's branch missing the base? Two things are not being behind rather than
   *  being behind: a story cut on the base itself, and a branch that is not there at all —
   *  a story nobody has started owes no merge, and asking git about a missing ref would
   *  answer "no, it does not contain the base" and raise a chore with no tree to do it in. */
  private async isBehind(repo: string, branch: string, base: string): Promise<boolean> {
    if (branch === base) return false;
    if (!(await this.hasCommit(repo, base)) || !(await this.hasCommit(repo, branch))) return false;
    return !(await this.contains(repo, branch, base));
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
      if (branch === base || !(await this.hasCommit(repo, branch))) continue;
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
      if (raised !== null && !this.beginLandChore(raised.id)) {
        chores.push(raised.id);
        continue;
      }
      // Read before the merge: the landing moves the ref, and the tip it moved *from* is
      // what says whether the operator's checkout is merely stale or holds work of theirs.
      const wasAt = await this.tipOf(repo, `refs/heads/${base}`);
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
      if (raised === null) this.beginLandChore(chore.id);
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
      .selectFrom(tbl.test)
      .select(["id", "parent_id", "state"])
      .all()
      .filter((t) => under.has(t.parent_id) && t.state !== "dropped");
    return tests.length > 0 && tests.every((t) => t.state === "passed");
  }

  /** Bring a `land` chore to `running` for this tick's attempt, or say there is not one to
   *  be had. `reraiseChore` is the ceiling: it refuses a chore that has used its attempts,
   *  and that refusal is what stops the runner retrying a landing for ever. */
  private beginLandChore(id: number): boolean {
    const found = choreById(this.db, id);
    if (found === null) return false;
    if ((found.state === "failed" || found.state === "done") && !reraiseChore(this.db, id, "runner").ok) return false;
    const planned = choreById(this.db, id);
    if (planned?.state === "planned" && !applyChore(this.db, id, "start", "runner").ok) return false;
    const ready = choreById(this.db, id);
    if (ready?.state === "running") return true;
    return applyChore(this.db, id, "begin", "runner").ok;
  }

  /** docs/design/18. The other half of a chore: judge the attempt that has ended, then hand
   *  the next one out.
   *
   *  Judging first is what makes the slot free again within the tick, and what stops an
   *  agent's word being the record: a chore is done because the runner proved the check,
   *  never because the session exited zero. */
  private async performChores(): Promise<ChorePass> {
    const done: number[] = [];
    const failed: { id: number; why: string }[] = [];
    const dispatched: number[] = [];

    for (const row of this.endedChoreAttempts()) {
      const chore = choreById(this.db, row.chore);
      // Only an attempt of a chore still in hand is judged. A chore already done or already
      // failed has a verdict, and the ended assignment beside it is only history.
      if (chore === null || chore.state !== "running") continue;
      const proved = await this.proveChore(chore);
      if (proved.ok) {
        if (applyChore(this.db, chore.id, "finish", "runner").ok) done.push(chore.id);
      } else if (applyChore(this.db, chore.id, "fail", "runner").ok) {
        // The verdict is written to the chore, not only reported in the pass. `fail` clears
        // whatever the last tick said about this chore, and the pass is a log line that
        // scrolls, so without this a failed chore sits on the board saying nothing at all —
        // and the one that has used its attempts sits there for good, never raised again and
        // never explained. Recorded after the verb, so the reason is the one this tick read.
        recordChoreRefusal(this.db, proved.why, chore.id);
        failed.push({ id: chore.id, why: proved.why });
      }
    }

    for (const row of this.dispatchableChores()) {
      const chore = choreById(this.db, row.id);
      if (chore === null) continue;
      const id = await this.dispatchChore(chore);
      if (id !== null) dispatched.push(chore.id);
    }
    return { dispatched, done, failed };
  }

  private endedChoreAttempts(): { id: number; chore: number; worktree: string }[] {
    return queries(this.db)
      .selectFrom(tbl.assignment)
      .select(["id", "objective_id", "worktree", "phase"])
      .where("objective_type", "=", "chore")
      .all()
      .filter((a) => ENDED_PHASES.includes(a.phase))
      .sort(byId)
      .map((a) => ({ id: a.id, chore: a.objective_id, worktree: a.worktree }));
  }

  /** Chores with nothing already attempting them. The guard matters: without it a chore
   *  whose `begin` did not land is handed out again next tick while its first assignment
   *  is still running, and then two workers are in one tree. */
  private dispatchableChores(): { id: number }[] {
    const q = queries(this.db);
    const attempting = new Set(
      q
        .selectFrom(tbl.assignment)
        .select(["objective_type", "objective_id", "phase"])
        .where("objective_type", "=", "chore")
        .all()
        .filter((a) => OPEN_PHASES.includes(a.phase))
        .map((a) => a.objective_id),
    );
    // A kind wecode performs itself is never handed to a worker. `land` is one: its merge
    // is into the base branch, and the only tree an agent may be dispatched into is the
    // story tree, where that merge cannot be made at all. `landDeliveredStories` is where
    // its attempts happen, and the reason it is still open is already on its own row.
    return q
      .selectFrom(tbl.chore)
      .all()
      .filter((c) => ["planned", "ready"].includes(c.state) && !attempting.has(c.id))
      .filter((c) => !performedByTheRunner(c.kind))
      .sort(byId)
      .map((c) => ({ id: c.id }));
  }

  /** The attempt: a system worker, in a tree at the chore's target branch, with the role's
   *  own scope off the record.
   *
   *  Every refusal here is level-triggered — no worker free, no slot, no role on the record
   *  — because none of them is the chore's fault and all of them heal on a later tick. None
   *  of them is silent: a chore that sits in `planned` for half an hour is only readable if
   *  it says which of these is holding it, so each one is written to `chore_refusal` in the
   *  same voice a task's refusal uses, and cleared the moment the chore is dispatched. What
   *  is decided here is unchanged — only what is recorded about it.
   *
   *  The chore is left where it was and stays on the board: a `planned` chore is only
   *  started once there is somewhere for it to go, so "created, shown, and taken by nobody"
   *  still reads as planned rather than as ready forever. */
  private async dispatchChore(chore: Chore): Promise<number | null> {
    const def = CHORE_KIND_DEFS[chore.kind];
    if (def === undefined) return this.refuseChore(chore, `no kind on the record for a ${chore.kind} chore`);
    const target = this.storyTargetOf(chore);
    if (target === null) return this.refuseChore(chore, "the story it targets is gone");
    const scope = this.scopeOfRole(target.repo, def.role);
    if (!scope.ok) return this.refuseChore(chore, scope.why);
    const open = this.openAssignments();
    const max = this.opts.budget.max_open;
    if (open >= max) return this.refuseChore(chore, `${max - open} of ${max} slots are open`);
    const worker = this.freeWorker(def.role);
    if (worker === null) return this.refuseChore(chore, `no worker free for role ${def.role}`);

    try {
      const trees = this.treesFor(target.repo);
      const branch = `story/${target.slug}`;
      // The one thing a chore may never be given: a tree on the base branch. A merge made
      // there is a landing, and landing is the operator's verb.
      if (branch === (await trees.integrationBranch())) {
        return this.refuseChore(chore, `${branch} is the base branch: landing is yours to do, not a chore's`);
      }
      const tree = await trees.storyTree(target.slug, join(this.worktreeRoot(target.repo), `story-${target.slug}`));
      // The approval guard lives in `start`, so a kind that needs one refuses here and
      // nothing is created for it.
      if (chore.state === "planned") {
        const started = applyChore(this.db, chore.id, "start", "runner");
        if (!started.ok) return this.refuseChore(chore, started.why);
      }
      const id = new Maker(this.db).assignment({
        objective_type: "chore" as "task",
        objective_id: chore.id,
        worker_id: worker,
        scope: scope.scope,
        budget: this.opts.choreBudget ?? CHORE_BUDGET,
        worktree: tree,
      });
      // Dispatched: the assignment exists, so whatever was holding it a tick ago is no
      // longer true of it. Cleared here rather than after `begin`, because every way out
      // from this line on is a way out with an assignment open — and a chore being
      // attempted must never also be showing a reason it is not.
      clearChoreRefusal(this.db, chore.id);
      const begun = applyChore(this.db, chore.id, "begin", `worker-${worker}`);
      if (!begun.ok) return this.refuseChore(chore, begun.why);
      return id;
    } catch (err) {
      // No branch, or no tree to be had. Which one it was is git's to say: the fixed
      // "no branch to merge into yet" read identically whether the branch was missing, the
      // worktree path was occupied by a file, or the index was locked, and the operator had
      // to go to the tree themselves to find out. Report what was actually caught.
      return this.refuseChore(chore, (err as Error).message);
    }
  }

  /** Write the reason down and hand back the answer dispatchChore already gives. One
   *  statement, so no branch of dispatchChore can record a reason and return the other
   *  thing, or return without recording. */
  private refuseChore(chore: Chore, why: string): null {
    recordChoreRefusal(this.db, why, chore.id);
    return null;
  }

  /** The check, proved by this machine. For `merge`: the base is an ancestor of the branch —
   *  which is the merge having been made, not an agent's report of it — and the suite the
   *  story carries is still green.
   *
   *  `refresh` proves the same two things, so it is the same code and not a copy of it.
   *  docs/design/18 words them from either end — "the branch merges cleanly into the base"
   *  and "the base merges into the story branch" — but one graph answers both: once the
   *  base is an ancestor of the branch there is nothing left to conflict. */
  private async proveChore(chore: Chore): Promise<{ ok: true } | { ok: false; why: string }> {
    if (chore.kind === "land") {
      // The landing's check is the mirror of the merge's: the *base* contains the branch.
      // Nothing dispatches a `land` chore, so being asked here at all means an assignment
      // outlived the rule — and the answer is still the graph's, not the assignment's.
      const target = this.storyTargetOf(chore);
      if (target === null) return { ok: false, why: "its target story is not on the record" };
      const branch = `story/${target.slug}`;
      const base = await this.treesFor(target.repo)
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
    const target = this.storyTargetOf(chore);
    if (target === null) return { ok: false, why: "its target story is not on the record" };

    const branch = `story/${target.slug}`;
    try {
      const base = await this.treesFor(target.repo).integrationBranch();
      if (!(await this.contains(target.repo, branch, base))) {
        return { ok: false, why: `${base} is not an ancestor of ${branch}: the merge was not made` };
      }
      // Asked before the suite, because a branch that dropped the work it was carrying is
      // green for the wrong reason: the tests that would have failed went with the commits.
      const orphaned = await this.orphanedBy(target.repo, branch, target.story);
      if (orphaned !== null) return { ok: false, why: `${branch} contains ${base}, but ${orphaned}` };
      const red = await this.suiteRed(target);
      if (red !== null) return { ok: false, why: `${branch} contains ${base}, but the suite is red: ${red}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, why: (err as Error).message };
    }
  }

  /** What a refresh has thrown away, or null when it has thrown nothing away.
   *
   *  A refresh is asked for one thing — put the base into the story branch — and it is
   *  judged by one question, "is the base an ancestor of the branch". `git reset --hard base`
   *  answers that question perfectly and does the opposite of the work: every commit the
   *  story was carrying stops being reachable from its branch, and the check still passes.
   *  So does a rebase that drops a commit, and a force-push of a tree built from the base.
   *  The attempts are still in the object store for a while, and they are nowhere a person
   *  will look; by the time the story's tests are re-run the only evidence is that the work
   *  is gone.
   *
   *  The commits this defends are the ones wecode itself put on the branch: `landed_branch`
   *  records, per task, the task-branch tip that `landDoneTasks` merged into the story — the
   *  attempt's commit, and a fact the runner wrote rather than one it was told. Each of them
   *  was reachable from the story branch the moment it was recorded, so any of them that is
   *  not reachable now was dropped by whatever last rewrote the branch.
   *
   *  An empty `sha` is skipped: it means the tip could not be read at merge time, and an
   *  unknown commit is not evidence that a known one is missing. */
  private async orphanedBy(repo: string, branch: string, storyId: number): Promise<string | null> {
    const lost: string[] = [];
    for (const row of this.landedAttempts(storyId)) {
      if (!(await this.contains(repo, branch, row.sha))) lost.push(`task ${row.task} at ${row.sha.slice(0, 12)}`);
    }
    if (lost.length === 0) return null;
    return `it no longer reaches work wecode merged into it: ${lost.join(", ")} — a refresh adds the base, it does not replace the branch`;
  }

  /** The attempt commits this story's tasks landed on its branch. The walk is
   *  task → acceptance_test → criteria, which is `criteriaOfStory` from the other end. */
  private landedAttempts(storyId: number): { task: number; sha: string }[] {
    const under = this.criteriaOfStory(storyId);
    const q = queries(this.db);
    const tests = new Set(
      q
        .selectFrom(tbl.test)
        .select(["id", "parent_id"])
        .all()
        .filter((t) => under.has(t.parent_id))
        .map((t) => t.id),
    );
    const tasks = new Set(
      q
        .selectFrom(tbl.task)
        .select(["id", "acceptance_test_id"])
        .all()
        .filter((t) => tests.has(t.acceptance_test_id))
        .map((t) => t.id),
    );
    return q
      .selectFrom(tbl.landed)
      .select(["task_id", "sha"])
      .all()
      .filter((r) => tasks.has(r.task_id) && r.sha !== "")
      .map((r) => ({ task: r.task_id, sha: r.sha }));
  }

  /** `git merge-base --is-ancestor`: the merge, read off the graph rather than off a report. */
  private async contains(repo: string, branch: string, base: string): Promise<boolean> {
    return await exec("git", ["merge-base", "--is-ancestor", base, branch], { cwd: repo })
      .then(() => true)
      .catch(() => false);
  }

  /** The first of the story's scripts that fails in the merged tree, or null when they all
   *  pass. Run, not recorded: a verdict belongs to the test's own pass, and this is only the
   *  chore's check asking whether the merge broke anything. */
  private async suiteRed(target: { slug: string; repo: string; story: number }): Promise<string | null> {
    const under = this.criteriaOfStory(target.story);
    const rows = queries(this.db)
      .selectFrom(tbl.test)
      .select(["id", "artefact", "parent_id", "state"])
      .where("kind", "=", "script")
      .where("artefact", "!=", null)
      .where("state", "!=", "dropped")
      .all()
      .filter((t) => under.has(t.parent_id))
      .sort(byId)
      .flatMap((t) => (t.artefact === null ? [] : [{ artefact: t.artefact }]));
    if (rows.length === 0) return null;

    const tree = await this.treesFor(target.repo).storyTree(
      target.slug,
      join(this.worktreeRoot(target.repo), `story-${target.slug}`),
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

  private storyTargetOf(chore: Chore): { story: number; slug: string; repo: string } | null {
    if (chore.target_type !== "story") return null;
    const row = queries(this.db).selectFrom(tbl.story).where("id", "=", chore.target_id).get();
    if (row === null) return null;
    const owner = this.projectOf(row);
    if (owner === null) return null;
    return { story: row.id, slug: row.slug, repo: this.opts.repoRoot ?? owner.repo };
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

  private openAssignments(): number {
    return queries(this.db)
      .selectFrom(tbl.assignment)
      .select(["phase"])
      .all()
      .filter((a) => OPEN_PHASES.includes(a.phase)).length;
  }

  /** Would this branch merge into the base, without touching either?
   *
   *  `merge-tree --write-tree` answers it in the object store: no checkout, no index, and
   *  nothing to clean up if the answer is no.
   *
   *  Both refs are checked first, because merge-tree exits 1 for a ref that is not there
   *  as well as for a conflict. Read off the exit code alone, a story that never had a
   *  branch gets a merge chore that no merge could ever discharge. */
  private async mergesCleanly(repo: string, base: string, branch: string): Promise<boolean> {
    for (const ref of [base, branch]) {
      const there = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo })
        .then(() => true)
        .catch(() => false);
      if (!there) return true;
    }
    return await exec("git", ["merge-tree", "--write-tree", base, branch], { cwd: repo })
      .then(() => true)
      .catch(() => false);
  }

  /** A task whose tests passed lands on its story branch. */
  /** A task whose tests passed lands on its story branch — once. The merge is recorded
   *  against the branch tip it merged, so a branch that grows a commit afterwards lands
   *  again and one that has not is left alone. */
  private async landDoneTasks(): Promise<number[]> {
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
    for (const row of rows) {
      const slugs = this.slugsFor(row.id);
      if (slugs === null) continue;
      const branch = `task/${slugs.task}`;
      const tip = await this.tipOf(slugs.repo, branch);
      if (this.alreadyLanded(row.id, branch, tip)) continue;
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
      } catch {
        // a conflict a person has to see. Unrecorded, so the next tick tries again.
      }
    }
    return merged;
  }

  /** A tip we could not read is no proof, so the merge is attempted; git itself refuses a
   *  second merge of an unchanged branch, and that refusal stays the backstop. */
  private alreadyLanded(taskId: number, branch: string, tip: string | null): boolean {
    if (tip === null) return false;
    const row = queries(this.db).selectFrom(tbl.landed).select(["branch", "sha"]).where("task_id", "=", taskId).get();
    return row?.branch === branch && row.sha === tip;
  }

  private async tipOf(repo: string, ref: string): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo });
      return stdout.trim() || null;
    } catch {
      return null;
    }
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
