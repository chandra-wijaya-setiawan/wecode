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
  readonly roadmap: readonly Row[];
  readonly delivered: readonly Row[];
}

const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]): Row[] =>
  db.prepare(sql).all(...args) as unknown as Row[];

export function board(db: DatabaseSync): Board {
  return {
    // What exists, with how much of it is finished. Without this a board with nothing in
    // flight is indistinguishable from a board with no project at all.
    projects: rows(
      db,
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
    ),
    // Nothing is moving it, and nothing is going to. Derived rather than a state: staleness
    // is an observation about the world, and the moment it becomes a column somebody has to
    // keep it in agreement with the world.
    // Staleness is read from what the allocator recorded, not guessed: it is the only
    // thing that knows why a ready task did not become an assignment.
    stale: rows(
      db,
      `SELECT t.id AS id, t.title AS what, 'ready' AS state,
              f.why || ' · ' || f.passes || ' passes · '
                   || cast((julianday('now') - julianday(f.since)) * 1440 AS int) || 'm' AS detail
         FROM task t JOIN refusal f ON f.task_id = t.id
        WHERE t.state = 'ready'
          AND f.passes >= 3
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
          AND (julianday('now') - julianday(a.updated_at)) * 1440 > 15
        UNION ALL
       SELECT s.id AS id, s.title AS what, s.state AS state, 'no work under it' AS detail
         FROM story s
        WHERE s.state = 'in_progress'
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
      db,
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
        WHERE a.phase IN ('pending', 'running') ORDER BY a.id`,
    ),
    needs_human: rows(
      db,
      `SELECT id, objective_type || ' #' || objective_id AS what, coalesce(kind, 'input') AS state,
              coalesce(question, '') AS detail
         FROM assignment WHERE phase = 'waiting' ORDER BY id`,
    ),
    // ready, and nothing open is attempting it: the queue is what waits on a slot.
    // The detail is why it is not running: the last pass's refusal, or its role.
    queued: rows(
      db,
      `SELECT t.id AS id, t.title AS what, t.state AS state,
              coalesce(f.why, t.role) AS detail
         FROM task t LEFT JOIN refusal f ON f.task_id = t.id
        WHERE t.state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM assignment a
             WHERE a.objective_type = 'task' AND a.objective_id = t.id
               AND a.phase IN ('pending','running','waiting'))
        ORDER BY t.id`,
    ),
    failed: rows(
      db,
      `SELECT id, title AS what, state AS state,
              'attempts ' || attempts || '/' || max_retry AS detail
         FROM task WHERE state = 'failed' ORDER BY id`,
    ),
    delivered: rows(
      db,
      `SELECT id, title AS what, state AS state, 'story' AS detail FROM story
        WHERE state = 'delivered' ORDER BY updated_at DESC LIMIT 20`,
    ),
    // A story carries how far it has got: tasks done out of tasks that exist.
    roadmap: rows(
      db,
      `SELECT id, title AS what, state AS state, 'epic' AS detail FROM epic
        WHERE state NOT IN ('delivered','dropped')
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
         FROM story s WHERE s.state NOT IN ('delivered','dropped')
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
