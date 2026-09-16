import type { DatabaseSync } from "node:sqlite";
import { queries, table } from "./db.js";
import { now, transact } from "./store.js";

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

/** The `lesson` table as `010-lesson.sql` declares it. Not `Lesson` itself: that one is
 *  `readonly`, and a row the layer writes is a row it may build. `typed-lessons.test.ts`
 *  holds this against `PRAGMA table_info`, so the two cannot drift without a test saying so. */
export interface LessonRow {
  id: number;
  project_id: number;
  text: string;
  assignment_id: number | null;
  created_at: string;
}

export const lesson = table<LessonRow>("lesson", ["id", "project_id", "text", "assignment_id", "created_at"]);

/** The same table, without the id SQLite assigns: the dialect writes every key of the row
 *  it is given, and a lesson does not choose its own id. */
const lessonInsert = table<Omit<LessonRow, "id">>("lesson", ["project_id", "text", "assignment_id", "created_at"]);

/** Only the column this module reads. A lesson asks one question of `project` — is there
 *  one — and declaring the other columns here would be a second copy of a schema this
 *  module does not own and cannot check. */
const project = table<{ id: number }>("project", ["id"]);

/** How many a brief carries. Ten lines: a brief that grows without limit is how the
 *  instruction at the top stops being read. See docs/design/17. */
export const BRIEF_LESSONS = 10;

/** One sentence, on one line. A lesson that arrives as a paragraph is a design document,
 *  and storing it as one would put a wall of text at the top of every later brief.
 *
 *  In one transaction, because the id is read back rather than returned by the insert: the
 *  dialect reports how many rows a write touched and not which one it made, so the highest
 *  id in the project is the row just written only while no other writer can commit. */
export function addLesson(
  db: DatabaseSync,
  project_id: number,
  text: string,
  assignment_id: number | null = null,
): number {
  const one = text.replace(/\s+/g, " ").trim();
  if (one === "") throw new LessonError("a lesson needs a sentence");

  return transact(db, () => {
    const q = queries(db);
    if (q.selectFrom(project).where("id", "=", project_id).get() === null) {
      throw new LessonError(`no project #${project_id}`);
    }
    q.insertInto(lessonInsert, { project_id, text: one, assignment_id, created_at: now() }).run();
    return Math.max(...q.selectFrom(lesson).select(["id"]).where("project_id", "=", project_id).all().map((r) => r.id));
  });
}

/** Newest first, because that is the order a brief reads them in and the order an operator
 *  wants them: a lesson about a world that changed is most likely to be the old one.
 *
 *  Ordered and capped here rather than in SQL: the dialect spells no ORDER BY and no LIMIT,
 *  and a project's lessons are a list a person reads — ten of them in a brief — not a table
 *  to page through. */
export function lessons(
  db: DatabaseSync,
  project_id: number,
  limit: number | null = null,
): readonly Lesson[] {
  const rows = queries(db).selectFrom(lesson).where("project_id", "=", project_id).all();
  rows.sort((a, b) => b.id - a.id);
  return limit === null ? rows : rows.slice(0, Math.max(0, limit));
}

/** Wrong lessons are worse than none, so dropping one is a single command and leaves
 *  nothing behind. False when there was no such lesson. */
export function dropLesson(db: DatabaseSync, id: number): boolean {
  return queries(db).deleteFrom(lesson).where("id", "=", id).run().changes > 0;
}
