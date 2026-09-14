import type { DatabaseSync } from "node:sqlite";

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
  readonly roadmap: readonly Row[];
  readonly delivered: readonly Row[];
  readonly unmergeable: readonly Row[];
}

/** Whether a branch merges is a fact about the repository, so the runner owns both the
 *  observation and the table it lands in — `land_conflict (story_id, branch, reason, at)`,
 *  created beside the record the way `landed_branch` and `red_at_base` are. A workspace
 *  that has never run a lander has no such table, and that is not an error: it is a board
 *  with nothing recorded against it. */
const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** The project a row belongs to, as an expression over the id of its row. Every group but
 *  `projects` hangs somewhere under a project, and the walk up is the only way to know
 *  which: nothing below a project carries a project_id, so nothing can disagree with it. */
const ofEpic = (id: string): string => `(SELECT r.project_id FROM release r WHERE r.id = ${id})`;
const ofStory = (id: string): string =>
  `(SELECT ${ofEpic("e.release_id")} FROM epic e WHERE e.id = ${id})`;
const ofCriteria = (id: string): string =>
  `(SELECT ${ofStory("q.story_id")} FROM requirement q JOIN acceptance_criteria c ON c.requirement_id = q.id
      WHERE c.id = ${id})`;
const ofTest = (id: string): string =>
  `(SELECT ${ofCriteria("a2.parent_id")} FROM acceptance_test a2 WHERE a2.id = ${id})`;
const ofTask = (id: string): string =>
  `(SELECT ${ofTest("t2.acceptance_test_id")} FROM task t2 WHERE t2.id = ${id})`;
/** An assignment's project is its objective's, whichever of the three kinds it is. */
const ofAssignment = (alias: string): string =>
  `(CASE ${alias}.objective_type
      WHEN 'task' THEN ${ofTask(`${alias}.objective_id`)}
      WHEN 'acceptance_test' THEN ${ofTest(`${alias}.objective_id`)}
      WHEN 'task_test' THEN ${ofTask(`(SELECT tt.parent_id FROM task_test tt WHERE tt.id = ${alias}.objective_id)`)}
    END)`;

/** No project asked for is every project: the predicate is true for every row. */
const only = (project: string): string => `(:project IS NULL OR ${project} = :project)`;

/** `project` narrows every group but `projects` to one project's work. The projects box is
 *  how you get back out again, so it always shows the whole workspace. */
