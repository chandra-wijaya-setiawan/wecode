import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { Engine, now } from "@wecode/core";

const exec = promisify(execFile);

export interface ScriptReport {
  readonly passed: readonly number[];
  readonly failed: readonly number[];
  /** Tests whose verdict already stands against this exact tree. */
  readonly skipped: readonly number[];
}

const nothing: ScriptReport = { passed: [], failed: [], skipped: [] };

/** What a verdict was reached against. A test that already passed or failed is only worth
 *  running again when one of these has moved. */
export interface RunAgainst {
  /** The attempt being judged. A retry writes in a fresh tree from the same branch tip, so
   *  without this a second attempt looks identical to the first. */
  readonly attempt?: number | string;
}

interface Row {
  readonly id: number;
  readonly artefact: string;
  readonly state: string;
}

/** A deterministic test needs no agent: run the command, read the exit code, record the
 *  verdict. No session, no tokens, no scope to negotiate.
 *
 *  Where it runs is the whole of the correctness here. A task_test proves *one attempt*, so
 *  it runs in that attempt's worktree, before the tree is released. An acceptance_test
 *  proves a criteria, so it runs in the story tree, after the tasks have merged. The first
 *  live run ran both at the repository root and failed a test whose work was three
 *  directories away.
 *
 *  A verdict is also a fact about *what it was run against*. Without that, a failed
 *  acceptance test is re-run every tick — on 14 Sep two of them held a tick open for
 *  minutes each while eleven ready tasks waited, and the runner read as idle rather than
 *  hung. So each run records a fingerprint of the tree tip, the attempt and the artefact,
 *  and a standing verdict is left alone until one of the three moves. */
export class Scripts {
  private readonly engine: Engine;

  constructor(
    private readonly db: DatabaseSync,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {
    this.engine = new Engine(db);
    // Runner-owned, beside the record rather than in it: the ledger says what is true of the
    // work, this says only what this machine has already done.
    db.exec(
      `CREATE TABLE IF NOT EXISTS script_run (
         entity      TEXT NOT NULL,
         test_id     INTEGER NOT NULL,
         fingerprint TEXT NOT NULL,
         ran_at      TEXT NOT NULL,
         PRIMARY KEY (entity, test_id)
       )`,
    );
  }

  /** The ready script task_tests of one task, in that task's attempt tree. */
  async runTaskTests(taskId: number, cwd: string, against: RunAgainst = {}): Promise<ScriptReport> {
    const rows = this.db
      .prepare(
        `SELECT id, artefact, state FROM task_test
          WHERE parent_id = ? AND state IN ('ready','failed') AND kind = 'script' AND artefact IS NOT NULL`,
      )
      .all(taskId) as unknown as Row[];
    return this.runAll("task_test", rows, cwd, against);
  }

  /** Every acceptance_test whose tasks are all finished, in the story tree it belongs to. */
  async runAcceptanceTests(storyId: number, cwd: string, against: RunAgainst = {}): Promise<ScriptReport> {
    const rows = this.db
      .prepare(
        `SELECT a.id AS id, a.artefact AS artefact, a.state AS state
           FROM acceptance_test a
           JOIN acceptance_criteria c ON c.id = a.parent_id
           JOIN requirement r ON r.id = c.requirement_id
          WHERE r.story_id = ?
            AND a.state IN ('ready','failed') AND a.kind = 'script' AND a.artefact IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM task t WHERE t.acceptance_test_id = a.id
                             AND t.state NOT IN ('done','dropped'))`,
      )
      .all(storyId) as unknown as Row[];
    return this.runAll("acceptance_test", rows, cwd, against);
  }

  private async runAll(
    entity: "task_test" | "acceptance_test",
    rows: readonly Row[],
    cwd: string,
    against: RunAgainst,
  ): Promise<ScriptReport> {
    if (rows.length === 0) return nothing;
    const passed: number[] = [];
    const failed: number[] = [];
    const skipped: number[] = [];
    const tip = await this.tip(cwd);

    for (const row of rows) {
      const print = tip === null ? null : `${tip}|${against.attempt ?? ""}|${row.artefact}`;
      if (this.stands(entity, row, print)) {
        skipped.push(row.id);
        continue;
      }
      const out = await this.runOne(row.artefact, cwd);
      const at = now();
      this.db
        .prepare(`UPDATE ${entity} SET last_run_at = ?, last_output = ?, updated_at = ? WHERE id = ?`)
        .run(at, out.output.slice(-8000), at, row.id);
      if (print !== null) {
        this.db
          .prepare(
            `INSERT INTO script_run (entity, test_id, fingerprint, ran_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (entity, test_id) DO UPDATE SET fingerprint = excluded.fingerprint, ran_at = excluded.ran_at`,
          )
          .run(entity, row.id, print, at);
      }
      this.engine.apply(entity, row.id, out.ok ? "pass" : "fail", "runner");
      (out.ok ? passed : failed).push(row.id);
    }

    return { passed, failed, skipped };
  }

  /** True when this test already has a verdict reached against this exact fingerprint.
   *  A test still in `ready` has no verdict to stand on, and an unreadable tip is no proof
   *  of anything, so both run. */
  private stands(entity: string, row: Row, print: string | null): boolean {
    if (print === null || row.state === "ready") return false;
    const seen = this.db
      .prepare("SELECT fingerprint FROM script_run WHERE entity = ? AND test_id = ?")
      .get(entity, row.id) as { fingerprint: string } | undefined;
    return seen?.fingerprint === print;
  }

  /** The commit the tree is at, or null when there is no git here to ask. */
  private async tip(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
      return stdout.trim() || null;
    } catch {
      return null;
    }
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
