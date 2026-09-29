import type { Board } from "../board.js";
import type { Aged, Row } from "./row.js";
import { byId, elapsed, folded, lastLine, minutes, thousands } from "./row.js";
import type { AssignmentRow, Ledger, TaskRow, TaskTestRow } from "./rows.js";
import { OPEN_PHASES, SETTLED } from "./rows.js";
import { Walk, index } from "./walk.js";

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

/** The board and the fold are one pass: the machine-side panels record each row's age as
 *  they build it, and `cooking` is that record sorted. Computing them apart would be two
 *  reads of the same tables that could disagree about what is on the board.
 *
 *  Pure over the `Ledger` it is handed. The one thing it cannot read from rows is what a
 *  task stands refused permission to write, so `denied` arrives as the caller's closure
 *  over the database rather than as a second read taken in here. */
export function panels(
  ledger: Ledger,
  project: number | null,
  denied: (task: number) => string,
  asOf: number,
): Board {
  const { assignments: assignmentRows, stories: storyRows, tasks: taskRows, taskTests: taskTestRows, tests: testRows } = ledger;
  const walk = new Walk(ledger);

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

  const refusalOf = index(ledger.refusals, (f) => f.task_id, (f) => f);
  const titleOf = index(taskRows, (t) => t.id, (t) => t.title);
  const nameOf = index(ledger.workers, (w) => w.id, (w) => w.name);
  const testById = index(testRows, (t) => t.id, (t) => t);
  const storyById = index(storyRows, (s) => s.id, (s) => s);

  /** Ready, and nothing open is attempting it. A set difference rather than a `NOT EXISTS`:
   *  the dialect spells neither, and the set is the same one for every group that asks. */
  const attempted = new Set(
    assignmentRows
      .filter((a) => a.objective_type === "task" && OPEN_PHASES.includes(a.phase))
      .map((a) => a.objective_id),
  );

  /** Ready, but only until the next tick reads it: an attempt has come back succeeded and
   *  every task_test under it is settled, which is exactly what the automatic `finish`
   *  takes. The `ready` is a state the record is passing through, not work to offer — the
   *  queue was showing such a task pass after pass as though nobody had started it.
   *
   *  Narrower than "has a succeeded assignment", deliberately. An attempt can come back
   *  having left a test red, and that task really is the allocator's to dispatch again; a
   *  broader set would take it off the board while the runner went on working it. */
  const settling = new Set(
    assignmentRows
      .filter((a) => a.objective_type === "task" && a.phase === "succeeded")
      .map((a) => a.objective_id)
      .filter((id) => taskTestRows.every((tt) => tt.parent_id !== id || SETTLED.includes(tt.state))),
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
   *  has to read why. */
  const staleChores = (): Row[] => {
    const why = index(ledger.choreRefusals, (f) => f.chore_id, (f) => f);
    return ledger.chores
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

  const groups: Omit<Board, "cooking"> = {
    // What exists, with how much of it is finished — without which a board with nothing in
    // flight reads the same as a board with no project at all.
    projects: ledger.projects
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
        if (!only(walk.ofTask(t.id)) || attempted.has(t.id) || settling.has(t.id)) return [];
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
    // condition `readyCandidates` dispatches on, less `settling` — the one case where the
    // allocator would take a task no person should be shown as unstarted, and the only
    // second opinion this box is allowed. The detail is why it is not running: the last
    // pass's refusal, or its role.
    //
    // Not `cook`ed: waiting for a slot is not being stuck — see MACHINE_SIDE. If it has
    // also stopped moving, `stale` says so and the fold has it from there.
    queued: taskRows
      .filter((t) => t.state === "ready" && placed(walk.ofTask(t.id)) && !attempted.has(t.id) && !settling.has(t.id))
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
    unmergeable: ledger.landConflicts
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
      ...ledger.epics
        .filter((e) => e.state === "planned" && only(walk.ofRelease(e.release_id)))
        .map((e) => ({ id: e.id, what: e.title, state: e.state, detail: "epic" })),
      ...storyRows
        .filter((s) => s.state === "planned" && only(walk.ofStory(s.id)))
        .map((s) => ({ id: s.id, what: s.title, state: s.state, detail: "story" })),
    ].sort((a, b) => (a.detail === b.detail ? a.id - b.id : a.detail < b.detail ? -1 : 1)),
    // A story carries how far it has got: tasks done out of tasks that exist.
    open: [
      ...ledger.epics
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
  return { ...groups, cooking: folded(aged, asOf) };
}
