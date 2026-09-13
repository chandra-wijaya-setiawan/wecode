import type { DatabaseSync } from "node:sqlite";

/** The board's groups. Each is a filter over the same record — see docs/design/01. */
export interface Row {
  readonly id: number;
  readonly what: string;
  readonly state: string;
  readonly detail: string;
}

export interface Board {
  readonly running: readonly Row[];
  readonly needs_human: readonly Row[];
  readonly queued: readonly Row[];
  readonly failed: readonly Row[];
  readonly roadmap: readonly Row[];
}

const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]): Row[] =>
  db.prepare(sql).all(...args) as unknown as Row[];

export function board(db: DatabaseSync): Board {
  return {
    running: rows(
      db,
      `SELECT a.id AS id, a.objective_type || ' #' || a.objective_id AS what, a.phase AS state,
              coalesce(w.name, '?') AS detail
         FROM assignment a LEFT JOIN worker w ON w.id = a.worker_id
        WHERE a.phase = 'running' ORDER BY a.id`,
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
    roadmap: rows(
      db,
      `SELECT id, title AS what, state AS state, 'epic' AS detail FROM epic
        WHERE state NOT IN ('delivered','dropped')
        UNION ALL
       SELECT id, title AS what, state AS state, 'story' AS detail FROM story
        WHERE state NOT IN ('delivered','dropped')
        ORDER BY detail, id`,
    ),
  };
}

/** What the last pass decided about a task it did not start. One row per task, replaced
 *  each time, so the board always shows the current reason rather than a history. */
export function recordRefusal(db: DatabaseSync, why: string, taskId: number): void {
  db.prepare(
    `INSERT INTO refusal (task_id, why, at) VALUES (?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET why = excluded.why, at = excluded.at`,
  ).run(taskId, why, new Date().toISOString());
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
