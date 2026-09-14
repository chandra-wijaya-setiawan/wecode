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
    this.db.exec(LESSON_TABLE);
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
    const lessons = this.lessonsFor(row.id);
    return {
      id: row.id,
      objective_type: row.objective_type,
      objective_id: row.objective_id,
      instruction: this.instructionFor(row),
      scope: JSON.parse(row.scope) as Work["scope"],
      budget: JSON.parse(row.budget) as Budget,
      worktree: row.worktree,
      session: row.session,
      // A project with nothing to teach hands over no field at all: an empty list still
      // renders a heading, and a heading nothing follows is how the brief gets skimmed.
      ...(lessons.length > 0 ? { lessons } : {}),
    };
  }

  /** The ten newest lessons of this assignment's project, newest first. */
  private lessonsFor(id: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT text FROM lesson WHERE project_id = (${PROJECT_OF})
          ORDER BY id DESC LIMIT 10`,
      )
      .all(id) as unknown as { text: string }[];
    return rows.map((r) => r.text);
  }

  /** What an attempt learned, kept against the project rather than the task: the thing that
   *  bought this — a worktree that could not install — was true of all three tasks that hit
   *  it. The assignment is kept too, so a suspicious lesson can be traced back. */
  private recordLesson(id: number, lesson: string): void {
    const text = lesson.trim();
    if (text === "") return;
    const project = this.db.prepare(`SELECT (${PROJECT_OF}) AS project`).get(id) as
      | { project: number | null }
      | undefined;
    if (project?.project == null) return;
    this.db
      .prepare("INSERT INTO lesson (project_id, assignment_id, text, created_at) VALUES (?, ?, ?, ?)")
      .run(project.project, id, text, now());
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

    // Recorded whatever the attempt then counts as: what a failure learned is the half most
    // worth keeping, and the phase it ended in says nothing about whether it is true.
    if ((seen.phase === "succeeded" || seen.phase === "failed") && seen.lesson !== undefined) {
      this.recordLesson(id, seen.lesson);
    }

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
      const ok = this.engine.apply("assignment", id, "finish", "foreman").ok;
      if (ok) this.countAttempt(id);
      return ok;
    }

    this.db
      .prepare("UPDATE assignment SET last_seen = ?, spent = ?, reason = ?, updated_at = ? WHERE id = ?")
      .run(at, spent, seen.reason, at, id);
    const out = this.engine.apply("assignment", id, "fail", "foreman").ok;
    if (out) this.countAttempt(id);
    return out;
  }

  /** Every attempt counts, whatever phase it ended in.
   *
   *  A session can exit cleanly having proved nothing — the first live run did exactly
   *  that — so counting only failures lets a task be retried forever. One attempt does not
   *  fail a task; the retry limit does. Counting is the foreman's, deciding is not. */
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

/** A lesson is a note about a world that changes, not part of the record of the work, so it
 *  is nullable everywhere it touches one and deleting it costs nothing. */
const LESSON_TABLE = `
CREATE TABLE IF NOT EXISTS lesson (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES project(id),
  assignment_id INTEGER NOT NULL REFERENCES assignment(id),
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL
)`;

/** An assignment's project, by the walk up from whichever of the three objectives it has.
 *  Nothing below a project carries a project_id, so the walk is the only way to know. */
const upFromTest = (test: string): string =>
  `SELECT r.project_id
     FROM acceptance_test x
     JOIN acceptance_criteria c ON c.id = x.parent_id
     JOIN requirement q ON q.id = c.requirement_id
     JOIN story s ON s.id = q.story_id
     JOIN epic e ON e.id = s.epic_id
     JOIN release r ON r.id = e.release_id
    WHERE x.id = ${test}`;
const testOfTask = (task: string): string =>
  `(SELECT t.acceptance_test_id FROM task t WHERE t.id = ${task})`;
const taskOfTaskTest = (id: string): string =>
  `(SELECT tt.parent_id FROM task_test tt WHERE tt.id = ${id})`;

const PROJECT_OF = `SELECT CASE a.objective_type
    WHEN 'task' THEN (${upFromTest(testOfTask("a.objective_id"))})
    WHEN 'acceptance_test' THEN (${upFromTest("a.objective_id")})
    WHEN 'task_test' THEN (${upFromTest(testOfTask(taskOfTaskTest("a.objective_id")))})
  END
  FROM assignment a WHERE a.id = ?`;
