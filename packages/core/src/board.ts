import type { DatabaseSync } from "node:sqlite";
import { queries, table } from "./db.js";
import { scopeRefusals } from "./edit.js";
import { now, transact } from "./store.js";

/** The board's groups. Each is a filter over the same record — see docs/design/01. */
export interface Row {
  readonly id: number;
  readonly what: string;
  readonly state: string;
  readonly detail: string;
}

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
 *  renamed out from under the board fails a test rather than a run. */
interface ProjectRow {
  id: number;
  name: string;
  state: string;
  updated_at: string;
}
const projects = table<ProjectRow>("project", ["id", "name", "state", "updated_at"]);

const releases = table<{ id: number; project_id: number }>("release", ["id", "project_id"]);

interface EpicRow {
  id: number;
  release_id: number;
  title: string;
  state: string;
  updated_at: string;
}
const epics = table<EpicRow>("epic", ["id", "release_id", "title", "state", "updated_at"]);

interface StoryRow {
  id: number;
  epic_id: number;
  title: string;
  state: string;
  updated_at: string;
}
const stories = table<StoryRow>("story", ["id", "epic_id", "title", "state", "updated_at"]);

const requirements = table<{ id: number; story_id: number }>("requirement", ["id", "story_id"]);

const criteria = table<{ id: number; requirement_id: number }>("acceptance_criteria", ["id", "requirement_id"]);

interface AcceptanceTestRow {
  id: number;
  parent_id: number;
  statement: string;
  state: string;
  red_at_base_sha: string | null;
  last_run_at: string | null;
  last_output: string | null;
}
const acceptanceTests = table<AcceptanceTestRow>("acceptance_test", ["id", "parent_id", "statement", "state", "red_at_base_sha", "last_run_at", "last_output"]);

interface TaskTestRow {
  id: number;
  parent_id: number;
  state: string;
  last_run_at: string | null;
  last_output: string | null;
}
const taskTests = table<TaskTestRow>("task_test", ["id", "parent_id", "state", "last_run_at", "last_output"]);

interface TaskRow {
  id: number;
  acceptance_test_id: number;
  title: string;
  role: string;
  attempts: number;
  max_retry: number;
  state: string;
  updated_at: string;
}
const tasks = table<TaskRow>("task", ["id", "acceptance_test_id", "title", "role", "attempts", "max_retry", "state", "updated_at"]);

interface AssignmentRow {
  id: number;
  objective_type: string;
  objective_id: number;
  worker_id: number | null;
  worktree: string;
  budget: string | null;
  phase: string;
  kind: string | null;
  question: string | null;
  last_seen: string | null;
  spent: string | null;
  created_at: string;
  updated_at: string;
}
const assignments = table<AssignmentRow>("assignment", ["id", "objective_type", "objective_id", "worker_id", "worktree", "budget", "phase", "kind", "question", "last_seen", "spent", "created_at", "updated_at"]);

const workers = table<{ id: number; name: string }>("worker", ["id", "name"]);

interface RefusalRow {
  task_id: number;
  why: string;
  at: string;
  since: string;
  passes: number;
}
const refusals = table<RefusalRow>("refusal", ["task_id", "why", "at", "since", "passes"]);

interface ChoreRow {
  id: number;
  kind: string;
  project_id: number;
  target_type: string;
  target_id: number;
  state: string;
}
const chores = table<ChoreRow>("chore", ["id", "kind", "project_id", "target_type", "target_id", "state"]);

const choreRefusals = table<{ chore_id: number; why: string; since: string; passes: number }>("chore_refusal", ["chore_id", "why", "since", "passes"]);

const landConflicts = table<{ story_id: number; branch: string; reason: string }>("land_conflict", ["story_id", "branch", "reason"]);

/** The catalogue is a table like any other, so asking whether one exists is a query. */
const catalogue = table<{ type: string; name: string }>("sqlite_master", ["type", "name"]);

/** Whether a branch merges is a fact about the repository, so the runner owns both the
 *  observation and the table it lands in — `land_conflict (story_id, branch, reason, at)`,
 *  created beside the record the way `landed_branch` and `red_at_base` are. A workspace
 *  that has never landed has no such table, which is nothing recorded rather than error. */
export const hasTable = (db: DatabaseSync, name: string): boolean =>
  queries(db).selectFrom(catalogue).select(["name"]).where("type", "=", "table").where("name", "=", name).get() !==
  null;

