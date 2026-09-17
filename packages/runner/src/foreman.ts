import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  addLesson,
  BRIEF_LESSONS,
  Engine,
  lessons,
  now,
  recordScopeRefusal,
  Verbs,
  type Budget,
} from "@wecode/core";
// The dialect is core's, but core's barrel does not re-export it — `db.js` is imported by
// path so that porting this module needs no change to a file outside it.
import { queries, table, type Setters } from "@wecode/core/dist/db.js";
import { hasWriteDenials } from "./adapters/denials.js";
import { Trees } from "./git.js";
import type { History, Observation, TestFailure, WorkerAdapter, Work } from "./ports.js";

/** The tables this module reads, and only the columns it asks for.
 *
 *  Kept in one object because `task`, `story`, `chore` and `worker` are all names this file
 *  already uses for other things: a bare const would be shadowed and the shadowing would
 *  typecheck. `typed-foreman.test.ts` holds every list below against `PRAGMA table_info`,
 *  so a column renamed out from under this module fails a test rather than a tick.
 *
 *  `objective_type` is declared as its union rather than as text, which is what makes a
 *  misspelt objective a typecheck failure at every place one is compared. */
type ObjectiveType = "task" | "acceptance_test" | "task_test" | "chore";

interface AssignmentRow {
  id: number;
  objective_type: ObjectiveType;
  objective_id: number;
  worker_id: number;
  scope: string;
  budget: string;
  worktree: string;
  phase: string;
  session: string | null;
  last_seen: string | null;
  answer: string | null;
  answered_by: string | null;
  reason: string | null;
  commit_sha: string | null;
  spent: string | null;
  kind: string | null;
  question: string | null;
  options: string | null;
  updated_at: string;
}

interface TaskRow {
  id: number;
  title: string;
  acceptance_test_id: number;
  attempts: number;
  updated_at: string;
}

interface TaskTestRow {
  id: number;
  parent_id: number;
  statement: string;
  state: string;
  last_output: string | null;
}

interface ChoreRow {
  id: number;
  kind: string;
  check: string;
  target_type: string;
  target_id: number;
  project_id: number;
}

const tbl = {
  assignment: table<AssignmentRow>("assignment", [
    "id",
    "objective_type",
    "objective_id",
    "worker_id",
    "scope",
    "budget",
    "worktree",
    "phase",
    "session",
    "last_seen",
    "answer",
    "answered_by",
    "reason",
    "commit_sha",
    "spent",
    "kind",
    "question",
    "options",
    "updated_at",
  ]),
  worker: table<{ id: number; kind: string }>("worker", ["id", "kind"]),
  task: table<TaskRow>("task", ["id", "title", "acceptance_test_id", "attempts", "updated_at"]),
  taskTest: table<TaskTestRow>("task_test", ["id", "parent_id", "statement", "state", "last_output"]),
  test: table<{ id: number; parent_id: number; statement: string }>("acceptance_test", [
    "id",
    "parent_id",
    "statement",
  ]),
  criteria: table<{ id: number; requirement_id: number }>("acceptance_criteria", ["id", "requirement_id"]),
  requirement: table<{ id: number; story_id: number }>("requirement", ["id", "story_id"]),
  story: table<{ id: number; slug: string; epic_id: number }>("story", ["id", "slug", "epic_id"]),
  epic: table<{ id: number; release_id: number }>("epic", ["id", "release_id"]),
  release: table<{ id: number; project_id: number }>("release", ["id", "project_id"]),
  project: table<{ id: number; name: string; repo: string }>("project", ["id", "name", "repo"]),
  chore: table<ChoreRow>("chore", ["id", "kind", "check", "target_type", "target_id", "project_id"]),
};

/** An assignment nobody has finished with. One rule, spelled once, applied in memory: the
 *  dialect has no set-membership operator and an open assignment is a handful of rows. */
const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];

/** Where the assignments being watched live, when the foreman has to ask git something the
 *  record does not hold — the name of the base branch a merge chore's brief has to say. */
