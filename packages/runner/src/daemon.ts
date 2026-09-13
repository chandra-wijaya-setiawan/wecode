import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { allocate, type Candidate, type Pass } from "./allocator.js";
import type { BudgetConfig } from "./budget.js";
import { Foreman, type TickReport } from "./foreman.js";
import type { WorkerAdapter } from "./ports.js";
import { Scripts, type ScriptReport } from "./scripts.js";

export interface Tick {
  readonly allocated: Pass;
  readonly foreman: TickReport;
  readonly scripts: ScriptReport;
}

export interface RunnerOptions {
  readonly budget: BudgetConfig;
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly adapters: Readonly<Record<string, WorkerAdapter>>;
  readonly deadlineSeconds?: number;
}

/** The whole engine, one tick at a time: allocate, run, judge.
 *
 *  Level-triggered on purpose. Every pass reads the record and acts on what is there, so a
 *  missed signal, a crash or a hand edit all heal on the next one. Events would be an
 *  optimisation; the timer is the guarantee. */
export class Runner {
  private readonly foreman: Foreman;
  private readonly scripts: Scripts;

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: RunnerOptions,
  ) {
    this.foreman = new Foreman(db, opts.adapters, opts.deadlineSeconds ?? 3600);
    this.scripts = new Scripts(db, opts.repoRoot);
  }

  async tick(): Promise<Tick> {
    const allocated = allocate(this.db, this.opts.budget, (c) => this.place(c));
    const foreman = await this.foreman.tick();
    const scripts = await this.scripts.tick();
    return { allocated, foreman, scripts };
  }

  /** A worker of the task's role with nothing open, and a tree to cut for it.
   *  The worktree belongs to the attempt: a retry must not inherit the last one's mess. */
  private place(c: Candidate): { worker_id: number; worktree: string } | null {
    const row = this.db
      .prepare(
        `SELECT w.id AS id FROM worker w
          WHERE w.role = ?
            AND NOT EXISTS (SELECT 1 FROM assignment a
                             WHERE a.worker_id = w.id AND a.phase IN ('pending','running','waiting'))
          ORDER BY w.id LIMIT 1`,
      )
      .get(c.role) as { id: number } | undefined;
    if (row === undefined) return null;

    const worktree = join(this.opts.worktreeRoot, `task-${c.id}-${Date.now()}`);
    mkdirSync(worktree, { recursive: true });
    return { worker_id: row.id, worktree };
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
