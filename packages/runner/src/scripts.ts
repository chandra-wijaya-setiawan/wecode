import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { Engine, now } from "@wecode/core";

const exec = promisify(execFile);

export interface ScriptReport {
  readonly passed: readonly number[];
  readonly failed: readonly number[];
}

const nothing: ScriptReport = { passed: [], failed: [] };

/** A deterministic test needs no agent: run the command, read the exit code, record the
 *  verdict. No session, no tokens, no scope to negotiate.
 *
 *  Where it runs is the whole of the correctness here. A task_test proves *one attempt*, so
 *  it runs in that attempt's worktree, before the tree is released. An acceptance_test
 *  proves a criteria, so it runs in the story tree, after the tasks have merged. The first
 *  live run ran both at the repository root and failed a test whose work was three
 *  directories away. */
export class Scripts {
  private readonly engine: Engine;

  constructor(
    private readonly db: DatabaseSync,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {
    this.engine = new Engine(db);
  }

  /** The ready script task_tests of one task, in that task's attempt tree. */
  async runTaskTests(taskId: number, cwd: string): Promise<ScriptReport> {
    const rows = this.db
      .prepare(
        `SELECT id, artefact FROM task_test
          WHERE parent_id = ? AND state IN ('ready','failed') AND kind = 'script' AND artefact IS NOT NULL`,
      )
      .all(taskId) as unknown as { id: number; artefact: string }[];
    return this.runAll("task_test", rows, cwd);
  }

  /** Every acceptance_test whose tasks are all finished, in the story tree it belongs to. */
  async runAcceptanceTests(storyId: number, cwd: string): Promise<ScriptReport> {
    const rows = this.db
      .prepare(
        `SELECT a.id AS id, a.artefact AS artefact
           FROM acceptance_test a
           JOIN acceptance_criteria c ON c.id = a.parent_id
           JOIN requirement r ON r.id = c.requirement_id
          WHERE r.story_id = ?
            AND a.state IN ('ready','failed') AND a.kind = 'script' AND a.artefact IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM task t WHERE t.acceptance_test_id = a.id
                             AND t.state NOT IN ('done','dropped'))`,
      )
      .all(storyId) as unknown as { id: number; artefact: string }[];
    return this.runAll("acceptance_test", rows, cwd);
  }

  private async runAll(
    entity: "task_test" | "acceptance_test",
    rows: readonly { id: number; artefact: string }[],
    cwd: string,
  ): Promise<ScriptReport> {
    if (rows.length === 0) return nothing;
    const passed: number[] = [];
    const failed: number[] = [];

    for (const row of rows) {
      const out = await this.runOne(row.artefact, cwd);
      const at = now();
      this.db
        .prepare(`UPDATE ${entity} SET last_run_at = ?, last_output = ?, updated_at = ? WHERE id = ?`)
        .run(at, out.output.slice(-8000), at, row.id);
      this.engine.apply(entity, row.id, out.ok ? "pass" : "fail", "runner");
      (out.ok ? passed : failed).push(row.id);
    }

    return { passed, failed };
  }

  private async runOne(artefact: string, cwd: string): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec("bash", ["-lc", artefact], {
        cwd,
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, output: `${stdout}${stderr}` };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}` };
    }
  }
}