export interface ForemanOptions {
  readonly integrationBranch?: string | null;
  /** Only for tests: pretend every project lives here. */
  readonly repoRoot?: string | undefined;
}

type OpenRow = Pick<
  AssignmentRow,
  | "id"
  | "objective_type"
  | "objective_id"
  | "scope"
  | "budget"
  | "worktree"
  | "phase"
  | "session"
  | "last_seen"
  | "answer"
>;

export interface TickReport {
  readonly started: readonly number[];
  readonly advanced: readonly number[];
  readonly failed: readonly number[];
}

/** Takes an assignment and makes it real: starts the session, watches it, kills it,
 *  resumes it. It decides nothing about the work — only whether an attempt exists and how
 *  it is going. */
export class Foreman {
  /** The record's verbs, one method per transition. The engine is behind it, but nothing
   *  here names a verb as a string: an assignment moved by a misspelt word is a tick that
   *  silently does nothing, and the facade makes it a typecheck failure instead. */
  private readonly verbs: Verbs;

  constructor(
    private readonly db: DatabaseSync,
    private readonly adapters: Readonly<Record<string, WorkerAdapter>>,
    private readonly deadlineSeconds = 3600,
    private readonly opts: ForemanOptions = {},
  ) {
    this.verbs = new Verbs(new Engine(db));
  }

  private get q(): ReturnType<typeof queries> {
    return queries(this.db);
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
          if (!this.verbs.answerAssignment(row.id, "operator").ok) continue;
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

      this.recordDenials(adapter, row);

      const moved = this.record(row.id, seen);
      if (seen.phase === "failed") failed.push(row.id);
      else if (moved) advanced.push(row.id);
    }