/** An assignment nobody has finished with. One list, matched in TypeScript, rather than
 *  the four copies of the same three phase names that four SQL strings held. */
const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];

/** SQLite's `julianday` reads a bare timestamp as UTC where `Date.parse` reads it as local
 *  time. The record writes ISO-8601 with a Z, but a hand-edited row may not, so the Z is
 *  supplied rather than assumed. */
const instant = (at: string): number => Date.parse(/([Zz]|[+-]\d\d:?\d\d)$/.test(at) ? at : `${at}Z`);

/** `(julianday('now') - julianday(at)) * 1440` — minutes, unrounded, as the threshold on a
 *  waiting assignment compares them. An unparseable timestamp is no elapsed time at all:
 *  the arithmetic was NULL, and a NULL detail is a row the cockpit cannot draw. */
const elapsed = (at: string, asOf: number): number => {
  const then = instant(at);
  return Number.isNaN(then) ? 0 : (asOf - then) / 60000;
};

/** And `cast(… AS int)` over it: SQLite truncates towards zero, and so does this. */
const minutes = (at: string, asOf: number): number => Math.trunc(elapsed(at, asOf));

/** `coalesce(json_extract(a.spent, '$.tokens'), 0) / 1000`, divided the way SQLite divides
 *  it: two integers truncate. Malformed JSON reads as nothing spent — a board that throws
 *  on one bad row is no board at all. */
const thousands = (spent: string | null): number => {
  let tokens: unknown = null;
  try {
    tokens = spent === null ? null : (JSON.parse(spent) as { tokens?: unknown }).tokens;
  } catch {
    tokens = null;
  }
  const n = typeof tokens === "number" ? tokens : 0;
  return Number.isInteger(n) ? Math.trunc(n / 1000) : n / 1000;
};

/** A row per id, for the lookups that used to be joins. */
const index = <T, V>(rows: readonly T[], id: (r: T) => number, value: (r: T) => V): Map<number, V> =>
  new Map(rows.map((r) => [id(r), value(r)]));

const step = (m: Map<number, number>, id: number | null): number | null =>
  id === null ? null : (m.get(id) ?? null);

const byId = (a: Row, b: Row): number => a.id - b.id;

/** The project a row belongs to. Every group but `projects` hangs somewhere under a project,
 *  and the walk up is the only way to know which: nothing below a project carries a
 *  project_id, so nothing can disagree with it.
 *
 *  A Map per level rather than the five nested subqueries this replaces: the dialect spells
 *  no join, and the same five steps are taken for every row of every group, so the levels
 *  are read once. A step that finds nothing is `null`, as a subquery over no rows was.
 *
 *  Each method takes the id of the thing named, so `ofStory` is given a story. The strings
 *  it replaces did not hold to that — `ofStory` read `FROM epic e WHERE e.id = ${id}` while
 *  every caller handed it a story id, so a narrowed board placed a story by whichever epic
 *  happened to share its id. Typed maps cannot express that: `storyEpic` is keyed by story
 *  and `epicRelease` by epic, and handing one to the other does not compile. */
class Walk {
  private readonly releaseProject: Map<number, number>;
  private readonly epicRelease: Map<number, number>;
  private readonly storyEpic: Map<number, number>;
  private readonly requirementStory: Map<number, number>;
  private readonly criteriaRequirement: Map<number, number>;
  private readonly testCriteria: Map<number, number>;
  private readonly taskTest: Map<number, number>;
  private readonly taskTestTask: Map<number, number>;

  constructor(db: DatabaseSync, epicRows: readonly EpicRow[], storyRows: readonly StoryRow[], taskRows: readonly TaskRow[], testRows: readonly AcceptanceTestRow[]) {
    const q = queries(db);
    const id = <T extends { id: number }>(r: T): number => r.id;
    this.releaseProject = index(q.selectFrom(releases).all(), id, (r) => r.project_id);
    this.epicRelease = index(epicRows, id, (e) => e.release_id);
    this.storyEpic = index(storyRows, id, (s) => s.epic_id);
    this.requirementStory = index(q.selectFrom(requirements).all(), id, (r) => r.story_id);
    this.criteriaRequirement = index(q.selectFrom(criteria).all(), id, (c) => c.requirement_id);
    this.testCriteria = index(testRows, id, (t) => t.parent_id);
    this.taskTest = index(taskRows, id, (t) => t.acceptance_test_id);
    this.taskTestTask = index(q.selectFrom(taskTests).select(["id", "parent_id"]).all(), id, (t) => t.parent_id);
  }

