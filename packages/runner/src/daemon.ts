import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { clearRefusal, Engine, now, recordRefusal } from "@wecode/core";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { allocate, candidates as readyCandidates, type Candidate, type Pass } from "./allocator.js";
import type { BudgetConfig } from "./budget.js";
import { Foreman, type TickReport } from "./foreman.js";
import type { WorkerAdapter } from "./ports.js";
import { Scripts, type Refused, type ScriptReport } from "./scripts.js";
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
  /** Tasks that have used every attempt while the story that needs them is still open. */
  readonly drift: readonly Drift[];
  /** Completion transitions that fired because their guard had become true. */
  readonly settled: readonly string[];
  /** Acceptance tests this tick ran at their story's base: red there, or green and so
   *  unable to prove anything. */
  readonly redAtBase: RedAtBase;
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
}

/** The whole engine, one tick at a time: allocate, run, judge.
 *
 *  Level-triggered on purpose. Every pass reads the record and acts on what is there, so a
 *  missed signal, a crash or a hand edit all heal on the next one. Events would be an
 *  optimisation; the timer is the guarantee. */
export class Runner {
  private readonly foreman: Foreman;
  private readonly scripts: Scripts;
  private readonly engine: Engine;
  /** One per repository. A workspace holds many projects, and each has its own branches. */
  private readonly treesByRepo = new Map<string, Trees>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: RunnerOptions,
  ) {
    this.foreman = new Foreman(db, opts.adapters, opts.deadlineSeconds ?? 3600);
    this.scripts = new Scripts(db);
    this.engine = new Engine(db);
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
    // After enforcement, so a task that ran out of attempts on this very tick is already
    // named rather than named a minute later.
    const drift = this.exhaustedTasks();
    return {
      allocated,
      foreman,
      committed: settled.committed,
      merged,
      exhausted,
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
        const r = await this.scripts.runTaskTests(row.task, row.worktree, { attempt: row.id });
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
        const r = await this.scripts.runAcceptanceTests(story.id, tree);
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
