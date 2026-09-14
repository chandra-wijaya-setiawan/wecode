import type { DatabaseSync } from "node:sqlite";
import { now } from "./store.js";

export class LessonError extends Error {}

export interface Lesson {
  readonly id: number;
  readonly project_id: number;
  readonly text: string;
  /** The assignment that learned it. Null when nothing can be attributed — a lesson the
   *  operator wrote by hand has no attempt behind it. */
  readonly assignment_id: number | null;
  readonly created_at: string;
}

/** How many a brief carries. Ten lines: a brief that grows without limit is how the
 *  instruction at the top stops being read. See docs/design/17. */
export const BRIEF_LESSONS = 10;

/** One sentence, on one line. A lesson that arrives as a paragraph is a design document,
 *  and storing it as one would put a wall of text at the top of every later brief. */
export function addLesson(
  db: DatabaseSync,
  project_id: number,
  text: string,
  assignment_id: number | null = null,
): number {
  const one = text.replace(/\s+/g, " ").trim();
  if (one === "") throw new LessonError("a lesson needs a sentence");

  const project = db.prepare("SELECT id FROM project WHERE id = ?").get(project_id);
  if (project === undefined) throw new LessonError(`no project #${project_id}`);

  db.prepare(
    "INSERT INTO lesson (project_id, text, assignment_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(project_id, one, assignment_id, now());
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

/** Newest first, because that is the order a brief reads them in and the order an operator
 *  wants them: a lesson about a world that changed is most likely to be the old one. */
export function lessons(
  db: DatabaseSync,
  project_id: number,
  limit: number | null = null,
): readonly Lesson[] {
  return db
    .prepare(
      `SELECT id, project_id, text, assignment_id, created_at
         FROM lesson WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(project_id, limit ?? -1) as unknown as Lesson[];
}

/** Wrong lessons are worse than none, so dropping one is a single command and leaves
 *  nothing behind. False when there was no such lesson. */
export function dropLesson(db: DatabaseSync, id: number): boolean {
  const changed = db.prepare("DELETE FROM lesson WHERE id = ?").run(id).changes;
  return Number(changed) > 0;
}
