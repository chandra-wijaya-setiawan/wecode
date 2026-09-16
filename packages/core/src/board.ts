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
  /** Every epic and story still open — planned and in_progress alike, not future work. */
  readonly open: readonly Row[];
  readonly delivered: readonly Row[];
  readonly unmergeable: readonly Row[];
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
}
const projects = table<ProjectRow>("project", ["id", "name", "state"]);

const releases = table<{ id: number; project_id: number }>("release", ["id", "project_id"]);

interface EpicRow {
  id: number;
  release_id: number;
  title: string;
  state: string;
}
const epics = table<EpicRow>("epic", ["id", "release_id", "title", "state"]);

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
  last_output: string | null;
}
const acceptanceTests = table<AcceptanceTestRow>("acceptance_test", [
  "id",
  "parent_id",
  "statement",
  "state",
  "red_at_base_sha",
  "last_output",
]);

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
}
const tasks = table<TaskRow>("task", [
  "id",
  "acceptance_test_id",
  "title",
  "role",
  "attempts",
  "max_retry",
  "state",
]);

interface AssignmentRow {
  id: number;
  objective_type: string;
  objective_id: number;
  worker_id: number | null;
  phase: string;
  kind: string | null;
  question: string | null;
  spent: string | null;
  created_at: string;
  updated_at: string;
}
const assignments = table<AssignmentRow>("assignment", [
  "id",
  "objective_type",
  "objective_id",
  "worker_id",
  "phase",
  "kind",
  "question",
  "spent",
  "created_at",
  "updated_at",
]);

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

const choreRefusals = table<{ chore_id: number; why: string; since: string; passes: number }>("chore_refusal", [
  "chore_id",
  "why",
  "since",
  "passes",
]);

const landConflicts = table<{ story_id: number; branch: string; reason: string }>("land_conflict", [
  "story_id",
  "branch",
  "reason",
]);

/** The catalogue is a table like any other, so asking whether a table exists is a query
 *  over declared columns rather than a hand-written string. */
const catalogue = table<{ type: string; name: string }>("sqlite_master", ["type", "name"]);

/** Whether a branch merges is a fact about the repository, so the runner owns both the
 *  observation and the table it lands in — `land_conflict (story_id, branch, reason, at)`,
 *  created beside the record the way `landed_branch` and `red_at_base` are. A workspace
 *  that has never run a lander has no such table, and that is not an error: it is a board
 *  with nothing recorded against it. */
export const hasTable = (db: DatabaseSync, name: string): boolean =>
  queries(db).selectFrom(catalogue).select(["name"]).where("type", "=", "table").where("name", "=", name).get() !==
  null;

/** An assignment nobody has finished with. One list, matched in TypeScript, rather than
 *  the four copies of the same three phase names that four SQL strings held. */
const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];

/** SQLite's `julianday` reads a bare timestamp as UTC where `Date.parse` would read it as
 *  local time. The record always writes ISO-8601 with a Z, but a hand-edited row may not,
 *  so the Z is supplied rather than assumed. */
const instant = (at: string): number => Date.parse(/([Zz]|[+-]\d\d:?\d\d)$/.test(at) ? at : `${at}Z`);

/** `(julianday('now') - julianday(at)) * 1440` — minutes, unrounded, as the threshold on a
 *  waiting assignment compares them. A timestamp nothing can parse is no elapsed time at
 *  all: the arithmetic was NULL before, and a NULL detail is a row the cockpit cannot draw. */
const elapsed = (at: string, asOf: number): number => {
  const then = instant(at);
  return Number.isNaN(then) ? 0 : (asOf - then) / 60000;
};

/** And `cast(… AS int)` over it: SQLite truncates towards zero, and so does this. */
const minutes = (at: string, asOf: number): number => Math.trunc(elapsed(at, asOf));

/** `coalesce(json_extract(a.spent, '$.tokens'), 0) / 1000`, divided the way SQLite divides
 *  it: two integers truncate. Malformed JSON is read as nothing spent — `json_extract`
 *  would have raised, and a board that throws is no board at all. */
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
 *  A Map per level rather than the five nested subqueries this replaces. The dialect spells
 *  no join, and the walk is the same five steps for every row on every group of the board,
 *  so the levels are read once and stepped through per row. A step that finds nothing is
 *  `null`, which is what a subquery over no rows was.
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
 *  part you only need once you have decided to go and look. Trailing blank lines are what
 *  a process's output ends with far more often than not, so the last *non-blank* line is
 *  the one meant here. */
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

/** `project` narrows every group but `projects` to one project's work. The projects box is
 *  how you get back out again, so it always shows the whole workspace. */
