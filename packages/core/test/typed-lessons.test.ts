import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { queries } from "../src/db.js";
import { BRIEF_LESSONS, LessonError, Maker, addLesson, dropLesson, lesson, lessons } from "../src/index.js";
import type { LessonRow } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const source = readFileSync(fileURLToPath(new URL("../src/lessons.ts", import.meta.url)), "utf8");

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

describe("the lessons module, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in the module", () => {
    expect(source).not.toMatch(/\bprepare\s*\(/);
    expect(source.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/g)).toBeNull();
  });

  it("speaks to the database only through the dialect", () => {
    // `DatabaseSync` is still the currency every caller passes, but it arrives as a type and
    // is handed on; nothing in here calls a method on it.
    expect(source).toContain('import { queries, table } from "./db.js"');
    expect(source).not.toMatch(/\bdb\.(prepare|exec|get|all|run)\b/);
  });

  it("declares exactly the columns the migration built, so the two cannot drift apart", () => {
    const actual = (db.prepare("PRAGMA table_info(lesson)").all() as { name: string }[]).map((c) => c.name);
    expect([...lesson.columns].sort()).toEqual([...actual].sort());
  });
});

describe("adding a lesson through the layer", () => {
  it("writes the row and hands back the id SQLite assigned it", () => {
    const id = addLesson(db, tree.project, "  a worktree needs   pnpm -r build\nfirst ");

    expect(queries(db).selectFrom(lesson).where("id", "=", id).get()).toEqual({
      id,
      project_id: tree.project,
      text: "a worktree needs pnpm -r build first",
      assignment_id: null,
      created_at: expect.any(String),
    });
  });

  it("gives each lesson its own id, rather than reporting the same row twice", () => {
    const ids = ["one", "two", "three"].map((t) => addLesson(db, tree.project, t));
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  /** The id is read back rather than returned by the insert, so it must be the highest id in
   *  *this* project and not in the table: a neighbour writing at the same time is what would
   *  break a max() taken over everything. */
  it("reports its own project's row when another project is being written too", () => {
    const other = new Maker(db).project(tree.ws, "other", "/other");
    addLesson(db, other, "theirs");
    const mine = addLesson(db, tree.project, "mine");
    addLesson(db, other, "theirs again");

    expect(queries(db).selectFrom(lesson).where("id", "=", mine).get()?.text).toBe("mine");
  });

  it("refuses an empty lesson before it opens a transaction", () => {
    expect(() => addLesson(db, tree.project, " \n\t ")).toThrow(LessonError);
    expect(lessons(db, tree.project)).toEqual([]);
  });

  it("refuses a project that is not there, checked through the layer", () => {
    expect(() => addLesson(db, 99, "something")).toThrow(/no project #99/);
  });

  /** The foreign key is the database's to enforce, and the transaction the port added must
   *  roll the insert back rather than leave a half-written lesson behind. */
  it("writes nothing when the assignment it is attributed to never happened", () => {
    expect(() => addLesson(db, tree.project, "learned by nobody", 404)).toThrow(/FOREIGN KEY/);
    expect(lessons(db, tree.project)).toEqual([]);
  });
});

describe("listing lessons through the layer", () => {
  it("is newest first", () => {
    for (const t of ["oldest", "middle", "newest"]) addLesson(db, tree.project, t);
    expect(lessons(db, tree.project).map((l) => l.text)).toEqual(["newest", "middle", "oldest"]);
  });

  it("caps at the newest, not at the first ones written", () => {
    for (const n of [1, 2, 3, 4, 5]) addLesson(db, tree.project, `lesson ${n}`);
    expect(lessons(db, tree.project, 2).map((l) => l.text)).toEqual(["lesson 5", "lesson 4"]);
  });

  /** The old SQL spelled "no cap" as `LIMIT -1`. Ordering in TypeScript must not turn a
   *  negative or zero cap into a slice that means the opposite. */
  it("hands back nothing for a cap of none, and everything for no cap", () => {
    for (const n of [1, 2, 3]) addLesson(db, tree.project, `lesson ${n}`);
    expect(lessons(db, tree.project, 0)).toEqual([]);
    expect(lessons(db, tree.project, -1)).toEqual([]);
    expect(lessons(db, tree.project)).toHaveLength(3);
    expect(lessons(db, tree.project, BRIEF_LESSONS)).toHaveLength(3);
  });

  it("shows one project nothing of another's", () => {
    const other = new Maker(db).project(tree.ws, "other", "/other");
    addLesson(db, tree.project, "mine");
    addLesson(db, other, "theirs");

    expect(lessons(db, tree.project).map((l) => l.text)).toEqual(["mine"]);
    expect(lessons(db, other).map((l) => l.text)).toEqual(["theirs"]);
  });

  it("is empty for a project that has learned nothing, and for one that does not exist", () => {
    expect(lessons(db, tree.project)).toEqual([]);
    expect(lessons(db, 99)).toEqual([]);
  });

  it("yields rows of the declared shape", () => {
    addLesson(db, tree.project, "something");
    const [row] = lessons(db, tree.project) as readonly LessonRow[];
    expect(Object.keys(row ?? {}).sort()).toEqual([...lesson.columns].sort());
  });
});

describe("dropping a lesson through the layer", () => {
  it("takes that one and leaves the rest, reporting the row it touched", () => {
    addLesson(db, tree.project, "keep this");
    const wrong = addLesson(db, tree.project, "this one is wrong");

    expect(dropLesson(db, wrong)).toBe(true);
    expect(lessons(db, tree.project).map((l) => l.text)).toEqual(["keep this"]);
  });

  it("says so when there was no such lesson, rather than pretending", () => {
    expect(dropLesson(db, 404)).toBe(false);
    addLesson(db, tree.project, "one");
    expect(dropLesson(db, 404)).toBe(false);
    expect(lessons(db, tree.project)).toHaveLength(1);
  });
});
