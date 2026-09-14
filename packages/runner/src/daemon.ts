import { existsSync } from "node:fs";
import { clearRefusal, Engine, recordRefusal } from "@wecode/core";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { allocate, candidates as readyCandidates, type Candidate, type Pass } from "./allocator.js";
import type { BudgetConfig } from "./budget.js";
import { Foreman, type TickReport } from "./foreman.js";
import type { WorkerAdapter } from "./ports.js";
import { Scripts, type ScriptReport } from "./scripts.js";
import { Trees } from "./git.js";

export interface Tick {
  readonly allocated: Pass;
  readonly foreman: TickReport;
  readonly scripts: ScriptReport;
  readonly committed: readonly number[];
  readonly merged: readonly number[];
  /** Tasks that ran out of attempts on this tick. */
  readonly exhausted: readonly number[];
  /** Completion transitions that fired because their guard had become true. */
  readonly settled: readonly string[];
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
  }

  /** allocate, run, prove, land. The order is the point: a task_test is run in the tree the
   *  attempt wrote in, before that tree is released, and an acceptance_test in the story
   *  tree, after the tasks it depends on have merged. */
  async tick(): Promise<Tick> {
    const allocated = await this.allocateOne();
    const foreman = await this.foreman.tick();
    const settled = await this.settleEnded();
    const merged = await this.landDoneTasks();
    const acceptance = await this.proveStories();
    // Level-triggered: anything whose guard became true for a reason other than the verb
    // that just ran settles here, rather than waiting for an event that already happened.
    const settled2 = this.engine.settle();
    const exhausted = this.enforceRetryLimit();
    return {
      allocated,
      foreman,
      committed: settled.committed,
      merged,
      exhausted,
      settled: settled2.map((c) => `${c.entity} #${c.id} → ${c.to}`),
      scripts: {
        passed: [...settled.scripts.passed, ...acceptance.passed],
        failed: [...settled.scripts.failed, ...acceptance.failed],
      },
    };
  }

  /** allocate() is synchronous and cutting a tree is not, so a placement is prepared for
   *  the first candidate that has a free worker, and the allocator then decides. */
  private async allocateOne(): Promise<Pass> {
    const prepared = new Map<number, { worker_id: number; worktree: string }>();
    const trouble = new Map<number, string>();
    for (const c of readyCandidates(this.db)) {
      const worker = this.freeWorker(c.role);
      if (worker === null) {
        trouble.set(c.id, `no worker free for role ${c.role || "(none)"}`);
        continue;
      }
      const cut = await this.cutTree(c);
      if (typeof cut !== "string") {
        trouble.set(c.id, cut.why);
        continue;
      }
      prepared.set(c.id, { worker_id: worker, worktree: cut });
      break; // one per tick
    }
    const pass = allocate(this.db, this.opts.budget, (c) => prepared.get(c.id) ?? null);

    // What the pass decided, on the record, so the board can say why nothing is running —
    // and so staleness is read from a reason rather than guessed from a timestamp.
    for (const r of pass.refused) {
      if (r.id !== 0) recordRefusal(this.db, trouble.get(r.id) ?? r.why, r.id);
    }
    for (const [id, why] of trouble) recordRefusal(this.db, why, id);

    // Everything ready that this pass did not reach. One assignment per tick is deliberate,
    // but a task nobody has looked at should still be able to say how long it has waited.
    const decided = new Set([...pass.refused.map((r) => r.id), ...trouble.keys(), ...prepared.keys()]);
    for (const c of readyCandidates(this.db)) {
      if (!decided.has(c.id)) recordRefusal(this.db, "waiting for a slot", c.id);
    }
    if (pass.created !== null) {
      const started = this.db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(pass.created) as
        | { objective_id: number }
        | undefined;
      if (started !== undefined) clearRefusal(this.db, started.objective_id);
    }
    // A tree cut for a task the allocator then refused is released rather than left behind.
    for (const [id, place] of prepared) {
      void id;
      if (pass.created === null || !this.assignmentUses(pass.created, place.worktree)) {
        const slugs = this.slugsFor(id);
        if (slugs !== null) await this.treesFor(slugs.repo).release(place.worktree).catch(() => undefined);
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

    for (const row of rows) {
      if (!existsSync(row.worktree)) continue;
      const slugs = this.slugsFor(row.task);
      if (slugs === null) continue;
      try {
        // The attempt is judged in the tree it wrote in, before that tree goes.
        const r = await this.scripts.runTaskTests(row.task, row.worktree);
        passed.push(...r.passed);
        failed.push(...r.failed);

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
    return { committed, scripts: { passed, failed } };
  }

  /** A task that has used its attempts stops, and says so. Without this the allocator
   *  retries a broken task forever — a crash loop with the machine holding the stopwatch. */
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
    for (const story of stories) {
      try {
        const repo = this.opts.repoRoot ?? story.repo;
        const tree = await this.treesFor(repo).storyTree(story.slug, join(this.worktreeRoot(repo), `story-${story.slug}`));
        const r = await this.scripts.runAcceptanceTests(story.id, tree);
        passed.push(...r.passed);
        failed.push(...r.failed);
      } catch {
        // a story with no branch yet has nothing to prove
      }
    }
    return { passed, failed };
  }

  /** A task whose tests passed lands on its story branch. */
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
      try {
        await this.treesFor(slugs.repo).mergeTaskIntoStory(
          `task/${slugs.task}`,
          slugs.story,
          join(this.worktreeRoot(slugs.repo), `story-${slugs.story}`),
        );
        this.db.prepare("UPDATE task SET updated_at = updated_at WHERE id = ?").run(row.id);
        merged.push(row.id);
      } catch {
        // already merged, or a conflict a person has to see
      }
    }
    return merged;
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
