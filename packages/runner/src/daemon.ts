import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  applyChore,
  choreById,
  CHORE_KIND_DEFS,
  clearChoreRefusal,
  clearRefusal,
  choreFor,
  closeChore,
  Engine,
  ensureChore,
  loadRoles,
  Maker,
  now,
  recordChoreRefusal,
  recordRefusal,
  type Budget,
  type Chore,
  type RoleConfig,
  type Scope,
  type Violation,
} from "@wecode/core";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { allocate, candidates as readyCandidates, type Candidate, type Pass } from "./allocator.js";
import type { BudgetConfig } from "./budget.js";
import { Foreman, type TickReport } from "./foreman.js";
import type { WorkerAdapter } from "./ports.js";
import { Doctor, type Invariant } from "./doctor.js";
import { Examiner, type Refused, type ScriptReport } from "./examiner.js";
import { Trees } from "./git.js";

const exec = promisify(execFile);

export interface Tick {
  readonly allocated: Pass;
  readonly foreman: TickReport;
  readonly scripts: ScriptReport;
  readonly committed: readonly number[];
  readonly merged: readonly number[];
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
  /** What the invariant set found this tick. Recorded as well as returned, so a view reads
   *  the table rather than running the pass again. Empty is the healthy answer. */
  readonly doctor: readonly Violation[];
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
    // First, because the point of it is that it happens before the work does.
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
    const chores = await this.raiseMergeChores();
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
      exhausted,
      performed,
      chores: chores.filter((id) => !performed.done.includes(id)),
      drift,
      redAtBase,
      settled: settled2.map((c) => `${c.entity} #${c.id} → ${c.to}`),
      scripts: {
        passed: [...settled.scripts.passed, ...acceptance.passed],
        failed: [...settled.scripts.failed, ...acceptance.failed],
        skipped: [...settled.scripts.skipped, ...acceptance.skipped],
        refused: [...(settled.scripts.refused ?? []), ...(acceptance.refused ?? [])],
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
    for (const row of this.db.prepare("SELECT task_id FROM refusal").all() as unknown as { task_id: number }[]) {
      if (!decided.has(row.task_id)) clearRefusal(this.db, row.task_id);
    }
    if (pass.created !== null) {
      const started = this.db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(pass.created) as
        | { objective_id: number }
        | undefined;
      if (started !== undefined) clearRefusal(this.db, started.objective_id);
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
    const row = this.db.prepare("SELECT worktree FROM assignment WHERE id = ?").get(assignment) as
      | { worktree: string }
      | undefined;
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
    const row = this.db
      .prepare(
        `SELECT t.slug AS task, s.slug AS story, p.repo AS repo
           FROM task t
           JOIN acceptance_test a ON a.id = t.acceptance_test_id
           JOIN acceptance_criteria c ON c.id = a.parent_id
           JOIN requirement r ON r.id = c.requirement_id
           JOIN story s ON s.id = r.story_id
           JOIN epic e ON e.id = s.epic_id
           JOIN release rel ON rel.id = e.release_id
           JOIN project p ON p.id = rel.project_id
          WHERE t.id = ?`,
      )
      .get(taskId) as { task: string; story: string; repo: string } | undefined;
    if (row === undefined) return null;
    return { ...row, repo: this.opts.repoRoot ?? row.repo };
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

  private freeWorker(role: string): number | null {
    const row = this.db
      .prepare(
        `SELECT w.id AS id FROM worker w
          WHERE w.role = ?
            AND NOT EXISTS (SELECT 1 FROM assignment a
                             WHERE a.worker_id = w.id AND a.phase IN ('pending','running','waiting'))
          ORDER BY w.id LIMIT 1`,
      )
      .get(role) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** An attempt that has ended: commit whatever it wrote onto its task branch, then let the
   *  tree go. The branch is the surviving copy; the directory is a checkout held against a
   *  retry nobody has promised. */
  private async settleEnded(): Promise<{ committed: number[]; scripts: ScriptReport }> {
    const rows = this.db
      .prepare(
        `SELECT a.id AS id, a.worktree AS worktree, a.objective_id AS task, a.commit_sha AS sha
           FROM assignment a
          WHERE a.objective_type = 'task' AND a.phase IN ('succeeded','failed') AND a.worktree <> ''`,
      )
      .all() as unknown as { id: number; worktree: string; task: number; sha: string | null }[];

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
          this.db.prepare("UPDATE assignment SET commit_sha = ? WHERE id = ?").run(sha, row.id);
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
    const rows = this.db
      .prepare(
        `SELECT t.id AS task, t.slug AS slug, t.attempts AS attempts, t.max_retry AS max_retry,
                s.slug AS story, s.state AS story_state
           FROM task t
           JOIN acceptance_test a ON a.id = t.acceptance_test_id
           JOIN acceptance_criteria c ON c.id = a.parent_id
           JOIN requirement r ON r.id = c.requirement_id
           JOIN story s ON s.id = r.story_id
          WHERE t.state NOT IN ('done', 'dropped')
            AND t.attempts >= t.max_retry
            AND s.state NOT IN ('delivered', 'dropped')
          ORDER BY t.id`,
      )
      .all() as unknown as {
      task: number;
      slug: string;
      attempts: number;
      max_retry: number;
      story: string;
      story_state: string;
    }[];

    return rows.map((row) => ({
      task: row.task,
      slug: row.slug,
      story: row.story,
      why:
        `${row.attempts} of ${row.max_retry} attempts used, and story ${row.story} is still ` +
        `${row.story_state} — wecode task retry ${row.task} --reason "…", or drop it`,
    }));
  }

  /** A task that has used its attempts stops, and says so. Without this the allocator
   *  retries a broken task forever — a crash loop with the machine holding the stopwatch.
   *
   *  It only ever stops one. The runner has no path back the other way: nothing here
   *  applies `retry`, because bringing an exhausted task back is a judgement about why it
   *  failed, and the machine has not got one. */
  private enforceRetryLimit(): number[] {
    const rows = this.db
      .prepare(`SELECT id FROM task WHERE state = 'ready' AND attempts >= max_retry`)
      .all() as unknown as { id: number }[];

    const stopped: number[] = [];
    for (const row of rows) {
      if (this.engine.apply("task", row.id, "give_up", "runner").ok) stopped.push(row.id);
    }
    return stopped;
  }

  /** A test nobody has seen fail proves nothing by passing. So each ready acceptance test is
   *  run once at the commit its story was cut from — the merge-base of the story branch and
   *  the integration branch — before any of its tasks has written a line. Red there is the
   *  proof, and is recorded. Green there is a test that cannot fail, and the reason it
   *  proves nothing is recorded against it instead. */
  private async proveRedAtBase(): Promise<RedAtBase> {
    const rows = this.db
      .prepare(
        `SELECT a.id AS id, a.artefact AS artefact, s.slug AS story, p.repo AS repo
           FROM acceptance_test a
           JOIN acceptance_criteria c ON c.id = a.parent_id
           JOIN requirement r ON r.id = c.requirement_id
           JOIN story s ON s.id = r.story_id
           JOIN epic e ON e.id = s.epic_id
           JOIN release rel ON rel.id = e.release_id
           JOIN project p ON p.id = rel.project_id
          WHERE s.state = 'in_progress' AND a.state = 'ready' AND a.kind = 'script'
            AND a.artefact IS NOT NULL
            AND a.red_at_base_sha IS NULL`,
      )
      .all() as unknown as { id: number; artefact: string; story: string; repo: string }[];

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
    const row = this.db
      .prepare("SELECT fingerprint FROM script_run WHERE entity = 'acceptance_test@base' AND test_id = ?")
      .get(testId) as { fingerprint: string } | undefined;
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
    this.db
      .prepare(
        `UPDATE acceptance_test
            SET red_at_base_sha = ?, red_at_base_at = ?, red_at_base_reason = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        green ? null : base,
        green ? null : at,
        green ? "it passes at base, so it cannot fail" : null,
        at,
        testId,
      );
    this.db
      .prepare(
        `INSERT INTO script_run (entity, test_id, fingerprint, ran_at) VALUES ('acceptance_test@base', ?, ?, ?)
           ON CONFLICT (entity, test_id) DO UPDATE SET fingerprint = excluded.fingerprint, ran_at = excluded.ran_at`,
      )
      .run(testId, `${base}|${artefact}`, at);
  }

  /** Acceptance tests, in the story tree, once the story's tasks are finished. */
  private async proveStories(): Promise<ScriptReport> {
    const stories = this.db
      .prepare(
        `SELECT DISTINCT s.id AS id, s.slug AS slug, p.repo AS repo
           FROM story s
           JOIN epic e2 ON e2.id = s.epic_id
           JOIN release rel2 ON rel2.id = e2.release_id
           JOIN project p ON p.id = rel2.project_id
           JOIN requirement r ON r.story_id = s.id
           JOIN acceptance_criteria c ON c.requirement_id = r.id
           JOIN acceptance_test a ON a.parent_id = c.id
          WHERE s.state = 'in_progress' AND a.state IN ('ready','failed') AND a.kind = 'script'`,
      )
      .all() as unknown as { id: number; slug: string; repo: string }[];

    const passed: number[] = [];
    const failed: number[] = [];
    const skipped: number[] = [];
    const refused: Refused[] = [];
    for (const story of stories) {
      try {
        const repo = this.opts.repoRoot ?? story.repo;
        const tree = await this.treesFor(repo).storyTree(story.slug, join(this.worktreeRoot(repo), `story-${story.slug}`));
        const r = await this.examiner.runAcceptanceTests(story.id, tree);
        passed.push(...r.passed);
        failed.push(...r.failed);
        skipped.push(...r.skipped);
        refused.push(...(r.refused ?? []));
      } catch {
        // a story with no branch yet has nothing to prove
      }
    }
    return { passed, failed, skipped, refused };
  }

  /** docs/design/18. A story is delivered and its branch will not merge into the base.
   *
   *  Until now that was a sentence in a report: the merge in `landDoneTasks` swallowed the
   *  conflict, and a delivered story that could not be landed looked exactly like one that
   *  had been. Four of them sat that way for a day. A chore is the record of it — on the
   *  board, with a target and a check, and takeable by a worker.
   *
   *  This runs every tick and creates nothing on the second one: `ensureChore` is keyed on
   *  (kind, target), which is the condition itself.
   *
   *  Level-triggered in both directions. The condition is re-read every tick and the chore
   *  follows it: true again re-raises a chore that had settled, false closes one that had
   *  not. Neither is a timer and neither is a guess — this reads the branch against the base
   *  before it says either. */
  private async raiseMergeChores(): Promise<number[]> {
    const stories = this.db
      .prepare(
        `SELECT s.id AS id, s.slug AS slug, rel.project_id AS project, p.repo AS repo
           FROM story s
           JOIN epic e ON e.id = s.epic_id
           JOIN release rel ON rel.id = e.release_id
           JOIN project p ON p.id = rel.project_id
          WHERE s.state = 'delivered'`,
      )
      .all() as unknown as { id: number; slug: string; project: number; repo: string }[];

    const open: number[] = [];
    for (const story of stories) {
      const repo = this.opts.repoRoot ?? story.repo;
      const base = await this.treesFor(repo)
        .integrationBranch()
        .catch(() => null);
      if (base === null) continue;
      const branch = `story/${story.slug}`;
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
    return this.db
      .prepare(
        `SELECT id, objective_id AS chore, worktree FROM assignment
          WHERE objective_type = 'chore' AND phase IN ('succeeded','failed') ORDER BY id`,
      )
      .all() as unknown as { id: number; chore: number; worktree: string }[];
  }

  private dispatchableChores(): { id: number }[] {
    return this.db
      .prepare("SELECT id FROM chore WHERE state IN ('planned','ready') ORDER BY id")
      .all() as unknown as { id: number }[];
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
      const begun = applyChore(this.db, chore.id, "begin", `worker-${worker}`);
      if (!begun.ok) return this.refuseChore(chore, begun.why);
      // Dispatched: whatever was holding it a tick ago is no longer true of it.
      clearChoreRefusal(this.db, chore.id);
      return id;
    } catch {
      // no branch, or no tree to be had: there is nothing to merge in yet
      return this.refuseChore(chore, "no branch to merge into yet");
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
   *  story carries is still green. */
  private async proveChore(chore: Chore): Promise<{ ok: true } | { ok: false; why: string }> {
    if (chore.kind !== "merge") return { ok: false, why: `nothing here knows how to prove a ${chore.kind} chore` };
    const target = this.storyTargetOf(chore);
    if (target === null) return { ok: false, why: "its target story is not on the record" };

    const branch = `story/${target.slug}`;
    try {
      const base = await this.treesFor(target.repo).integrationBranch();
      if (!(await this.contains(target.repo, branch, base))) {
        return { ok: false, why: `${base} is not an ancestor of ${branch}: the merge was not made` };
      }
      const red = await this.suiteRed(target);
      if (red !== null) return { ok: false, why: `${branch} contains ${base}, but the suite is red: ${red}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, why: (err as Error).message };
    }
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
    const rows = this.db
      .prepare(
        `SELECT a.artefact AS artefact
           FROM acceptance_test a
           JOIN acceptance_criteria c ON c.id = a.parent_id
           JOIN requirement r ON r.id = c.requirement_id
          WHERE r.story_id = ? AND a.kind = 'script' AND a.artefact IS NOT NULL AND a.state <> 'dropped'
          ORDER BY a.id`,
      )
      .all(target.story) as unknown as { artefact: string }[];
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
    const row = this.db
      .prepare(
        `SELECT s.id AS story, s.slug AS slug, p.repo AS repo
           FROM story s
           JOIN epic e ON e.id = s.epic_id
           JOIN release rel ON rel.id = e.release_id
           JOIN project p ON p.id = rel.project_id
          WHERE s.id = ?`,
      )
      .get(chore.target_id) as { story: number; slug: string; repo: string } | undefined;
    if (row === undefined) return null;
    return { ...row, repo: this.opts.repoRoot ?? row.repo };
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
    const row = this.db
      .prepare("SELECT count(*) AS n FROM assignment WHERE phase IN ('pending','running','waiting')")
      .get() as { n: number };
    return row.n;
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
    const rows = this.db
      .prepare(
        `SELECT t.id AS id FROM task t
          WHERE t.state = 'done'
            AND EXISTS (SELECT 1 FROM assignment a
                         WHERE a.objective_type = 'task' AND a.objective_id = t.id
                           AND a.commit_sha IS NOT NULL)`,
      )
      .all() as unknown as { id: number }[];

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
        this.db
          .prepare(
            `INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (task_id) DO UPDATE SET branch = excluded.branch, sha = excluded.sha,
                                                   merged_at = excluded.merged_at`,
          )
          .run(row.id, branch, tip ?? "", now());
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
    const row = this.db.prepare("SELECT branch, sha FROM landed_branch WHERE task_id = ?").get(taskId) as
      | { branch: string; sha: string }
      | undefined;
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