  ofRelease(release: number | null): number | null {
    return step(this.releaseProject, release);
  }
  ofEpic(epic: number | null): number | null {
    return this.ofRelease(step(this.epicRelease, epic));
  }
  ofStory(story: number | null): number | null {
    return this.ofEpic(step(this.storyEpic, story));
  }
  ofCriteria(c: number | null): number | null {
    return this.ofStory(step(this.requirementStory, step(this.criteriaRequirement, c)));
  }
  ofTest(test: number | null): number | null {
    return this.ofCriteria(step(this.testCriteria, test));
  }
  ofTask(task: number | null): number | null {
    return this.ofTest(step(this.taskTest, task));
  }
  ofTaskTest(test: number | null): number | null {
    return this.ofTask(step(this.taskTestTask, test));
  }

  /** An assignment's project is its objective's, whichever of the three kinds it is. A
   *  fourth kind has no project here, which is what a `CASE` with no `ELSE` said too. */
  ofAssignment(a: AssignmentRow): number | null {
    if (a.objective_type === "task") return this.ofTask(a.objective_id);
    if (a.objective_type === "acceptance_test") return this.ofTest(a.objective_id);
    if (a.objective_type === "task_test") return this.ofTaskTest(a.objective_id);
    return null;
  }

  /** The story a task is under, for the two groups that count tasks per story. */
  storyOfTask(task: number | null): number | null {
    return step(
      this.requirementStory,
      step(this.criteriaRequirement, step(this.testCriteria, step(this.taskTest, task))),
    );
  }
}

/** The one line of a test's output worth carrying. A failing runner says why on its last
 *  line — the assertion, the exception, the exit status — and everything above it is the
 *  part you only need once you have decided to go and look. Output ends in blank lines far
 *  more often than not, so the last *non-blank* line is the one meant here. */
const WIDTH = 120;
export function lastLine(output: string | null | undefined): string {
  if (output === null || output === undefined) return "";
  const line = output
    .split("\n")
    .map((l) => l.trimEnd())
    .findLast((l) => l.trim() !== "");
  if (line === undefined) return "";
  const trimmed = line.trim();
  return trimmed.length > WIDTH ? `${trimmed.slice(0, WIDTH - 1)}…` : trimmed;
}

/** `ORDER BY last_run_at DESC, id DESC`. NULL is SQLite's smallest value, so a test that
 *  has never run sorts last under DESC. */