export function board(db: DatabaseSync, project: number | null = null): Board {
  const rows = (sql: string): Row[] => db.prepare(sql).all({ project }) as unknown as Row[];
  return {
    // What exists, with how much of it is finished. Without this a board with nothing in
    // flight is indistinguishable from a board with no project at all.
    projects: db.prepare(
      `SELECT p.id AS id, p.name AS what, p.state AS state,
              (SELECT count(*) FROM story s
                 JOIN epic e ON e.id = s.epic_id
                 JOIN release r ON r.id = e.release_id
                WHERE r.project_id = p.id AND s.state = 'delivered')
              || '/' ||
              (SELECT count(*) FROM story s
                 JOIN epic e ON e.id = s.epic_id
                 JOIN release r ON r.id = e.release_id
                WHERE r.project_id = p.id) || ' stories' AS detail
         FROM project p ORDER BY p.id`,
    ).all() as unknown as Row[],
    // Nothing is moving it, and nothing is going to. Derived rather than a state: staleness
    // is an observation about the world, and the moment it becomes a column somebody has to
    // keep it in agreement with the world.
    // Staleness is read from what the allocator recorded, not guessed: it is the only
    // thing that knows why a ready task did not become an assignment.
    stale: rows(
      `SELECT t.id AS id, t.title AS what, 'ready' AS state,
              f.why || ' · ' || f.passes || ' passes · '
                   || cast((julianday('now') - julianday(f.since)) * 1440 AS int) || 'm' AS detail
         FROM task t JOIN refusal f ON f.task_id = t.id
        WHERE t.state = 'ready'
          AND f.passes >= 3
          AND ${only(ofTask("t.id"))}
          AND NOT EXISTS (SELECT 1 FROM assignment a
                           WHERE a.objective_type = 'task' AND a.objective_id = t.id
                             AND a.phase IN ('pending','running','waiting'))
        UNION ALL
       SELECT a.id AS id,
              coalesce(t.title, a.objective_type || ' #' || a.objective_id) AS what,
              'waiting' AS state,
              'waiting on you · ' || cast((julianday('now') - julianday(a.updated_at)) * 1440 AS int) || 'm' AS detail
         FROM assignment a
         LEFT JOIN task t ON t.id = a.objective_id AND a.objective_type = 'task'
        WHERE a.phase = 'waiting'
          AND ${only(ofAssignment("a"))}
          AND (julianday('now') - julianday(a.updated_at)) * 1440 > 15
        UNION ALL
       SELECT s.id AS id, s.title AS what, s.state AS state, 'no work under it' AS detail
         FROM story s
        WHERE s.state = 'in_progress'
          AND ${only(ofStory("s.id"))}
          AND NOT EXISTS (SELECT 1 FROM requirement r
                           JOIN acceptance_criteria c ON c.requirement_id = r.id
                           JOIN acceptance_test at2 ON at2.parent_id = c.id
                           JOIN task t2 ON t2.acceptance_test_id = at2.id
                          WHERE r.story_id = s.id)
        ORDER BY 1`,
    ),
    // pending counts: a worktree is cut and a session is starting. Leaving it out made the
    // board say nothing was running while an agent was working.
    running: rows(
      `SELECT a.id AS id,
              coalesce(t.title, a.objective_type || ' #' || a.objective_id) AS what,
              a.phase AS state,
              -- || binds tighter than / in SQLite, so every arithmetic term is parenthesised
              coalesce(w.name, '?')
                || ' · ' || cast((julianday('now') - julianday(a.created_at)) * 1440 AS int) || 'm'
                || ' · ' || (coalesce(json_extract(a.spent, '$.tokens'), 0) / 1000) || 'k' AS detail
         FROM assignment a
         LEFT JOIN worker w ON w.id = a.worker_id
         LEFT JOIN task t ON t.id = a.objective_id AND a.objective_type = 'task'
        WHERE a.phase IN ('pending', 'running')
          AND ${only(ofAssignment("a"))}
        ORDER BY a.id`,
    ),
    needs_human: rows(
      `SELECT a.id AS id, a.objective_type || ' #' || a.objective_id AS what,
              coalesce(a.kind, 'input') AS state, coalesce(a.question, '') AS detail
         FROM assignment a
        WHERE a.phase = 'waiting' AND ${only(ofAssignment("a"))}
        ORDER BY a.id`,
    ),
    // ready, and nothing open is attempting it: the queue is what waits on a slot.
    // The detail is why it is not running: the last pass's refusal, or its role.
    queued: rows(
      `SELECT t.id AS id, t.title AS what, t.state AS state,
              coalesce(f.why, t.role) AS detail
         FROM task t LEFT JOIN refusal f ON f.task_id = t.id
        WHERE t.state = 'ready'
          AND ${only(ofTask("t.id"))}
          AND NOT EXISTS (
            SELECT 1 FROM assignment a
             WHERE a.objective_type = 'task' AND a.objective_id = t.id
               AND a.phase IN ('pending','running','waiting'))
        ORDER BY t.id`,
    ),
    // Work that stopped because its attempts ran out, or because a pass is still owed to
    // it. Abandoned work is not here: dropped was somebody's decision and wants nothing
    // from anyone, an exhausted task is waiting for a person to retry it or drop it, and
    // one box for both made a triage of ten rows say nothing about which was which.
    failed: rows(
      `SELECT t.id AS id, t.title AS what, t.state AS state,
              CASE
                WHEN t.attempts >= t.max_retry
                  THEN 'out of attempts · ' || t.attempts || ' of ' || t.max_retry
                       || ' · retry it with a reason, or drop it'
                ELSE 'attempts ' || t.attempts || '/' || t.max_retry
              END AS detail
         FROM task t
        WHERE t.state = 'failed' AND ${only(ofTask("t.id"))}
        ORDER BY t.id`,
    ),
    // Put down on purpose. Its own filter, under its own name, so nothing reading `failed`
    // has to carry the reason to tell the two apart.
    dropped: rows(
      `SELECT t.id AS id, t.title AS what, t.state AS state,
              'dropped by decision' AS detail
         FROM task t
        WHERE t.state = 'dropped' AND ${only(ofTask("t.id"))}
        ORDER BY t.id`,
    ),
    // Ready to run, but nobody has watched it fail — so passing it would prove nothing.
    // A group rather than a state: red is an observation, and the test is otherwise a
    // perfectly ordinary ready test. These are what `test_has_been_red` will refuse.
    unproven: rows(
      `SELECT a.id AS id, a.statement AS what, a.state AS state,
              'no red run recorded' AS detail
         FROM acceptance_test a
        WHERE a.state = 'ready'
          AND a.red_at_base_sha IS NULL
          AND ${only(ofTest("a.id"))}
        ORDER BY a.id`,
    ),
    delivered: rows(
      `SELECT s.id AS id, s.title AS what, s.state AS state, 'story' AS detail FROM story s
        WHERE s.state = 'delivered' AND ${only(ofStory("s.id"))}
        ORDER BY s.updated_at DESC LIMIT 20`,
    ),
    // Delivered, and the last thing that tried to land it could not. A filter rather than
    // a state: the story is delivered, and stays delivered — what is wrong is between its
    // branch and master, and only the thing holding a repository can see it. Stories 138
    // and 139 sat for a day because the only record of it was prose in a chat.
    unmergeable: hasTable(db, "land_conflict")
      ? rows(
          `SELECT s.id AS id, s.title AS what, s.state AS state,
                  c.branch || ' · ' || c.reason AS detail
             FROM story s JOIN land_conflict c ON c.story_id = s.id
            WHERE s.state = 'delivered' AND ${only(ofStory("s.id"))}
            ORDER BY s.id`,
        )
      : [],
    // A story carries how far it has got: tasks done out of tasks that exist.
    roadmap: rows(
      `SELECT x.id AS id, x.title AS what, x.state AS state, 'epic' AS detail FROM epic x
        WHERE x.state NOT IN ('delivered','dropped') AND ${only(ofEpic("x.release_id"))}
        UNION ALL
       SELECT s.id AS id, s.title AS what, s.state AS state,
              (SELECT count(*) FROM task t
                 JOIN acceptance_test a ON a.id = t.acceptance_test_id
                 JOIN acceptance_criteria c ON c.id = a.parent_id
                 JOIN requirement r ON r.id = c.requirement_id
                WHERE r.story_id = s.id AND t.state = 'done')
              || '/' ||
              (SELECT count(*) FROM task t
                 JOIN acceptance_test a ON a.id = t.acceptance_test_id
                 JOIN acceptance_criteria c ON c.id = a.parent_id
                 JOIN requirement r ON r.id = c.requirement_id
                WHERE r.story_id = s.id) || ' tasks' AS detail
         FROM story s
        WHERE s.state NOT IN ('delivered','dropped') AND ${only(ofStory("s.id"))}
        ORDER BY detail, id`,
    ),
  };
}

/** What the last pass decided about a task it did not start. One row per task, replaced
 *  each time, so the board always shows the current reason rather than a history. */
export function recordRefusal(db: DatabaseSync, why: string, taskId: number): void {
  const at = new Date().toISOString();
  // The same reason keeps its `since`: a task refused for the same thing all morning is a
  // different problem from one refused for a new reason a minute ago.
  db.prepare(
    `INSERT INTO refusal (task_id, why, at, since, passes) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (task_id) DO UPDATE SET
       why    = excluded.why,
       at     = excluded.at,
       since  = CASE WHEN refusal.why = excluded.why THEN refusal.since ELSE excluded.since END,
       passes = CASE WHEN refusal.why = excluded.why THEN refusal.passes + 1 ELSE 1 END`,
  ).run(taskId, why, at, at);
}

export function clearRefusal(db: DatabaseSync, taskId: number): void {
  db.prepare("DELETE FROM refusal WHERE task_id = ?").run(taskId);
}

/** How many assignments hold a slot. `waiting` counts: waiting on a person is exactly the
 *  resource the attention budget exists to bound. */
export function openAssignments(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT count(*) AS n FROM assignment WHERE phase IN ('pending','running','waiting')`)
    .get() as { n: number };
  return row.n;
}
