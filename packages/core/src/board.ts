import type { DatabaseSync } from "node:sqlite";
import type { AssignmentFacts } from "./board/facts.js";
import { spend } from "./board/facts.js";
import { panels } from "./board/panels.js";
import { BUCKETS, silence as pulseSilence, throughput as pulseThroughput } from "./board/pulse.js";
import type { Row } from "./board/row.js";
import { instant, lastLine } from "./board/row.js";
import type {
  AcceptanceTestRow,
  AssignmentRow,
  ChoreRefusalRow,
  ChoreRow,
  CriteriaRow,
  EpicRow,
  LandConflictRow,
  Ledger,
  ProjectRow,
  RefusalRow,
  ReleaseRow,
  RequirementRow,
  StoryRow,
  TaskRow,
  TaskTestRow,
  WorkerRow,
} from "./board/rows.js";
import { OPEN_PHASES } from "./board/rows.js";
import { queries, table } from "./db.js";
import { scopeRefusals } from "./edit.js";
import { now, transact } from "./store.js";

/** What a row says is `board/row.ts`'s; the groups are here. Re-exported because a row and
 *  the board it is on are one idea to every caller, and `index.ts` hands both out. */
export { lastLine, type Row };

/** `board/rows.ts` holds the shape of each record, `board/walk.ts` places one under its
 *  project, `board/panels.ts` builds the groups and `board/pulse.ts` the beat. What is
 *  here is the read: the columns asked for, and the verbs a caller types. */
export { BUCKETS };
export type { AssignmentFacts, Spend } from "./board/facts.js";

export interface Board {
  readonly projects: readonly Row[];
  readonly stale: readonly Row[];
  readonly running: readonly Row[];
  readonly needs_human: readonly Row[];
  readonly queued: readonly Row[];
  readonly failed: readonly Row[];
  readonly dropped: readonly Row[];
  readonly unproven: readonly Row[];
  /** Every epic and story still open, planned and in_progress alike. Off the page for that
   *  reason: `planned` draws the half nobody has picked up and the outline draws the rest. */
  readonly open: readonly Row[];
  /** Every epic and story nobody has started — *what is next*, not *what is moving*. */
  readonly planned: readonly Row[];
  readonly delivered: readonly Row[];
  readonly unmergeable: readonly Row[];
  /** `MACHINE_SIDE`'s panels as one list, oldest first. A group like any other, so a box
   *  can name it in views.yaml — the fold is what the board draws, not a second API. */
  readonly cooking: readonly Row[];
}

/** The columns this module reads, and only those.
 *
 *  A narrow declaration is not a second copy of the schema: it is the ask, and
 *  `typed-board.test.ts` holds every list here against `PRAGMA table_info`, so a column
 *  renamed out from under the board fails a test rather than a run. The shape each is
 *  parameterised by is `board/rows.ts`'s, so the modules that are pure over a row need no
 *  database to name one. */
const projects = table<ProjectRow>("project", ["id", "name", "state", "updated_at"]);
const releases = table<ReleaseRow>("release", ["id", "project_id"]);
const epics = table<EpicRow>("epic", ["id", "release_id", "title", "state", "updated_at"]);
const stories = table<StoryRow>("story", ["id", "epic_id", "title", "state", "updated_at"]);
const requirements = table<RequirementRow>("requirement", ["id", "story_id"]);
const criteria = table<CriteriaRow>("acceptance_criteria", ["id", "requirement_id"]);
const acceptanceTests = table<AcceptanceTestRow>("acceptance_test", ["id", "parent_id", "statement", "state", "red_at_base_sha", "last_run_at", "last_output"]);
const taskTests = table<TaskTestRow>("task_test", ["id", "parent_id", "state", "last_run_at", "last_output"]);
const tasks = table<TaskRow>("task", ["id", "acceptance_test_id", "title", "role", "attempts", "max_retry", "state", "updated_at"]);
const assignments = table<AssignmentRow>("assignment", ["id", "objective_type", "objective_id", "worker_id", "worktree", "budget", "phase", "kind", "question", "last_seen", "spent", "created_at", "updated_at"]);
const workers = table<WorkerRow>("worker", ["id", "name"]);
const refusals = table<RefusalRow>("refusal", ["task_id", "why", "at", "since", "passes"]);
const chores = table<ChoreRow>("chore", ["id", "kind", "project_id", "target_type", "target_id", "state"]);
const choreRefusals = table<ChoreRefusalRow>("chore_refusal", ["chore_id", "why", "since", "passes"]);
const landConflicts = table<LandConflictRow>("land_conflict", ["story_id", "branch", "reason"]);

/** The catalogue is a table like any other, so asking whether one exists is a query. */
const catalogue = table<{ type: string; name: string }>("sqlite_master", ["type", "name"]);

/** Whether a branch merges is a fact about the repository, so the runner owns both the
 *  observation and the table it lands in — `land_conflict (story_id, branch, reason, at)`,
 *  created beside the record the way `landed_branch` and `red_at_base` are. A workspace
 *  that has never landed has no such table, which is nothing recorded rather than error. */
export const hasTable = (db: DatabaseSync, name: string): boolean =>
  queries(db).selectFrom(catalogue).select(["name"]).where("type", "=", "table").where("name", "=", name).get() !==
  null;