const newestRun = (a: TaskTestRow, b: TaskTestRow): number => {
  if (a.last_run_at !== b.last_run_at) {
    if (a.last_run_at === null) return 1;
    if (b.last_run_at === null) return -1;
    return a.last_run_at < b.last_run_at ? 1 : -1;
  }
  return b.id - a.id;
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

/** A cooking row and the instant it has last moved, off its own record.
 *
 *  Beside the row rather than on it: a field only the fold reads has no business on what
 *  the cockpit draws, and the instant cannot be looked up by id afterwards — an epic and a
 *  story can share one, and `stale` alone gathers rows from four tables. */
interface Aged {
  readonly since: string;
  readonly row: Row;
}

/** Oldest first: the smallest instant, then by id, so a tick with nothing moving draws the
 *  same list twice. A row the record cannot date sorts last — reading an unparseable
 *  timestamp as *now* would put it at the head, which is the one place a person looks. */
const sat = (a: Aged): number => {
  const then = instant(a.since);
  return Number.isNaN(then) ? Number.POSITIVE_INFINITY : then;
};
const oldestFirst = (a: Aged, b: Aged): number => {
  const x = sat(a);
  const y = sat(b);
  return x === y ? a.row.id - b.row.id : x - y;
};

/** The age leads the detail, so it is a column the eye can run down a list whose rows are
 *  otherwise four kinds of thing. A panel whose detail already says the same minutes does
 *  not say them twice; one that says a different number keeps it, being about something
 *  else. */
const withAge = (a: Aged, asOf: number): Row => {
  const age = `${minutes(a.since, asOf)}m`;
  const detail = a.row.detail.replace(new RegExp(` · ${age}(?= · |$)`), "");
  return { ...a.row, detail: detail === "" ? age : `${age} · ${detail}` };
};

/** Every machine-side panel's rows in one list, oldest first, each carrying how long it has
 *  been sitting. How long is the only field that ranks rows of different kinds against each
 *  other, so it is what the fold is ordered by. */
export function cooking(db: DatabaseSync, project: number | null = null): readonly Row[] {
  return snapshot(db, project).groups.cooking;
}

/** `project` narrows every group but `projects` to one project's work. The projects box is
 *  how you get back out again, so it always shows the whole workspace. */
export function board(db: DatabaseSync, project: number | null = null): Board {
  return snapshot(db, project).groups;
}

/** How long since anything under each project was touched, in milliseconds per project id.
 *
 *  A project's beat, and the one part of its pulse the board's groups cannot answer: three
 *  empty boxes say both *nothing to do* and *nobody has looked since Tuesday*, and this is
 *  what tells them apart. Nothing below a project carries a project_id, so what moved under
 *  it is knowable only by the same walk up that places every row.
 *
 *  A project nothing can date is absent rather than zero — an unreadable timestamp is no
 *  evidence of a beat, the way it is no evidence of age in the fold. */
export function silence(db: DatabaseSync, asOf: number = Date.now()): ReadonlyMap<number, number> {
  const q = queries(db);
  const epicRows = q.selectFrom(epics).all();
  const storyRows = q.selectFrom(stories).all();
  const taskRows = q.selectFrom(tasks).all();
  const walk = new Walk(db, epicRows, storyRows, taskRows, q.selectFrom(acceptanceTests).all());
  const beat = new Map<number, string>();
  const felt = (project: number | null, at: string): void => {
    if (project === null) return;
    const held = beat.get(project);
    if (held === undefined || held < at) beat.set(project, at);
  };
  for (const e of epicRows) felt(walk.ofEpic(e.id), e.updated_at);
  for (const s of storyRows) felt(walk.ofStory(s.id), s.updated_at);
  for (const t of taskRows) felt(walk.ofTask(t.id), t.updated_at);
  for (const a of q.selectFrom(assignments).all()) felt(walk.ofAssignment(a), a.updated_at);
  const since = ([project, at]: [number, string]): [number, number][] => {
    const then = instant(at);
    return Number.isNaN(then) ? [] : [[project, Math.max(0, asOf - then)]];
  };
  return new Map([...beat].flatMap(since));
}

/** How many blocks the pulse's sparkline draws, and how wide one of them is — design.yaml. */
export const BUCKETS = 10;
const HOUR = 3_600_000;

/** Each project's throughput as ten hourly counts of passes, oldest bucket first.
 *
 *  A pass is the only unit of progress the ledger timestamps: `last_run_at` on a test row
 *  that reached `passed`. Both kinds count — an acceptance test and a task test are each a
 *  thing that was red and is now green — and each is placed under its project by the same
 *  walk up that places every row of the board.
 *
 *  Every project has a series, all zeroes when nothing passed. That is the opposite of
 *  `silence`, which leaves out a project it cannot date, and for the opposite reason: no
 *  pass in ten hours is a fact about the project, where an unreadable beat is no evidence
 *  either way. A run older than the window, one stamped in the future, and one nothing can
 *  parse are all equally no evidence of a pass, and none of them reaches a bucket.
 *
 *  Ten hours rather than ten of anything else because the rate beside the sparkline is per
 *  hour: one block is one hour, so the last block and the rate are the same number. */
export function throughput(db: DatabaseSync, asOf: number = Date.now()): ReadonlyMap<number, readonly number[]> {
  const q = queries(db);
  const testRows = q.selectFrom(acceptanceTests).all();
  const walk = new Walk(db, q.selectFrom(epics).all(), q.selectFrom(stories).all(), q.selectFrom(tasks).all(), testRows);
  const series = new Map<number, number[]>();
  for (const p of q.selectFrom(projects).all()) series.set(p.id, Array<number>(BUCKETS).fill(0));
  const count = (project: number | null, state: string, ranAt: string | null): void => {
    if (project === null || state !== "passed" || ranAt === null) return;
    const ago = asOf - instant(ranAt);
    if (Number.isNaN(ago)) return;
    const bucket = BUCKETS - 1 - Math.floor(ago / HOUR);
    const row = bucket < 0 || bucket >= BUCKETS ? undefined : series.get(project);
    if (row !== undefined) row[bucket] = (row[bucket] ?? 0) + 1;
  };
  for (const t of testRows) count(walk.ofTest(t.id), t.state, t.last_run_at);
  for (const t of q.selectFrom(taskTests).all()) count(walk.ofTaskTest(t.id), t.state, t.last_run_at);
  return series;
}

/** The board and the fold are one query: the machine-side panels record each row's
 *  age as they build it, and `cooking` is that record sorted. Computing them apart would be
 *  two reads of the same tables that could disagree about what is on the board. */
function snapshot(
  db: DatabaseSync,
  project: number | null,
): { groups: Board; aged: readonly Aged[]; asOf: number } {
  const q = queries(db);
  const asOf = Date.now();

  const epicRows = q.selectFrom(epics).all();
  const storyRows = q.selectFrom(stories).all();
  const taskRows = q.selectFrom(tasks).all();
  const testRows = q.selectFrom(acceptanceTests).all();
  const taskTestRows = q.selectFrom(taskTests).all();
  const assignmentRows = q.selectFrom(assignments).all();
  const walk = new Walk(db, epicRows, storyRows, taskRows, testRows);

  /** Recorded as each machine-side panel builds its row, and returned untouched, so the
   *  panels stay exactly the shape they were and the fold still knows every row's age. */
  const aged: Aged[] = [];
  const cook = <R extends Row>(since: string, row: R): R => {
    aged.push({ since, row });
    return row;
  };

  /** No project asked for is every project: the predicate is true for every row. */
  const only = (of: number | null): boolean => project === null || of === project;

  /** Like `only`, but a row the walk cannot place is shown on every board rather than on
   *  none. Used by the queue alone: a missing link anywhere above a task took it off the
   *  narrowed board while the allocator, which never walks up, went on dispatching it, and
   *  an empty queue beside a busy runner is the one absence read as there being no work. */
  const placed = (of: number | null): boolean => only(of) || of === null;

  const refusalOf = index(q.selectFrom(refusals).all(), (f) => f.task_id, (f) => f);
  const titleOf = index(taskRows, (t) => t.id, (t) => t.title);
  const nameOf = index(q.selectFrom(workers).select(["id", "name"]).all(), (w) => w.id, (w) => w.name);
  const testById = index(testRows, (t) => t.id, (t) => t);
  const storyById = index(storyRows, (s) => s.id, (s) => s);

  /** What the task stands refused permission to write, as a clause to hang off a detail —
   *  beside the allocator's refusal rather than in a box of its own, because "why is this
   *  not moving" wants both in one sentence. Nothing recorded is nothing said. */
  const denied = (task: number): string => {
    const paths = scopeRefusals(db, task);
    return paths.length === 0 ? "" : ` · refused a write to ${paths.join(", ")}`;
  };

  /** Ready, and nothing open is attempting it. A set difference rather than a `NOT EXISTS`:
   *  the dialect spells neither, and the set is the same one for every group that asks. */
  const attempted = new Set(
    assignmentRows
      .filter((a) => a.objective_type === "task" && OPEN_PHASES.includes(a.phase))
      .map((a) => a.objective_id),
  );

  /** `coalesce(t.title, a.objective_type || ' #' || a.objective_id)` — the LEFT JOIN only
   *  reached a task when the objective was one. */
  const objective = (a: AssignmentRow): string =>
    (a.objective_type === "task" ? titleOf.get(a.objective_id) : undefined) ??
    `${a.objective_type} #${a.objective_id}`;

  /** Tasks under a story, and how many of them are done. */
  const perStory = new Map<number, { done: number; all: number }>();
  for (const t of taskRows) {
    const s = walk.storyOfTask(t.id);
    if (s === null) continue;
    const count = perStory.get(s) ?? { done: 0, all: 0 };
    perStory.set(s, { done: count.done + (t.state === "done" ? 1 : 0), all: count.all + 1 });
  }

  /** Stories under a project, and how many of them are delivered. */
  const perProject = new Map<number, { delivered: number; all: number }>();
  for (const s of storyRows) {
    const p = walk.ofStory(s.id);
    if (p === null) continue;
    const count = perProject.get(p) ?? { delivered: 0, all: 0 };
    perProject.set(p, {
      delivered: count.delivered + (s.state === "delivered" ? 1 : 0),
      all: count.all + 1,
    });
  }

  /** A chore the last pass could not dispatch, said beside the tasks it could not start.
   *
   *  Same shape and same wording as a task's: "why has nothing moved" does not care which
   *  id space the answer is in. A chore carries its project_id, so no walk up is needed.
   *
   *  No `passes >= 3` here, unlike a task's: a queued task says its reason in `queued`, and
   *  a chore has no such box, so the first pass that refuses it is the first chance anyone
   *  has to read why.
   *
   *  `chore_refusal` arrives with the chore migration; a workspace older than it has no
   *  such table, which is nothing recorded against the board rather than an error. */
  const staleChores = (): Row[] => {
    if (!hasTable(db, "chore_refusal")) return [];
    const why = index(q.selectFrom(choreRefusals).all(), (f) => f.chore_id, (f) => f);
    return q
      .selectFrom(chores)
      .all()
      .filter((c) => c.state !== "done" && c.state !== "running" && only(c.project_id))
      .flatMap((c) => {
        const f = why.get(c.id);
        return f === undefined
          ? []
          : [
              cook(f.since, {
                id: c.id,
                what: `${c.kind} ${c.target_type} #${c.target_id}`,
                state: c.state,
                detail: `${f.why} · ${f.passes} passes · ${minutes(f.since, asOf)}m`,
              }),
            ];
      });
  };

  /** A count of attempts says a task failed; it never says what failed. The last line of
   *  the red test's output is the smallest thing that does, so it is carried here rather
   *  than left for a `wecode show` on a test whose id you first have to find. */
  const failure = (t: TaskRow): string | null => {
    const own = taskTestRows
      .filter((tt) => tt.parent_id === t.id && tt.state === "failed" && tt.last_output !== null)
      .sort(newestRun)[0];
    if (own !== undefined) return own.last_output;
    const at = testById.get(t.acceptance_test_id);
    return at !== undefined && at.state === "failed" ? at.last_output : null;
  };

  const panels: Omit<Board, "cooking"> = {
    // What exists, with how much of it is finished — without which a board with nothing in
    // flight reads the same as a board with no project at all.
    projects: q
      .selectFrom(projects)
      .all()
      .map((p) => {
        const count = perProject.get(p.id) ?? { delivered: 0, all: 0 };
        return {
          id: p.id,
          what: p.name,
          state: p.state,
          detail: `${count.delivered}/${count.all} stories`,
        };
      })
      .sort(byId),
    // Nothing is moving it, and nothing is going to. Derived rather than a state: the
    // moment staleness becomes a column somebody has to keep it in agreement with the
    // world. Read from what the allocator recorded, not guessed: it is the only thing that
    // knows why a ready task did not become an assignment.
    stale: [
      ...taskRows.flatMap((t) => {
        const f = refusalOf.get(t.id);
        if (t.state !== "ready" || f === undefined || f.passes < 3) return [];
        if (!only(walk.ofTask(t.id)) || attempted.has(t.id)) return [];
        return [
          cook(f.since, {
            id: t.id,
            what: t.title,
            state: "ready",
            detail: `${f.why} · ${f.passes} passes · ${minutes(f.since, asOf)}m${denied(t.id)}`,
          }),
        ];
      }),
      ...assignmentRows
        .filter((a) => a.phase === "waiting" && only(walk.ofAssignment(a)) && elapsed(a.updated_at, asOf) > 15)
        .map((a) =>
          cook(a.updated_at, {
            id: a.id,
            what: objective(a),
            state: "waiting",
            detail: `waiting on you · ${minutes(a.updated_at, asOf)}m`,
          }),
        ),
      ...staleChores(),
      ...storyRows
        .filter((s) => s.state === "in_progress" && only(walk.ofStory(s.id)) && !perStory.has(s.id))
        .map((s) => cook(s.updated_at, { id: s.id, what: s.title, state: s.state, detail: "no work under it" })),
    ].sort(byId),
    // pending counts: a worktree is cut and a session is starting. Leaving it out made the
    // board say nothing was running while an agent was working.
    //
    // Not `cook`ed: this panel is off the fold — see MACHINE_SIDE — so its rows record no
    // age, and `cooking` never sees them.
    running: assignmentRows
      .filter((a) => (a.phase === "pending" || a.phase === "running") && only(walk.ofAssignment(a)))
      .map((a) => ({
        id: a.id,
        what: objective(a),
        state: a.phase,
        detail: `${(a.worker_id === null ? undefined : nameOf.get(a.worker_id)) ?? "?"} · ${minutes(a.created_at, asOf)}m · ${thousands(a.spent)}k`,
      }))
      .sort(byId),
    needs_human: assignmentRows
      .filter((a) => a.phase === "waiting" && only(walk.ofAssignment(a)))
      .map((a) => ({
        id: a.id,
        what: `${a.objective_type} #${a.objective_id}`,
        state: a.kind ?? "input",
        detail: a.question ?? "",
      }))
      .sort(byId),
    // ready, and nothing open is attempting it: the queue is what waits on a slot. The
    // same condition `readyCandidates` dispatches on and nothing more — a second opinion
    // here would be a task the allocator takes and the board never shows. The detail is
    // why it is not running: the last pass's refusal, or its role.
    //
    // Not `cook`ed: waiting for a slot is not being stuck — see MACHINE_SIDE. If it has
    // also stopped moving, `stale` says so and the fold has it from there.
    queued: taskRows
      .filter((t) => t.state === "ready" && placed(walk.ofTask(t.id)) && !attempted.has(t.id))
      .map((t) => ({
        id: t.id,
        what: t.title,
        state: t.state,
        detail: `${refusalOf.get(t.id)?.why ?? t.role}${denied(t.id)}`,
      }))
      .sort(byId),
    // Work that stopped because its attempts ran out, or because a pass is still owed to
    // it. Abandoned work is not here: dropped wants nothing from anyone, an exhausted task
    // waits for a person to retry it or drop it, and one box for both made a triage of ten
    // rows say nothing about which was which.
    failed: taskRows
      .filter((t) => t.state === "failed" && only(walk.ofTask(t.id)))
      .map((t) => {
        const detail =
          t.attempts >= t.max_retry
            ? `out of attempts · ${t.attempts} of ${t.max_retry}${denied(t.id)} · retry it with a reason, or drop it`
            : `attempts ${t.attempts}/${t.max_retry}${denied(t.id)}`;
        const why = lastLine(failure(t));
        return cook(t.updated_at, {
          id: t.id,
          what: t.title,
          state: t.state,
          detail: why === "" ? detail : `${detail} · ${why}`,
        });
      })
      .sort(byId),
    // Put down on purpose, under its own name, so nothing reading `failed` has to carry
    // the reason to tell the two apart.
    dropped: taskRows
      .filter((t) => t.state === "dropped" && only(walk.ofTask(t.id)))
      .map((t) => ({ id: t.id, what: t.title, state: t.state, detail: "dropped by decision" }))
      .sort(byId),
    // Ready to run, but nobody has watched it fail — so passing it would prove nothing. A
    // group rather than a state: red is an observation, and the test is otherwise an
    // ordinary ready test. These are what `test_has_been_red` will refuse.
    unproven: testRows
      .filter((t) => t.state === "ready" && t.red_at_base_sha === null && only(walk.ofTest(t.id)))
      .map((t) => ({ id: t.id, what: t.statement, state: t.state, detail: "no red run recorded" }))
      .sort(byId),
    // Waiting to land, which is a move somebody still owes it rather than a fault — so it
    // is a box of its own and is not `cook`ed into the fold. Newest first: the story just
    // delivered is the one whose landing is next.
    delivered: storyRows
      .filter((s) => s.state === "delivered" && only(walk.ofStory(s.id)))
      .sort((a, b) => (a.updated_at === b.updated_at ? 0 : a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, 20)
      .map((s) => ({ id: s.id, what: s.title, state: s.state, detail: "story" })),
    // Delivered, and the last thing that tried to land it could not. A filter rather than
    // a state: the story stays delivered — what is wrong is between its branch and master,
    // and only the thing holding a repository can see it.
    unmergeable: !hasTable(db, "land_conflict")
      ? []
      : q
          .selectFrom(landConflicts)
          .all()
          .flatMap((c) => {
            const s = storyById.get(c.story_id);
            if (s === undefined || s.state !== "delivered" || !only(walk.ofStory(s.id))) return [];
            return [{ id: s.id, what: s.title, state: s.state, detail: `${c.branch} · ${c.reason}` }];
          })
          .sort(byId),
    // Written down and not begun: the half of `open` a person reads when asking what to
    // pick up. The detail is the kind and nothing else — a planned story has no progress to
    // report, and `entityOf` in the cockpit reads the word to know which table to open.
    planned: [
      ...epicRows
        .filter((e) => e.state === "planned" && only(walk.ofRelease(e.release_id)))
        .map((e) => ({ id: e.id, what: e.title, state: e.state, detail: "epic" })),
      ...storyRows
        .filter((s) => s.state === "planned" && only(walk.ofStory(s.id)))
        .map((s) => ({ id: s.id, what: s.title, state: s.state, detail: "story" })),
    ].sort((a, b) => (a.detail === b.detail ? a.id - b.id : a.detail < b.detail ? -1 : 1)),
    // A story carries how far it has got: tasks done out of tasks that exist.
    open: [
      ...epicRows
        .filter((e) => !["delivered", "dropped"].includes(e.state) && only(walk.ofRelease(e.release_id)))
        .map((e) => ({ id: e.id, what: e.title, state: e.state, detail: "epic" })),
      ...storyRows
        .filter((s) => !["delivered", "dropped"].includes(s.state) && only(walk.ofStory(s.id)))
        .map((s) => {
          const count = perStory.get(s.id) ?? { done: 0, all: 0 };
          return {
            id: s.id,
            what: s.title,
            state: s.state,
            detail: `${count.done}/${count.all} tasks`,
          };
        }),
    ].sort((a, b) => (a.detail === b.detail ? a.id - b.id : a.detail < b.detail ? -1 : 1)),
  };

  /** Built last, because every panel above it has had to record its rows' ages first. */
  const groups: Board = {
    ...panels,
    cooking: [...aged].sort(oldestFirst).map((a) => withAge(a, asOf)),
  };

  return { groups, aged, asOf };
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
    const row: RefusalRow = {
      task_id: taskId,
      why,
      at,
      since: same === null ? at : same.since,
      passes: same === null ? 1 : same.passes + 1,
    };
    q.insertInto(refusals, row)
      .onConflict(["task_id"], { why: row.why, at: row.at, since: row.since, passes: row.passes })
      .run();
  });
}

