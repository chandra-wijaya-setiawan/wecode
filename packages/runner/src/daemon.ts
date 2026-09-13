import { existsSync } from "node:fs";
import { Engine } from "@wecode/core";
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
}

export interface RunnerOptions {
  readonly budget: BudgetConfig;
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly adapters: Readonly<Record<string, WorkerAdapter>>;
  readonly deadlineSeconds?: number;
  readonly integrationBranch?: string;
}

/** The whole engine, one tick at a time: allocate, run, judge.
 *
 *  Level-triggered on purpose. Every pass reads the record and acts on what is there, so a
 *  missed signal, a crash or a hand edit all heal on the next one. Events would be an
 *  optimisation; the timer is the guarantee. */
export class Runner {
  private readonly foreman: Foreman;
  private readonly scripts: Scripts;
  private readonly trees: Trees;
  private readonly engine: Engine;

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: RunnerOptions,
  ) {
    this.foreman = new Foreman(db, opts.adapters, opts.deadlineSeconds ?? 3600);
    this.scripts = new Scripts(db);
    this.trees = new Trees(opts.repoRoot, opts.integrationBranch ?? "main");
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
    const exhausted = this.enforceRetryLimit();
    return {
      allocated,
      foreman,
      committed: settled.committed,
      merged,
      exhausted,
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
    for (const c of readyCandidates(this.db)) {
      const worker = this.freeWorker(c.role);
      if (worker === null) continue;
      const path = await this.cutTree(c);
      if (path === null) continue;
      prepared.set(c.id, { worker_id: worker, worktree: path });
      break; // one per tick
    }
    const pass = allocate(this.db, this.opts.budget, (c) => prepared.get(c.id) ?? null);
    // A tree cut for a task the allocator then refused is released rather than left behind.
    for (const [id, place] of prepared) {
      void id;
      if (pass.created === null || !this.assignmentUses(pass.created, place.worktree)) {
        await this.trees.release(place.worktree).catch(() => undefined);
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

  private async cutTree(c: Candidate): Promise<string | null> {
    const slugs = this.slugsFor(c.id);
    if (slugs === null) return null;
    try {
      const branch = await this.trees.taskBranch(slugs.story, slugs.task);
      const path = join(this.opts.worktreeRoot, `${slugs.task}-${Date.now()}`);
      await this.trees.cut(branch, path);
      return path;
    } catch {
      return null;
    }
  }

  private slugsFor(taskId: number): { task: string; story: string } | null {
    const row = this.db
      .prepare(
        `SELECT t.slug AS task, s.slug AS story
           FROM task t
           JOIN acceptance_test a ON a.id = t.acceptance_test_id
           JOIN acceptance_criteria c ON c.id = a.parent_id
           JOIN requirement r ON r.id = c.requirement_id
           JOIN story s ON s.id = r.story_id
          WHERE t.id = ?`,
      )
      .get(taskId) as { task: string; story: string } | undefined;
    return row ?? null;
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

        const sha = await this.trees.commitAttempt(
          row.worktree,
          `task/${slugs.task}`,
          `${slugs.task}: attempt`,
        );
        if (sha !== null) {
          this.db.prepare("UPDATE assignment SET commit_sha = ? WHERE id = ?").run(sha, row.id);
          committed.push(row.id);
        }
        await this.trees.release(row.worktree);
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
        `SELECT DISTINCT s.id AS id, s.slug AS slug
           FROM story s
           JOIN requirement r ON r.story_id = s.id
           JOIN acceptance_criteria c ON c.requirement_id = r.id
           JOIN acceptance_test a ON a.parent_id = c.id
          WHERE s.state = 'in_progress' AND a.state IN ('ready','failed') AND a.kind = 'script'`,
      )
      .all() as unknown as { id: number; slug: string }[];

    const passed: number[] = [];
    const failed: number[] = [];
    for (const story of stories) {
      try {
        const tree = await this.trees.storyTree(story.slug, join(this.opts.worktreeRoot, `story-${story.slug}`));
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
        await this.trees.mergeTaskIntoStory(
          `task/${slugs.task}`,
          slugs.story,
          join(this.opts.worktreeRoot, `story-${slugs.story}`),
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
