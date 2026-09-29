import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  SKETCH_FIELDS,
  SketchError,
  addSketch,
  dropSketch,
  sketchAt,
  sketches,
} from "../src/index.js";
import { freshDb, seed } from "./helpers.js";
import { tmp } from "./tmpdir.js";

const drawing = {
  name: "recovery flow",
  kind: "flow",
  says: "three screens between a forgotten password and a new one",
  html: "docs/sketches/recovery-flow.html",
};

/** A real file on disk with a real drawing in it, so "leaves the file alone" is a question
 *  about a file that exists rather than about a path that never did. */
const drawn = (body = "<h1>recovery</h1>"): string => {
  const path = join(tmp("wecode-sketch-"), "recovery-flow.html");
  writeFileSync(path, body);
  return path;
};

const columnsOf = (db: DatabaseSync, table: string): readonly string[] =>
  (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name);

describe("the sketch table", () => {
  it("holds a name, a kind, a line, a path, a story and the usual timestamps", () => {
    expect(columnsOf(freshDb(), "sketch")).toEqual([
      "id",
      "name",
      "kind",
      "says",
      "html",
      "story_id",
      "created_at",
      "updated_at",
    ]);
  });

  /** The row interface against the schema, the way schema-shapes.test.ts does it for the
   *  tree entities: sketch is not one of those, so this is where the two are held level. */
  it("is exactly what SketchRow declares, in the same order", () => {
    expect([...SKETCH_FIELDS]).toEqual(columnsOf(freshDb(), "sketch"));
  });

  /** Not an oversight — the migration says so. A sketch is drawn before there is work, so
   *  a NOT NULL parent would mean inventing the story the drawing exists to decide on. */
  it("has no parent and no state, so a sketch hangs off nothing", () => {
    const columns = columnsOf(freshDb(), "sketch");
    expect(columns).not.toContain("state");
    for (const parent of ["project_id", "epic_id", "requirement_id", "parent_id"]) {
      expect(columns).not.toContain(parent);
    }
  });

  /** The one reference it does carry points the other way: not who owns this sketch, but
   *  what the sketch became. It has to be droppable, so it has to be nullable. */
  it("lets the story be nothing, because most sketches never become one", () => {
    const db = freshDb();
    expect(() =>
      db.prepare("INSERT INTO sketch (name,kind,says,html,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run("bare", "page", "no story", "a.html", "2026-09-23T00:00:00.000Z", "2026-09-23T00:00:00.000Z"),
    ).not.toThrow();
  });

  it("refuses a story that does not exist, so a promotion cannot name nobody", () => {
    const db = freshDb();
    expect(() => addSketch(db, { ...drawing, story_id: 404 })).toThrow(/FOREIGN KEY/);
  });
});

describe("making a sketch", () => {
  it("is the whole drawing, read straight back", () => {
    const db = freshDb();
    const id = addSketch(db, drawing);

    expect(sketchAt(db, id)).toEqual({
      id,
      name: "recovery flow",
      kind: "flow",
      says: "three screens between a forgotten password and a new one",
      html: "docs/sketches/recovery-flow.html",
      story_id: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it("carries the story when the sketch has already been promoted into one", () => {
    const db = freshDb();
    const tree = seed(db);
    const id = addSketch(db, { ...drawing, story_id: tree.story });

    expect(sketchAt(db, id)?.story_id).toBe(tree.story);
  });

  it("stamps both timestamps, and stamps them the same: nothing has changed yet", () => {
    const db = freshDb();
    const row = sketchAt(db, addSketch(db, drawing));

    expect(row?.created_at).toBe(row?.updated_at);
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the operator's own name rather than making one up", () => {
    const db = freshDb();
    const id = addSketch(db, { ...drawing, name: "Bob's daft idea" });

    expect(sketchAt(db, id)?.name).toBe("Bob's daft idea");
  });

  it("takes two sketches of the same name, because a redraw is a second sketch", () => {
    const db = freshDb();
    const first = addSketch(db, drawing);
    const second = addSketch(db, drawing);

    expect(second).not.toBe(first);
    expect(sketches(db)).toHaveLength(2);
  });

  it("flattens says onto one line however it arrived", () => {
    const db = freshDb();
    const id = addSketch(db, { ...drawing, says: "  three   screens\n  and no more\n" });

    expect(sketchAt(db, id)?.says).toBe("three screens and no more");
  });

  it.each([
    ["a name", { name: "   " }],
    ["a kind", { kind: "\n\t" }],
    ["a line saying what it is", { says: " " }],
    ["the path of its html", { html: "" }],
  ])("is refused when it has no %s", (why, missing) => {
    const db = freshDb();
    expect(() => addSketch(db, { ...drawing, ...missing })).toThrow(SketchError);
    expect(() => addSketch(db, { ...drawing, ...missing })).toThrow(`a sketch needs ${why}`);
    expect(sketches(db)).toEqual([]);
  });

  /** The kind is free text on purpose: which kinds there are is policy, and the schema is
   *  not where policy that changes belongs. */
  it("takes any kind the operator has a word for", () => {
    const db = freshDb();
    for (const kind of ["page", "flow", "component", "napkin"]) {
      addSketch(db, { ...drawing, kind });
    }

    expect(sketches(db).map((s) => s.kind)).toEqual(["napkin", "component", "flow", "page"]);
  });

  /** A sketch is a record of a drawing, not a check on one. Requiring the file first would
   *  make the order of two unrelated acts into a rule. */
  it("does not need the html to exist yet, and does not create it", () => {
    const db = freshDb();
    const path = join(tmp("wecode-sketch-"), "not-drawn-yet.html");

    expect(() => addSketch(db, { ...drawing, html: path })).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("listing sketches", () => {
  it("is newest first, because that is the one being asked about", () => {
    const db = freshDb();
    for (const name of ["oldest", "middle", "newest"]) addSketch(db, { ...drawing, name });

    expect(sketches(db).map((s) => s.name)).toEqual(["newest", "middle", "oldest"]);
  });

  it("takes the newest when a cap is asked for, not the first ones drawn", () => {
    const db = freshDb();
    for (const n of [1, 2, 3, 4, 5]) addSketch(db, { ...drawing, name: `sketch ${n}` });

    expect(sketches(db, 2).map((s) => s.name)).toEqual(["sketch 5", "sketch 4"]);
  });

  it("is empty before anybody has drawn anything", () => {
    expect(sketches(freshDb())).toEqual([]);
  });

  /** There is no parent to scope the read to, so every sketch in the record is the list —
   *  including the ones already promoted, which is how an operator sees what became of one. */
  it("shows the promoted ones beside the ones still only drawn", () => {
    const db = freshDb();
    const tree = seed(db);
    addSketch(db, { ...drawing, name: "still a sketch" });
    addSketch(db, { ...drawing, name: "became a story", story_id: tree.story });

    expect(sketches(db).map((s) => [s.name, s.story_id])).toEqual([
      ["became a story", tree.story],
      ["still a sketch", null],
    ]);
  });

  it("says nothing about a sketch that was never made", () => {
    expect(sketchAt(freshDb(), 404)).toBe(null);
  });
});

describe("dropping a sketch", () => {
  it("removes the row and leaves the file alone", () => {
    const db = freshDb();
    const path = drawn("<h1>recovery</h1>");
    const id = addSketch(db, { ...drawing, html: path });

    expect(dropSketch(db, id)).toBe(true);

    // The row is gone from the record...
    expect(sketchAt(db, id)).toBe(null);
    expect(db.prepare("SELECT count(*) AS n FROM sketch").get()).toEqual({ n: 0 });
    // ...and the drawing it pointed at is untouched, byte for byte. The file is the
    // operator's; only the row was ours to take away.
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("<h1>recovery</h1>");
  });

  it("takes that one and leaves the rest", () => {
    const db = freshDb();
    addSketch(db, { ...drawing, name: "keep this" });
    const wrong = addSketch(db, { ...drawing, name: "drawn by mistake" });

    expect(dropSketch(db, wrong)).toBe(true);
    expect(sketches(db).map((s) => s.name)).toEqual(["keep this"]);
  });

  /** There or gone, with no third answer. A sketch has no state machine, so nothing needs
   *  to be settled or cascaded before it can go — and nothing is left behind saying it
   *  once existed. */
  it("needs no state to be in and leaves no trace of the one it was not in", () => {
    const db = freshDb();
    const id = addSketch(db, drawing);

    expect(dropSketch(db, id)).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM ledger WHERE entity = 'sketch'").get()).toEqual({ n: 0 });
  });

  it("leaves the story it was promoted into standing", () => {
    const db = freshDb();
    const tree = seed(db);
    const id = addSketch(db, { ...drawing, story_id: tree.story });

    expect(dropSketch(db, id)).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM story WHERE id = ?").get(tree.story)).toEqual({ n: 1 });
  });

  it("says so when there was no such sketch, rather than pretending", () => {
    expect(dropSketch(freshDb(), 404)).toBe(false);
  });

  it("is over once: dropping the same sketch twice is false the second time", () => {
    const db = freshDb();
    const id = addSketch(db, drawing);

    expect(dropSketch(db, id)).toBe(true);
    expect(dropSketch(db, id)).toBe(false);
  });
});
