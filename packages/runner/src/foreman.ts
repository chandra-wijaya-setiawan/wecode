import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Engine, now, type Budget } from "@wecode/core";
import { Trees } from "./git.js";
import type { History, Observation, TestFailure, WorkerAdapter, Work } from "./ports.js";

/** Where the assignments being watched live, when the foreman has to ask git something the
 *  record does not hold — the name of the base branch a merge chore's brief has to say. */
export interface ForemanOptions {
  readonly integrationBranch?: string | null;
  /** Only for tests: pretend every project lives here. */
  readonly repoRoot?: string | undefined;
}

interface OpenRow {
  id: number;
  objective_type: "task" | "acceptance_test" | "task_test" | "chore";
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
    private readonly opts: ForemanOptions = {},
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

      const work = await this.workOf(row);
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
          // Poll first, judge the deadline after. An assignment the adapter has never heard
          // of — the runner restarted under it — is lost, not overdue, and the difference
          // matters: a restart backdates nothing, so every open row looks overdue at once.
          // Judging first reported two live sessions as timeouts and began them again.
          seen = await adapter.poll(work);
          if (isLost(seen)) seen = await this.recover(adapter, work);
          else if (this.overdue(row)) {
            await adapter.kill(work);
            seen = { phase: "failed", session: row.session, spent: zero(), reason: "timeout" };
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

  /** A lost attempt that still has somewhere to go back to. The session id and the worktree
   *  are the two halves of an attempt's continuity: with both, the work so far is still on
   *  disk and the harness can be asked to reattach. With either missing there is nothing to
   *  resume, and lost is the honest answer. */
  private async recover(adapter: WorkerAdapter, work: Work): Promise<Observation> {
    const lost = (): Observation => ({ phase: "failed", session: work.session, spent: zero(), reason: "lost" });
    if (work.session === null || work.session === "") return lost();
    if (!existsSync(work.worktree)) return lost();
    try {
      return await adapter.resume(work);
    } catch {
      return lost();
    }
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

  private async workOf(row: OpenRow): Promise<Work> {
    const lessons = this.lessonsFor(row.id);
    return {
      id: row.id,
      // A chore is an objective like a task is, and the column has always been free text:
      // `Work["objective_type"]` is core's list of the ones a *test* can hang off, which a
      // chore deliberately does not.
      objective_type: row.objective_type as Work["objective_type"],
      objective_id: row.objective_id,
      instruction: await this.instructionFor(row),
      scope: JSON.parse(row.scope) as Work["scope"],
      budget: JSON.parse(row.budget) as Budget,
      worktree: row.worktree,
      session: row.session,
      // A project with nothing to teach hands over no field at all: an empty list still
      // renders a heading, and a heading nothing follows is how the brief gets skimmed.
      ...(lessons.length > 0 ? { lessons } : {}),
      history: this.historyFor(row),
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

  /** What the last attempt at this task left on the branch.
   *
   *  Null unless this is a retry: a first attempt must be told exactly what it is told
   *  today. A retry is told what git already holds, because that is the only thing that
   *  crosses between two sessions that share no memory. */
  private historyFor(row: OpenRow): History | null {
    if (row.objective_type !== "task") return null;
    const t = this.db.prepare("SELECT attempts FROM task WHERE id = ?").get(row.objective_id) as
      | { attempts: number }
      | undefined;
    const attempts = t?.attempts ?? 0;
    if (attempts < 1) return null;

    const prev = this.db
      .prepare(
        `SELECT reason, commit_sha FROM assignment
          WHERE objective_type = 'task' AND objective_id = ? AND id <> ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(row.objective_id, row.id) as { reason: string | null; commit_sha: string | null } | undefined;

    return {
      attempts,
      reason: (prev?.reason ?? null) as History["reason"],
      commit: prev?.commit_sha ?? null,
      failures: this.failuresFor(row.objective_id),
    };
  }

  /** Every task_test that is failing, reduced to the last thing it actually said. A test
   *  with nothing to say is still worth naming: the statement is the requirement. */
  private failuresFor(task_id: number): TestFailure[] {
    const rows = this.db
      .prepare(
        `SELECT statement, last_output FROM task_test
          WHERE parent_id = ? AND state = 'failed' ORDER BY id`,
      )
      .all(task_id) as unknown as { statement: string; last_output: string | null }[];
    return rows.map((r) => ({ statement: r.statement, line: lastLine(r.last_output) }));
  }

  private async instructionFor(row: OpenRow): Promise<string> {
    if (row.objective_type === "chore") return await this.briefFor(row.objective_id);
    const table = row.objective_type;
    const col = table === "task" ? "title" : "statement";
    const r = this.db.prepare(`SELECT ${col} AS text FROM ${table} WHERE id = ?`).get(row.objective_id) as
      | { text: string }
      | undefined;
    return r?.text ?? "";
  }

  /** A chore's brief: what the work is for, and what its check is.
   *
   *  A task's instruction is its title, because the acceptance_test says what it is for. A
   *  chore has no test, so the brief has to carry both — and it says the check in words the
   *  worker can act on, rather than the one line the record stores it as. */
  private async briefFor(id: number): Promise<string> {
    const row = this.db
      .prepare(
        `SELECT c.kind AS kind, c."check" AS "check", c.target_type AS target_type,
                coalesce(s.slug, p.name, c.target_id) AS target, p.repo AS repo
           FROM chore c
           JOIN project p ON p.id = c.project_id
           LEFT JOIN story s ON s.id = c.target_id AND c.target_type = 'story'
          WHERE c.id = ?`,
      )
      .get(id) as { kind: string; check: string; target_type: string; target: string; repo: string } | undefined;
    if (row === undefined) return "";

    const what = `${row.kind} ${row.target_type} ${row.target}`;
    if (row.kind !== "merge") return `${what}. The check: ${row.check}.`;

    const branch = `story/${row.target}`;
    const base = await this.baseOf(row.repo);
    return [
      `This is a merge chore for ${branch}.`,
      `What it is for: ${branch} was delivered and will not merge into ${base}, so the merge` +
        ` has to be made by hand — a conflict is wherever the conflict is.`,
      `Merge ${base} into ${branch} in this tree, resolve every conflict, and commit the result` +
        ` on the branch.`,
      `The check: ${base} merges cleanly into ${branch} and the suite still passes.` +
        ` The record carries it as "${row.check}".`,
      `Do not commit on ${base}, and do not land anything: landing is the operator's verb.`,
    ].join("\n");
  }

  /** The base branch, asked of the repository — a brief that says "the base branch" instead
   *  of naming it leaves the worker to guess between main and master. */
  private async baseOf(repo: string): Promise<string> {
    const root = this.opts.repoRoot ?? repo;
    return await new Trees(root, this.opts.integrationBranch ?? null).integrationBranch().catch(() => "the base branch");
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

/** The last line that said anything. Runners end in blank lines and trailing newlines, and
 *  the sentence that matters is the one before them. */
function lastLine(output: string | null): string {
  if (output === null) return "";
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line !== "") return line;
  }
  return "";
}

const isLost = (seen: Observation): boolean => seen.phase === "failed" && seen.reason === "lost";