    return { started, advanced, failed };
  }

  /** What the harness refused this attempt permission to write, carried to the record.
   *
   *  Every tick, not only at the end: the attempt may be killed, lost or timed out, and a
   *  refusal read only on a clean finish is a refusal read on exactly the passes that did
   *  not need it. Against the task, because the scope is the task's and so is the decision
   *  to widen it — an objective that is not a task has no such record to keep.
   *
   *  Recorded, never acted on. Widening a scope is the operator's verb; this is only so the
   *  board can say what was asked for instead of 'out of attempts'. */
  private recordDenials(adapter: WorkerAdapter, row: OpenRow): void {
    if (row.objective_type !== "task" || !hasWriteDenials(adapter)) return;
    const paths = adapter.takeRefusedWrites(row.id);
    if (paths.length > 0) recordScopeRefusal(this.db, row.objective_id, paths);
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
    return this.q.selectFrom(tbl.assignment).select(["phase"]).where("id", "=", id).get()?.phase ?? "";
  }

  /** Every open assignment, oldest first. The phase filter and the order are applied in
   *  memory: the dialect spells neither set membership nor an ordering, and the open rows
   *  are bounded by `max_open` rather than by the size of the record. */
  private open(): OpenRow[] {
    const rows = this.q
      .selectFrom(tbl.assignment)
      .select(["id", "objective_type", "objective_id", "scope", "budget", "worktree", "phase", "session", "last_seen", "answer"])
      .all()
      .filter((r) => OPEN_PHASES.includes(r.phase));
    rows.sort((a, b) => a.id - b.id);
    return rows;
  }

  /** The adapter for this assignment's worker, by the two reads the join was. A worker that
   *  is not there is null, which is what the inner join did with the row. */
  private adapterFor(row: OpenRow): WorkerAdapter | null {
    const a = this.q.selectFrom(tbl.assignment).select(["worker_id"]).where("id", "=", row.id).get();
    if (a === null) return null;
    const w = this.q.selectFrom(tbl.worker).select(["kind"]).where("id", "=", a.worker_id).get();
    return w === null ? null : (this.adapters[w.kind] ?? null);
  }

  private async workOf(row: OpenRow): Promise<Work> {
    const learned = this.lessonsFor(row.id);
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
      ...(learned.length > 0 ? { lessons: learned } : {}),
      history: this.historyFor(row),
    };
  }

  /** The ten newest lessons of this assignment's project, newest first — core's own reader,
   *  which owns the `lesson` table and the cap a brief carries. */
  private lessonsFor(id: number): string[] {
    const project = this.projectOf(id);
    if (project === null) return [];
    return lessons(this.db, project, BRIEF_LESSONS).map((l) => l.text);
  }

  /** What an attempt learned, kept against the project rather than the task: the thing that
   *  bought this — a worktree that could not install — was true of all three tasks that hit
   *  it. The assignment is kept too, so a suspicious lesson can be traced back. */
  private recordLesson(id: number, lesson: string): void {
    if (lesson.trim() === "") return;
    const project = this.projectOf(id);
    if (project === null) return;
    addLesson(this.db, project, lesson, id);
  }

  /** The project an assignment belongs to, by the walk up from whichever objective it has.
   *  Nothing below a project carries a project_id, so the walk is the only way to know — and
   *  a chore names its project outright, which is why it never needed the walk.
   *
   *  A broken link is null and every caller treats it as "no project", which is what the
   *  inner joins this replaced did with the row. */
  private projectOf(id: number): number | null {
    const a = this.q
      .selectFrom(tbl.assignment)
      .select(["objective_type", "objective_id"])
      .where("id", "=", id)
      .get();
    if (a === null) return null;
    const test = this.testOf(a.objective_type, a.objective_id);
    return test === null ? null : this.projectOfTest(test);
  }

  /** The acceptance_test an objective hangs off: itself, the task's, or the task's by way of
   *  the task_test's parent. A chore has none. */
  private testOf(type: ObjectiveType, id: number): number | null {
    if (type === "acceptance_test") return id;
    if (type === "task") {
      return this.q.selectFrom(tbl.task).select(["acceptance_test_id"]).where("id", "=", id).get()
        ?.acceptance_test_id ?? null;
    }
    if (type === "task_test") {
      const tt = this.q.selectFrom(tbl.taskTest).select(["parent_id"]).where("id", "=", id).get();
      return tt === null ? null : this.testOf("task", tt.parent_id);
    }
    return null;
  }

  private projectOfTest(testId: number): number | null {
    const q = this.q;
    const x = q.selectFrom(tbl.test).select(["parent_id"]).where("id", "=", testId).get();
    if (x === null) return null;
    const c = q.selectFrom(tbl.criteria).select(["requirement_id"]).where("id", "=", x.parent_id).get();
    if (c === null) return null;
    const r = q.selectFrom(tbl.requirement).select(["story_id"]).where("id", "=", c.requirement_id).get();
    if (r === null) return null;
    const s = q.selectFrom(tbl.story).select(["epic_id"]).where("id", "=", r.story_id).get();
    if (s === null) return null;
    const e = q.selectFrom(tbl.epic).select(["release_id"]).where("id", "=", s.epic_id).get();
    if (e === null) return null;
    return q.selectFrom(tbl.release).select(["project_id"]).where("id", "=", e.release_id).get()?.project_id ?? null;
  }

  /** What the last attempt at this task left on the branch.
   *
   *  Null unless this is a retry: a first attempt must be told exactly what it is told
   *  today. A retry is told what git already holds, because that is the only thing that
   *  crosses between two sessions that share no memory. */
  private historyFor(row: OpenRow): History | null {
    if (row.objective_type !== "task") return null;
    const attempts =
      this.q.selectFrom(tbl.task).select(["attempts"]).where("id", "=", row.objective_id).get()?.attempts ?? 0;
    if (attempts < 1) return null;

    // The newest earlier assignment against this task, picked in memory: the dialect spells
    // no ordering, and an id is monotonic so the highest is the latest.
    const prev = this.q
      .selectFrom(tbl.assignment)
      .select(["id", "reason", "commit_sha"])
      .where("objective_type", "=", "task")
      .where("objective_id", "=", row.objective_id)
      .all()
      .filter((a) => a.id !== row.id)
      .sort((a, b) => b.id - a.id)[0];

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
    return this.q
      .selectFrom(tbl.taskTest)
      .select(["id", "statement", "last_output"])
      .where("parent_id", "=", task_id)
      .where("state", "=", "failed")
      .all()
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ statement: r.statement, line: lastLine(r.last_output) }));
  }

  /** Each objective says what the work is in a column of its own — a task in its title, a
   *  test in its statement — so the dispatch is a branch per objective rather than a table
   *  name and a column name pasted into one query. */
  private async instructionFor(row: OpenRow): Promise<string> {
    if (row.objective_type === "chore") return await this.briefFor(row.objective_id);
    if (row.objective_type === "task") {
      return this.q.selectFrom(tbl.task).select(["title"]).where("id", "=", row.objective_id).get()?.title ?? "";
    }
    if (row.objective_type === "acceptance_test") {
      return this.q.selectFrom(tbl.test).select(["statement"]).where("id", "=", row.objective_id).get()?.statement ?? "";
    }
    return (
      this.q.selectFrom(tbl.taskTest).select(["statement"]).where("id", "=", row.objective_id).get()?.statement ?? ""
    );
  }

  /** A chore's brief: what the work is for, and what its check is.
   *
   *  A task's instruction is its title, because the acceptance_test says what it is for. A
   *  chore has no test, so the brief has to carry both — and it says the check in words the
   *  worker can act on, rather than the one line the record stores it as.
   *
   *  Each kind gets its own brief (CHORE_BRIEFS): a merge and a refresh run the same git
   *  commands for opposite reasons, and a worker told the wrong reason resolves conflicts
   *  the wrong way. */
  private async briefFor(id: number): Promise<string> {
    const row = this.q.selectFrom(tbl.chore).where("id", "=", id).get();
    if (row === null) return "";
    // The project was an inner join and the story an outer one: no project, no brief, and a
    // chore whose target is not a story falls back to the project's name.
    const project = this.q.selectFrom(tbl.project).select(["name", "repo"]).where("id", "=", row.project_id).get();
    if (project === null) return "";
    const story =
      row.target_type === "story"
        ? this.q.selectFrom(tbl.story).select(["slug"]).where("id", "=", row.target_id).get()
        : null;
    const target = story?.slug ?? project.name ?? String(row.target_id);

    const write = CHORE_BRIEFS[row.kind] ?? anyChore;
    return [
      ...write({
        kind: row.kind,
        check: row.check,
        target_type: row.target_type,
        target,
        branch: `story/${target}`,
        base: await this.baseOf(project.repo),
      }),
      NO_TESTS,
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
      this.verbs.startAssignment(id, "foreman");
    }

    // Every branch below writes the same three columns, so they are written once here.
    const write = (sets: Setters<AssignmentRow>): void => {
      this.q
        .update(tbl.assignment)
        .set({ ...sets, last_seen: at, spent, updated_at: at })
        .where("id", "=", id)
        .run();
    };

    if (seen.phase === "running") {
      write({ session: seen.session });
      return this.phaseOf(id) === "running";
    }

    if (seen.phase === "waiting") {
      write({
        session: seen.session,
        kind: seen.kind,
        question: seen.question,
        options: JSON.stringify(seen.options),
        answer: null,
        answered_by: null,
      });
      return this.verbs.askAssignment(id, "foreman").ok;
    }

    if (seen.phase === "succeeded") {
      // `coalesce(?, session)` was what kept a session the adapter did not name: an
      // adapter that says nothing leaves the column alone rather than clearing it.
      write({ ...(seen.session === null ? {} : { session: seen.session }), commit_sha: seen.commit });
      const ok = this.verbs.finishAssignment(id, "foreman").ok;
      if (ok) this.countAttempt(id);
      return ok;
    }

    write({ reason: seen.reason });
    const out = this.verbs.failAssignment(id, "foreman").ok;
    if (out) this.countAttempt(id);
    return out;
  }

  /** Every attempt counts, whatever phase it ended in.
   *
   *  A session can exit cleanly having proved nothing — the first live run did exactly
   *  that — so counting only failures lets a task be retried forever. One attempt does not
   *  fail a task; the retry limit does. Counting is the foreman's, deciding is not. */
  private countAttempt(id: number): void {
    const a = this.q
      .selectFrom(tbl.assignment)
      .select(["objective_type", "objective_id"])
      .where("id", "=", id)
      .get();
    if (a === null || a.objective_type !== "task") return;
    // Read then write, because the dialect assigns values and not expressions. Safe where
    // the increment was: one runner holds the lease, and this is inside its tick.
    const t = this.q.selectFrom(tbl.task).select(["attempts"]).where("id", "=", a.objective_id).get();
    if (t === null) return;
    this.q
      .update(tbl.task)
      .set({ attempts: t.attempts + 1, updated_at: now() })
      .where("id", "=", a.objective_id)
      .run();
  }
}