export function clearRefusal(db: DatabaseSync, taskId: number): void {
  queries(db).deleteFrom(refusals).where("task_id", "=", taskId).run();
}

/** Tokens and seconds — what an assignment was given, and what it has used. The same two
 *  numbers both ways: a spend is only readable against the allowance it is a spend of. */
export interface Spend {
  readonly tokens: number;
  readonly seconds: number;
}

const NOTHING: Spend = { tokens: 0, seconds: 0 };

/** `budget` and `spent` are JSON in a text column. Malformed JSON reads as nothing, the way
 *  `thousands` already reads it: a board that throws on one bad row is no board at all. */
const spend = (raw: string | null): Spend => {
  let v: { tokens?: unknown; seconds?: unknown } | null = null;
  try {
    v = raw === null ? null : (JSON.parse(raw) as { tokens?: unknown; seconds?: unknown });
  } catch {
    v = null;
  }
  if (v === null || typeof v !== "object") return NOTHING;
  return {
    tokens: typeof v.tokens === "number" ? v.tokens : 0,
    seconds: typeof v.seconds === "number" ? v.seconds : 0,
  };
};

/** What the record says about how one assignment is going: the half a list of four columns
 *  has no room for — the allowance, the spend against it, and when the runner last
 *  reported. The board's row says the rest, so neither restates the other and the two
 *  cannot disagree. */
export interface AssignmentFacts {
  readonly worktree: string;
  readonly budget: Spend;
  readonly spent: Spend;
  /** When the runner last wrote to the record, or null when it never has — a pending
   *  assignment has been dispatched and has said nothing yet. */
  readonly beat: string | null;
  /** Milliseconds since that beat. Null when there has been none, or when the timestamp is
   *  one nothing can parse: an unreadable beat is no evidence of life. */
  readonly silent: number | null;
  /** Whether the record still expects the assignment to be working. A finished one is not
   *  silent, it is over, and a page that called it silent would read as an alarm. */
  readonly open: boolean;
}

export function assignmentFacts(
  db: DatabaseSync,
  id: number,
  asOf: number = Date.now(),
): AssignmentFacts | null {
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
  return queries(db)
    .selectFrom(assignments)
    .select(["phase"])
    .all()
    .filter((a) => OPEN_PHASES.includes(a.phase)).length;
}