/** Every row the board reads, in one pass, so the groups, the fold and the pulse are all
 *  answering from the same record rather than from three reads that could disagree.
 *
 *  `chore_refusal` and `land_conflict` arrive with migrations a workspace may not have run;
 *  a table that is not there reads as no rows, which is what each group asking for it
 *  already did with the absence. */
const read = (db: DatabaseSync): Ledger => {
  const q = queries(db);
  const chored = hasTable(db, "chore_refusal");
  return {
    projects: q.selectFrom(projects).all(),
    releases: q.selectFrom(releases).all(),
    epics: q.selectFrom(epics).all(),
    stories: q.selectFrom(stories).all(),
    requirements: q.selectFrom(requirements).all(),
    criteria: q.selectFrom(criteria).all(),
    tests: q.selectFrom(acceptanceTests).all(),
    taskTests: q.selectFrom(taskTests).all(),
    tasks: q.selectFrom(tasks).all(),
    assignments: q.selectFrom(assignments).all(),
    workers: q.selectFrom(workers).select(["id", "name"]).all(),
    refusals: q.selectFrom(refusals).all(),
    chores: chored ? q.selectFrom(chores).all() : [],
    choreRefusals: chored ? q.selectFrom(choreRefusals).all() : [],
    landConflicts: hasTable(db, "land_conflict") ? q.selectFrom(landConflicts).all() : [],
  };
};

/** What the task stands refused permission to write, as a clause to hang off a detail —
 *  beside the allocator's refusal rather than in a box of its own, because "why is this
 *  not moving" wants both in one sentence. Nothing recorded is nothing said. */
const denied = (db: DatabaseSync) => (task: number): string => {
  const paths = scopeRefusals(db, task);
  return paths.length === 0 ? "" : ` · refused a write to ${paths.join(", ")}`;
};

/** What is cooking is what is stuck: a task that has given up, and work that has stopped
 *  moving with nobody holding it. Those two, and nothing else.
 *
 *  Why it is these two and not `queued`, `delivered` or `running` is argued once, in the
 *  header of board-is-two-questions.test.ts, which is where it is also held.
 *
 *  Written as `keyof Board` so a panel renamed out from under the fold is a build error
 *  rather than a box that quietly stops being folded. */
export const MACHINE_SIDE = ["stale", "failed"] as const satisfies readonly (keyof Board)[];

/** Every machine-side panel's rows in one list, oldest first, each carrying how long it has
 *  been sitting. How long is the only field that ranks rows of different kinds against each
 *  other, so it is what the fold is ordered by. */
export function cooking(db: DatabaseSync, project: number | null = null): readonly Row[] {
  return board(db, project).cooking;
}

/** `project` narrows every group but `projects` to one project's work. The projects box is
 *  how you get back out again, so it always shows the whole workspace. */
export function board(db: DatabaseSync, project: number | null = null): Board {
  return panels(read(db), project, denied(db), Date.now());
}

/** How long since anything under each project was touched, in milliseconds per project id. */
export function silence(db: DatabaseSync, asOf: number = Date.now()): ReadonlyMap<number, number> {
  return pulseSilence(read(db), asOf);
}

/** Each project's throughput as ten hourly counts of passes, oldest bucket first. */
export function throughput(db: DatabaseSync, asOf: number = Date.now()): ReadonlyMap<number, readonly number[]> {
  return pulseThroughput(read(db), asOf);
}

/** What the last pass decided about a task it did not start. One row per task, replaced
 *  each time, so the board always shows the current reason rather than a history.
 *
 *  The same reason keeps its `since`: a task refused for the same thing all morning is a
 *  different problem from one refused for a new reason a minute ago. Decided here rather
 *  than in a `CASE` inside the upsert, which the dialect does not spell, so the read and
 *  the write are one transaction. */
export function recordRefusal(db: DatabaseSync, why: string, taskId: number): void {
  const at = now();
  transact(db, () => {
    const q = queries(db);
    const held = q.selectFrom(refusals).select(["why", "since", "passes"]).where("task_id", "=", taskId).get();
    const same = held !== null && held.why === why ? held : null;
    const row: RefusalRow = { task_id: taskId, why, at, since: same === null ? at : same.since, passes: same === null ? 1 : same.passes + 1 };
    q.insertInto(refusals, row).onConflict(["task_id"], { why: row.why, at: row.at, since: row.since, passes: row.passes }).run();
  });
}

export function clearRefusal(db: DatabaseSync, taskId: number): void {
  queries(db).deleteFrom(refusals).where("task_id", "=", taskId).run();
}

export function assignmentFacts(db: DatabaseSync, id: number, asOf: number = Date.now()): AssignmentFacts | null {
  const a = queries(db).selectFrom(assignments).where("id", "=", id).get();
  if (a === null) return null;
  const since = a.last_seen === null ? NaN : instant(a.last_seen);
  return {
    worktree: a.worktree,
    budget: spend(a.budget),
    spent: spend(a.spent),
    beat: a.last_seen,
    silent: Number.isNaN(since) ? null : asOf - since,
    open: OPEN_PHASES.includes(a.phase),
  };
}

/** How many assignments hold a slot. `waiting` counts: waiting on a person is exactly the
 *  resource the attention budget exists to bound. */
export function openAssignments(db: DatabaseSync): number {
  return queries(db).selectFrom(assignments).select(["phase"]).all().filter((a) => OPEN_PHASES.includes(a.phase)).length;
}