export function board(db: DatabaseSync, project: number | null = null): Board {
  const q = queries(db);
  const asOf = Date.now();

  const epicRows = q.selectFrom(epics).all();
  const storyRows = q.selectFrom(stories).all();
  const taskRows = q.selectFrom(tasks).all();
  const testRows = q.selectFrom(acceptanceTests).all();
  const taskTestRows = q.selectFrom(taskTests).all();
  const assignmentRows = q.selectFrom(assignments).all();
  const walk = new Walk(db, epicRows, storyRows, taskRows, testRows);

  /** No project asked for is every project: the predicate is true for every row. */
  const only = (of: number | null): boolean => project === null || of === project;

  /** Like `only`, but a row the walk cannot place is shown on every board rather than on
   *  none. The walk up is five levels, and one missing link anywhere above a task used to
   *  take it off the narrowed board silently — while the allocator, which never walks up,
   *  went on dispatching it. An operator reading an empty queue beside a busy runner has no
   *  way back from that. Used by the queue, because the queue is the one group whose absence
   *  is mistaken for there being no work. */
  const placed = (of: number | null): boolean => only(of) || of === null;

  const refusalOf = index(q.selectFrom(refusals).all(), (f) => f.task_id, (f) => f);
  const titleOf = index(taskRows, (t) => t.id, (t) => t.title);
  const nameOf = index(q.selectFrom(workers).select(["id", "name"]).all(), (w) => w.id, (w) => w.name);
  const testById = index(testRows, (t) => t.id, (t) => t);
  const storyById = index(storyRows, (s) => s.id, (s) => s);

  /** What the task stands refused permission to write, as a clause to hang off a detail.
   *
   *  Beside the other refusals rather than in a box of its own: a task is refused a pass by
   *  the allocator and refused a write by the harness, and the operator reading "why is this
   *  not moving" wants both in the same sentence. Nothing recorded is nothing said. */
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
   *  Same shape and same wording as a task's: the operator asking "why has nothing moved"
   *  does not care which id space the answer is in, and three merge chores sitting in
   *  `planned` for half an hour with no reason on the board is the whole complaint. A chore
   *  carries its project_id, so the walk up that every other group does is not needed here.
   *
   *  No `passes >= 3` here, unlike a task's: a task that is merely queued says its reason in
   *  `queued`, and a chore has no such box, so the first pass that refuses it is the first
   *  chance anyone has to read why.
   *
   *  `chore_refusal` arrives with the chore migration; a workspace older than it has no such
   *  table, and that is a board with nothing recorded against it rather than an error. */
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
              {
                id: c.id,
                what: `${c.kind} ${c.target_type} #${c.target_id}`,
                state: c.state,
                detail: `${f.why} · ${f.passes} passes · ${minutes(f.since, asOf)}m`,
              },
            ];
      });
  };

  /** A count of attempts says a task failed; it never says what failed. The last line of the
   *  output of the test that is still red is the smallest thing that does, so it is carried
   *  here rather than left for a `wecode show` on a test whose id you first have to find. */
  const failure = (t: TaskRow): string | null => {
    const own = taskTestRows
      .filter((tt) => tt.parent_id === t.id && tt.state === "failed" && tt.last_output !== null)
      .sort(newestRun)[0];
    if (own !== undefined) return own.last_output;
    const at = testById.get(t.acceptance_test_id);
    return at !== undefined && at.state === "failed" ? at.last_output : null;
  };

  return {
    // What exists, with how much of it is finished. Without this a board with nothing in
    // flight is indistinguishable from a board with no project at all.
    projects: q
      .selectFrom(projects)
      .all()
      .map((p) => {
        const count = perProject.get(p.id) ?? { delivered: 0, all: 0 };
        return { id: p.id, what: p.name, state: p.state, detail: `${count.delivered}/${count.all} stories` };
      })
      .sort(byId),
    // Nothing is moving it, and nothing is going to. Derived rather than a state: staleness
    // is an observation about the world, and the moment it becomes a column somebody has to
    // keep it in agreement with the world.
    // Staleness is read from what the allocator recorded, not guessed: it is the only
    // thing that knows why a ready task did not become an assignment.
    stale: [
      ...taskRows.flatMap((t) => {
        const f = refusalOf.get(t.id);
        if (t.state !== "ready" || f === undefined || f.passes < 3) return [];
        if (!only(walk.ofTask(t.id)) || attempted.has(t.id)) return [];
        return [
          {
            id: t.id,
            what: t.title,
            state: "ready",
            detail: `${f.why} · ${f.passes} passes · ${minutes(f.since, asOf)}m${denied(t.id)}`,
          },
        ];
      }),
      ...assignmentRows
        .filter((a) => a.phase === "waiting" && only(walk.ofAssignment(a)) && elapsed(a.updated_at, asOf) > 15)
        .map((a) => ({
          id: a.id,
          what: objective(a),
          state: "waiting",
          detail: `waiting on you · ${minutes(a.updated_at, asOf)}m`,
        })),
      ...staleChores(),
      ...storyRows
        .filter((s) => s.state === "in_progress" && only(walk.ofStory(s.id)) && !perStory.has(s.id))
        .map((s) => ({ id: s.id, what: s.title, state: s.state, detail: "no work under it" })),
    ].sort(byId),
    // pending counts: a worktree is cut and a session is starting. Leaving it out made the
    // board say nothing was running while an agent was working.
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
    // ready, and nothing open is attempting it: the queue is what waits on a slot. This is
    // the same condition `readyCandidates` dispatches on and nothing more — no state above
    // the task is consulted, because a task's own machine already decided it was ready and
    // a second opinion here would be a task the allocator takes and the board never shows.
    // The detail is why it is not running: the last pass's refusal, or its role.
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
    // it. Abandoned work is not here: dropped was somebody's decision and wants nothing
    // from anyone, an exhausted task is waiting for a person to retry it or drop it, and
    // one box for both made a triage of ten rows say nothing about which was which.
    failed: taskRows
      .filter((t) => t.state === "failed" && only(walk.ofTask(t.id)))
      .map((t) => {
        const detail =
          t.attempts >= t.max_retry
            ? `out of attempts · ${t.attempts} of ${t.max_retry}${denied(t.id)} · retry it with a reason, or drop it`
            : `attempts ${t.attempts}/${t.max_retry}${denied(t.id)}`;
        const why = lastLine(failure(t));
        return { id: t.id, what: t.title, state: t.state, detail: why === "" ? detail : `${detail} · ${why}` };
      })
      .sort(byId),
    // Put down on purpose. Its own filter, under its own name, so nothing reading `failed`
    // has to carry the reason to tell the two apart.
    dropped: taskRows
      .filter((t) => t.state === "dropped" && only(walk.ofTask(t.id)))
      .map((t) => ({ id: t.id, what: t.title, state: t.state, detail: "dropped by decision" }))
      .sort(byId),
    // Ready to run, but nobody has watched it fail — so passing it would prove nothing.
    // A group rather than a state: red is an observation, and the test is otherwise a
    // perfectly ordinary ready test. These are what `test_has_been_red` will refuse.
    unproven: testRows
      .filter((t) => t.state === "ready" && t.red_at_base_sha === null && only(walk.ofTest(t.id)))
      .map((t) => ({ id: t.id, what: t.statement, state: t.state, detail: "no red run recorded" }))
      .sort(byId),
    delivered: storyRows
      .filter((s) => s.state === "delivered" && only(walk.ofStory(s.id)))
      .sort((a, b) => (a.updated_at === b.updated_at ? 0 : a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, 20)
      .map((s) => ({ id: s.id, what: s.title, state: s.state, detail: "story" })),
    // Delivered, and the last thing that tried to land it could not. A filter rather than
    // a state: the story is delivered, and stays delivered — what is wrong is between its
    // branch and master, and only the thing holding a repository can see it. Stories 138
    // and 139 sat for a day because the only record of it was prose in a chat.
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
    // A story carries how far it has got: tasks done out of tasks that exist.
    open: [
      ...epicRows
        .filter((e) => !["delivered", "dropped"].includes(e.state) && only(walk.ofRelease(e.release_id)))
        .map((e) => ({ id: e.id, what: e.title, state: e.state, detail: "epic" })),
      ...storyRows
        .filter((s) => !["delivered", "dropped"].includes(s.state) && only(walk.ofStory(s.id)))
        .map((s) => {
          const count = perStory.get(s.id) ?? { done: 0, all: 0 };
          return { id: s.id, what: s.title, state: s.state, detail: `${count.done}/${count.all} tasks` };
        }),
    ].sort((a, b) => (a.detail === b.detail ? a.id - b.id : a.detail < b.detail ? -1 : 1)),
  };
}

/** What the last pass decided about a task it did not start. One row per task, replaced
 *  each time, so the board always shows the current reason rather than a history.
 *
 *  The same reason keeps its `since`: a task refused for the same thing all morning is a
 *  different problem from one refused for a new reason a minute ago. Which of the two it is
 *  is decided here rather than in a `CASE` inside the upsert — the dialect assigns a value
 *  or the excluded row's, and nothing else — so the read and the write are one transaction. */
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

/** How many assignments hold a slot. `waiting` counts: waiting on a person is exactly the
 *  resource the attention budget exists to bound. */
export function openAssignments(db: DatabaseSync): number {
  return queries(db)
    .selectFrom(assignments)
    .select(["phase"])
    .all()
    .filter((a) => OPEN_PHASES.includes(a.phase)).length;
}