const zero = (): Budget => ({ tokens: 0, seconds: 0 });

/** What a brief has to say a chore in words, gathered once so a kind's own brief is a
 *  function of it and not a second set of queries. */
interface BriefContext {
  readonly kind: string;
  readonly check: string;
  readonly target_type: string;
  readonly target: string;
  /** The story branch, when the target is a story. */
  readonly branch: string;
  readonly base: string;
}

/** The line every chore brief ends on.
 *
 *  A worker's standing instruction is to write the tests that prove its work, which is
 *  right for a task and wrong for a chore: a chore proves no acceptance_test, and a test
 *  written to assert a merge happened pins this merge rather than any requirement. The
 *  brief countermands it, because the brief is the only half of the prompt a chore owns. */
const NO_TESTS =
  "Write no new tests: this is a chore, not a task, and its check is the one named above." +
  " Run the suite that already exists.";

/** One brief per kind — a table, so a new kind is a row here beside its row in
 *  CHORE_KIND_DEFS, rather than another branch in a widening conditional. Each says what
 *  the work is for, what to do, what the check is, and what not to touch, in that order:
 *  a worker that reads only the first line still knows what it is looking at. */
const CHORE_BRIEFS: Readonly<Record<string, (c: BriefContext) => string[]>> = {
  merge: (c) => [
    `This is a merge chore for ${c.branch}.`,
    `What it is for: ${c.branch} was delivered and will not merge into ${c.base}, so the merge` +
      ` has to be made by hand — a conflict is wherever the conflict is.`,
    `Merge ${c.base} into ${c.branch} in this tree, resolve every conflict, and commit the result` +
      ` on the branch.`,
    `The check: ${c.base} merges cleanly into ${c.branch} and the suite still passes.` +
      ` The record carries it as "${c.check}".`,
    `Do not commit on ${c.base}, and do not land anything: landing is the operator's verb.`,
  ],
  refresh: (c) => [
    `This is a refresh chore for ${c.branch}.`,
    `What it is for: ${c.branch} is still in flight and has fallen behind ${c.base}, so the work` +
      ` on it is being built against a base that has moved.`,
    `Merge ${c.base} into ${c.branch} in this tree, resolve every conflict, and commit the result` +
      ` on the branch. Keep the story's own work — this brings the base in, it does not undo` +
      ` what the story has done so far.`,
    `The check: ${c.branch} is no longer behind ${c.base} and the suite still passes.` +
      ` The record carries it as "${c.check}".`,
    `The story is not finished and it is not yours to finish: change nothing beyond what the` +
      ` merge needs, and do not land anything.`,
  ],
  sweep: (c) => [
    `This is a sweep chore for ${c.target_type} ${c.target}.`,
    `What it is for: the record holds work that no longer matches the world, and a person has` +
      ` already approved putting it right.`,
    `Bring the record into line with what is actually true, and change nothing else.`,
    `The check: ${c.check}.`,
    `Only what the check names is in scope. If the right answer needs a decision, say so and` +
      ` stop rather than guessing.`,
  ],
};

/** A kind with no brief of its own still gets a usable one: what it is, and its check as
 *  the record stores it. A missing row is a gap in this table, not in the chore. */
const anyChore = (c: BriefContext): string[] => [
  `${c.kind} ${c.target_type} ${c.target}. The check: ${c.check}.`,
];

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
