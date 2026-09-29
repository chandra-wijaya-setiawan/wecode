import type { DatabaseSync } from "node:sqlite";
import { queries, table } from "./db.js";
import { now, transact } from "./store.js";

export class SketchError extends Error {}

/** A drawing made before there is work — `016-sketch.sql`.
 *
 *  No `state` and no parent: a sketch is there or it is gone, and the only two writes this
 *  module offers are the ones that put it in each of those. */
export interface Sketch {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly says: string;
  /** Where the drawing is. A path in the repo, so the record holds the reference and the
   *  file holds the picture. */
  readonly html: string;
  /** The story this sketch became. Null while it is still only a sketch, which is what
   *  most of them stay: drawing something to find out it is not worth writing down is the
   *  sketch doing its job. */
  readonly story_id: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The `sketch` table as the migration declares it. Not `Sketch` itself: that one is
 *  `readonly`, and a row this layer writes is a row it may build. `schema-shapes.test.ts`
 *  lists `sketch` among the tables whose shape lives with the code that owns it, and
 *  `a-sketch-is-a-record.test.ts` holds this list against `PRAGMA table_info`, so the two
 *  cannot drift without a test saying so. */
export interface SketchRow {
  id: number;
  name: string;
  kind: string;
  says: string;
  html: string;
  story_id: number | null;
  created_at: string;
  updated_at: string;
}

export const SKETCH_FIELDS = [
  "id",
  "name",
  "kind",
  "says",
  "html",
  "story_id",
  "created_at",
  "updated_at",
] as const;

export const sketch = table<SketchRow>("sketch", [...SKETCH_FIELDS]);

/** The same table without the id SQLite assigns: the dialect writes every key of the row
 *  it is given, and a sketch does not choose its own id. */
const sketchInsert = table<Omit<SketchRow, "id">>(
  "sketch",
  SKETCH_FIELDS.filter((f) => f !== "id") as (keyof Omit<SketchRow, "id">)[],
);

/** What a caller must actually say. `story_id` is left out rather than made optional-and-
 *  nullable: at the moment a sketch is drawn there is by definition no story, and a
 *  parameter for it would invite callers to guess one. */
export interface Drawing {
  readonly name: string;
  readonly kind: string;
  readonly says: string;
  readonly html: string;
  /** The story it was promoted into, when a sketch is being recorded after that already
   *  happened. Absent is the normal case and means nothing, not unknown. */
  readonly story_id?: number | null;
}

/** One line, however it arrived. A `says` that is a paragraph turns the list below into a
 *  wall of text, which is the failure mode the column exists to avoid. */
const oneLine = (text: string, what: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  if (one === "") throw new SketchError(`a sketch needs ${what}`);
  return one;
};

/** Record a drawing. Returns its id.
 *
 *  In one transaction, because the id is read back rather than returned by the insert: the
 *  dialect reports how many rows a write touched and not which one it made, so the highest
 *  id in the table is the row just written only while no other writer can commit.
 *
 *  The file at `html` is not read and not required to exist. A sketch is a record *of* a
 *  drawing, and a record that refused to exist until the file did would make the order of
 *  two unrelated acts into a rule. */
export function addSketch(db: DatabaseSync, drawing: Drawing): number {
  const row = {
    name: oneLine(drawing.name, "a name"),
    kind: oneLine(drawing.kind, "a kind"),
    says: oneLine(drawing.says, "a line saying what it is"),
    html: oneLine(drawing.html, "the path of its html"),
    story_id: drawing.story_id ?? null,
  };

  return transact(db, () => {
    const q = queries(db);
    const at = now();
    q.insertInto(sketchInsert, { ...row, created_at: at, updated_at: at }).run();
    return Math.max(...q.selectFrom(sketch).select(["id"]).all().map((r) => r.id));
  });
}

/** Every sketch, newest first.
 *
 *  Newest first because a sketch is a thought in progress: the one drawn this morning is
 *  the one being asked about, and the one from three months ago is either a story by now
 *  or was never going to be.
 *
 *  Ordered and capped here rather than in SQL: the dialect spells no ORDER BY and no
 *  LIMIT, and there is no parent to scope the read to — every sketch in the record is the
 *  whole list, which is a list a person reads rather than a table to page through. */
export function sketches(db: DatabaseSync, limit: number | null = null): readonly Sketch[] {
  const rows = queries(db).selectFrom(sketch).all();
  rows.sort((a, b) => b.id - a.id);
  return limit === null ? rows : rows.slice(0, Math.max(0, limit));
}

/** One sketch by id, or null. The reader a `drop` confirms itself against. */
export function sketchAt(db: DatabaseSync, id: number): Sketch | null {
  return queries(db).selectFrom(sketch).where("id", "=", id).get();
}

/** Take a sketch out of the record. False when there was no such sketch.
 *
 *  The row goes and the drawing stays. Deleting the html here would make `wecode sketch
 *  drop` a command that removes a file the operator wrote by hand and may have linked from
 *  somewhere this record cannot see — and the sketch that is gone from the record is
 *  exactly the sketch somebody may still want to look at. The file is theirs; the row is
 *  ours. */
export function dropSketch(db: DatabaseSync, id: number): boolean {
  return queries(db).deleteFrom(sketch).where("id", "=", id).run().changes > 0;
}
