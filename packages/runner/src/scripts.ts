import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { Engine, now } from "@wecode/core";

const exec = promisify(execFile);

interface Pending {
  entity: "acceptance_test" | "task_test";
  id: number;
  artefact: string;
  cwd: string;
}

export interface ScriptReport {
  readonly passed: readonly number[];
  readonly failed: readonly number[];
}

/** A deterministic test needs no agent. The runner runs the command, reads the exit code,
 *  and records the verdict — no session, no tokens, no scope to negotiate. */
export class Scripts {
  private readonly engine: Engine;

  constructor(
    private readonly db: DatabaseSync,
    private readonly repoRoot: string,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {
    this.engine = new Engine(db);
  }

  async tick(): Promise<ScriptReport> {
    const passed: number[] = [];
    const failed: number[] = [];

    for (const t of this.pending()) {
      const out = await this.runOne(t);
      this.db
        .prepare(`UPDATE ${t.entity} SET last_run_at = ?, last_output = ?, updated_at = ? WHERE id = ?`)
        .run(now(), out.output.slice(-8000), now(), t.id);
      const verb = out.ok ? "pass" : "fail";
      this.engine.apply(t.entity, t.id, verb, "runner");
      (out.ok ? passed : failed).push(t.id);
    }

    return { passed, failed };
  }

  /** Every script test that is ready and has not been judged since its last change.
   *  A task_test only runs once its task has been attempted; an acceptance_test once its
   *  tasks are done — otherwise the answer is known in advance. */
  private pending(): Pending[] {
    const taskTests = this.db
      .prepare(
        `SELECT tt.id AS id, tt.artefact AS artefact
           FROM task_test tt JOIN task t ON t.id = tt.parent_id
          WHERE tt.state = 'ready' AND tt.kind = 'script' AND tt.artefact IS NOT NULL
            AND t.state = 'ready'`,
      )
      .all() as unknown as { id: number; artefact: string }[];

    const acceptance = this.db
      .prepare(
        `SELECT a.id AS id, a.artefact AS artefact
           FROM acceptance_test a
          WHERE a.state = 'ready' AND a.kind = 'script' AND a.artefact IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM task t WHERE t.acceptance_test_id = a.id
                             AND t.state NOT IN ('done','dropped'))`,
      )
      .all() as unknown as { id: number; artefact: string }[];

    return [
      ...taskTests.map((r) => ({ entity: "task_test" as const, id: r.id, artefact: r.artefact, cwd: this.repoRoot })),
      ...acceptance.map((r) => ({ entity: "acceptance_test" as const, id: r.id, artefact: r.artefact, cwd: this.repoRoot })),
    ];
  }

  private async runOne(t: Pending): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec("bash", ["-lc", t.artefact], {
        cwd: t.cwd,
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
