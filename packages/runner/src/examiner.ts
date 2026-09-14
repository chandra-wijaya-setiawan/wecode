import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { Engine, now } from "@wecode/core";

const exec = promisify(execFile);

/** A verdict the engine would not accept, in the engine's own words. The script's exit
 *  code is not the last word: a guard can refuse the transition it implies, and a refusal
 *  that is dropped on the floor reads as a pass that never happened. */
export interface Refused {
  readonly id: number;
  readonly why: string;
}

export interface ScriptReport {
  readonly passed: readonly number[];
  readonly failed: readonly number[];
  /** Tests whose verdict already stands against this exact tree. */
  readonly skipped: readonly number[];
  /** Tests whose script is not in this tree. Not a verdict: they stay as they were. */
  readonly unrunnable?: readonly number[];
  /** Tests whose script said one thing and the engine refused it. Never a pass. */
  readonly refused?: readonly Refused[];
}

const nothing: ScriptReport = { passed: [], failed: [], skipped: [], unrunnable: [], refused: [] };

/** Written where the board reads a run's output, so a missing script never reads as a
 *  failure with an empty reason. */
export const NOT_IN_TREE = "unrunnable: its script is not in this tree";

/** Written where the board reads a run's output, ahead of what the script printed, so a
 *  transition the engine refused is read as a refusal rather than as a silent nothing. */
export const REFUSED = "refused";

const INTERPRETERS = new Set(["bash", "sh", "zsh", "node", "python", "python3", "tsx", "deno"]);

/** The script file an artefact invokes, when it invokes one. `./scripts/x.sh --all` and
 *  `bash scripts/x.sh` both carry one; `test -f hello.ts` and `pnpm vitest` do not — they
 *  name no file whose absence would make the test unrunnable rather than failed. */
export function scriptPathOf(artefact: string): string | null {
  const words = artefact.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  // `bash -lc 'x'` and friends carry a program, not a path: only a bare argument counts.
  const head = words[0]!.replace(/^.*\//, "");
  const candidate = INTERPRETERS.has(head) ? words.slice(1).find((w) => !w.startsWith("-")) : words[0];
  if (candidate === undefined || candidate.startsWith("-")) return null;
  if (/[;&|><$`(){}*?"']/.test(candidate)) return null;
  const looksLikeAPath = candidate.includes("/") || /\.(sh|bash|ts|js|mjs|cjs|py)$/.test(candidate);
  return looksLikeAPath ? candidate : null;
}

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
export class Examiner {
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
    const unrunnable: number[] = [];
    const refused: Refused[] = [];
    const tip = await this.tip(cwd);
    // Stamped beside every verdict this pass takes: what the test was run against, not just
    // when. A pass that cannot say which sources it proves is a pass nobody can check.
    const provenance = await this.treeSha(cwd);

    for (const row of rows) {
      const script = scriptPathOf(row.artefact);
      if (script !== null && !existsSync(isAbsolute(script) ? script : resolve(cwd, script))) {
        // No script, no evidence. A verdict here would say the code is broken when all that
        // is missing is the test itself, so the test is left exactly as it stands.
        const at = now();
        this.db
          .prepare(`UPDATE ${entity} SET last_output = ?, updated_at = ? WHERE id = ?`)
          .run(`${NOT_IN_TREE}: ${script}`, at, row.id);
        unrunnable.push(row.id);
        continue;
      }
      const print = tip === null ? null : `${tip}|${against.attempt ?? ""}|${row.artefact}`;
      if (this.stands(entity, row, print)) {
        skipped.push(row.id);
        continue;
      }
      const out = await this.runOne(row.artefact, cwd);
      const at = now();
      this.db
        .prepare(
          `UPDATE ${entity} SET last_run_at = ?, last_output = ?, provenance_sha = ?, updated_at = ? WHERE id = ?`,
        )
        .run(at, out.output.slice(-8000), provenance, at, row.id);
      if (print !== null) {
        this.db
          .prepare(
            `INSERT INTO script_run (entity, test_id, fingerprint, ran_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (entity, test_id) DO UPDATE SET fingerprint = excluded.fingerprint, ran_at = excluded.ran_at`,
          )
          .run(entity, row.id, print, at);
      }
      const verdict = this.engine.apply(entity, row.id, out.ok ? "pass" : "fail", "runner");
      if (!verdict.ok) {
        // The engine's words, not ours: it is the thing that knows why, and a paraphrase
        // here is one more copy of the rules to keep in agreement with them.
        refused.push({ id: row.id, why: verdict.why });
        this.db
          .prepare(`UPDATE ${entity} SET last_output = ?, updated_at = ? WHERE id = ?`)
          .run(`${REFUSED}: ${verdict.why}\n${out.output.slice(-8000)}`, now(), row.id);
        continue;
      }
      (out.ok ? passed : failed).push(row.id);
    }

    return { passed, failed, skipped, unrunnable, refused };
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

  /** The git tree sha of the sources this run saw — `git rev-parse HEAD:.`. A commit sha
   *  names a history; a tree sha names the files, which is what a test proves something
   *  about, and two commits with the same sources deserve the same stamp. It asks git and
   *  nothing else, so it answers the same in any language and never consults a toolchain.
   *
   *  Asked as `HEAD:<prefix>` rather than as `HEAD:.`, because git refuses the `.` at the
   *  top of a checkout — "path '.' exists on disk, but not in 'HEAD'" — and a worktree is
   *  exactly that. `--show-prefix` is empty there and `sub/` below it, so one form answers
   *  in both places and still names the sources of the directory the test ran in.
   *
   *  Null where there is no git to ask, and a null stamp accuses nothing later. */
  private async treeSha(cwd: string): Promise<string | null> {
    try {
      const { stdout: prefix } = await exec("git", ["rev-parse", "--show-prefix"], { cwd });
      const { stdout } = await exec("git", ["rev-parse", `HEAD:${prefix.trim()}`], { cwd });
      return stdout.trim() || null;
    } catch {
      return null;
    }
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
