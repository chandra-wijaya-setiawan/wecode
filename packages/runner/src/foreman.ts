import type { DatabaseSync } from "node:sqlite";
import { Engine, now, type Budget } from "@wecode/core";
import type { Observation, WorkerAdapter, Work } from "./ports.js";

interface OpenRow {
  id: number;
  objective_type: "task" | "acceptance_test" | "task_test";
  objective_id: number;
  scope: string;
  budget: string;
  worktree: string;
  phase: string;
  session: string | null;
  last_seen: string | null;
  answer: string | null;
}

export interface TickReport {
  readonly started: readonly number[];
  readonly advanced: readonly number[];
  readonly failed: readonly number[];
}

/** Takes an assignment and makes it real: starts the session, watches it, kills it,
 *  resumes it. It decides nothing about the work — only whether an attempt exists and how
 *  it is going. */
export class Foreman {
  private readonly engine: Engine;

  constructor(
    private readonly db: DatabaseSync,
    private readonly adapters: Readonly<Record<string, WorkerAdapter>>,
    private readonly deadlineSeconds = 3600,
  ) {
    this.engine = new Engine(db);
  }

  /** One pass over every open assignment. Level-triggered: it reads state and acts, so a
   *  missed event, a crash or a manual change all heal on the next tick. */
  async tick(): Promise<TickReport> {
    const started: number[] = [];
    const advanced: number[] = [];
    const failed: number[] = [];

    for (const row of this.open()) {
      const adapter = this.adapterFor(row);
      if (adapter === null) {
        this.record(row.id, { phase: "failed", session: null, spent: zero(), reason: "other" });
        failed.push(row.id);
        continue;
      }

      const work = this.workOf(row);
      let seen: Observation;
      try {
        if (row.phase === "pending") {
          seen = await adapter.start(work);
          started.push(row.id);
        } else if (row.phase === "waiting") {
          if (row.answer === null) continue; // still waiting on a person
          // The answer moves it back to running before anything the worker then does is
          // recorded — otherwise a session that finishes immediately would try to reach
          // succeeded from waiting, which no transition allows.
          if (!this.engine.apply("assignment", row.id, "answer", "operator").ok) continue;
          seen = await adapter.answer(work, row.answer);
        } else {
          if (this.overdue(row)) {
            await adapter.kill(work);
            seen = { phase: "failed", session: row.session, spent: zero(), reason: "timeout" };
          } else {
            seen = await adapter.poll(work);
          }
        }
      } catch (err) {
        seen = { phase: "failed", session: row.session, spent: zero(), reason: "lost" };
        void err;
      }

      const moved = this.record(row.id, seen);
      if (seen.phase === "failed") failed.push(row.id);
      else if (moved) advanced.push(row.id);
    }

    return { started, advanced, failed };
  }

  private phaseOf(id: number): string {
    const row = this.db.prepare("SELECT phase FROM assignment WHERE id = ?").get(id) as
      | { phase: string }
      | undefined;
    return row?.phase ?? "";
  }

  private open(): OpenRow[] {
    return this.db
      .prepare(
        `SELECT id, objective_type, objective_id, scope, budget, worktree, phase, session, last_seen, answer
           FROM assignment WHERE phase IN ('pending','running','waiting') ORDER BY id`,
      )
      .all() as unknown as OpenRow[];
  }

  private adapterFor(row: OpenRow): WorkerAdapter | null {
    const kind = this.db
      .prepare(
        `SELECT w.kind AS kind FROM assignment a JOIN worker w ON w.id = a.worker_id WHERE a.id = ?`,
      )
      .get(row.id) as { kind: string } | undefined;
    return kind === undefined ? null : (this.adapters[kind.kind] ?? null);
  }

  private workOf(row: OpenRow): Work {
    return {
      id: row.id,
      objective_type: row.objective_type,
      objective_id: row.objective_id,
      instruction: this.instructionFor(row),
      scope: JSON.parse(row.scope) as Work["scope"],
      budget: JSON.parse(row.budget) as Budget,
      worktree: row.worktree,
      session: row.session,
    };
  }

  private instructionFor(row: OpenRow): string {
    const table = row.objective_type;
    const col = table === "task" ? "title" : "statement";
    const r = this.db.prepare(`SELECT ${col} AS text FROM ${table} WHERE id = ?`).get(row.objective_id) as
      | { text: string }
      | undefined;
    return r?.text ?? "";
  }

  private overdue(row: OpenRow): boolean {
    if (row.last_seen === null) return false;
    const age = (Date.now() - Date.parse(row.last_seen)) / 1000;
    return age >= this.deadlineSeconds;
  }

  /** The synchroniser: what was observed, written back so the record and reality agree. */
  private record(id: number, seen: Observation): boolean {
    const spent = JSON.stringify(seen.spent);
    const at = now();

    // A session can finish, or ask, inside the same call that started it. Neither is legal
    // from pending, so the start is recorded first: the record must be able to say the
    // attempt ran, even when it ran for one second.
    if (seen.phase !== "failed" && this.phaseOf(id) === "pending") {
      this.engine.apply("assignment", id, "start", "foreman");
    }

    if (seen.phase === "running") {
      this.db
        .prepare("UPDATE assignment SET session = ?, last_seen = ?, spent = ?, updated_at = ? WHERE id = ?")
        .run(seen.session, at, spent, at, id);
      return this.phaseOf(id) === "running";
    }

    if (seen.phase === "waiting") {
      this.db
        .prepare(
          `UPDATE assignment SET session = ?, last_seen = ?, spent = ?, kind = ?, question = ?, options = ?,
                                 answer = NULL, answered_by = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(seen.session, at, spent, seen.kind, seen.question, JSON.stringify(seen.options), at, id);
      return this.engine.apply("assignment", id, "ask", "foreman").ok;
    }

    if (seen.phase === "succeeded") {
      this.db
        .prepare(
          "UPDATE assignment SET session = coalesce(?, session), last_seen = ?, spent = ?, commit_sha = ?, updated_at = ? WHERE id = ?",
        )
        .run(seen.session, at, spent, seen.commit, at, id);
      return this.engine.apply("assignment", id, "finish", "foreman").ok;
    }

    this.db
      .prepare("UPDATE assignment SET last_seen = ?, spent = ?, reason = ?, updated_at = ? WHERE id = ?")
      .run(at, spent, seen.reason, at, id);
    const out = this.engine.apply("assignment", id, "fail", "foreman").ok;
    if (out) this.countAttempt(id);
    return out;
  }

  /** One failed attempt does not fail a task; the retry limit does. Counting is the
   *  foreman's, deciding is not. */
  private countAttempt(id: number): void {
    this.db
      .prepare(
        `UPDATE task SET attempts = attempts + 1, updated_at = ?
          WHERE id = (SELECT objective_id FROM assignment WHERE id = ? AND objective_type = 'task')`,
      )
      .run(now(), id);
  }
}

const zero = (): Budget => ({ tokens: 0, seconds: 0 });
