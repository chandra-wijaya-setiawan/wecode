import { describe, expect, it } from "vitest";
import { CreateError, Maker } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** The seeded acceptance_test, forced to the state under test. The machine's own verbs will
 *  not reach `passed` without a red run on record, and the point here is the parent's state,
 *  not the route it took to get there. */
const parentIn = (state: string) => {
  const db = freshDb();
  const { acceptance } = seed(db);
  db.prepare("UPDATE acceptance_test SET state = ? WHERE id = ?").run(state, acceptance);
  return { db, acceptance, make: new Maker(db) };
};

describe("a task is refused under a settled acceptance_test", () => {
  for (const state of ["passed", "failed", "dropped"]) {
    it(`refuses a ${state} parent, and names the state`, () => {
      const { make, acceptance } = parentIn(state);
      expect(() => make.task(acceptance, "do the thing")).toThrow(CreateError);
      let why = "";
      try {
        make.task(acceptance, "do the thing");
      } catch (err) {
        why = (err as Error).message;
      }
      expect(why).toContain(state);
      expect(why).toContain(`acceptance_test #${acceptance}`);
      expect(why).toContain("another parent");
    });

    it(`writes no task row under a ${state} parent`, () => {
      const { db, make, acceptance } = parentIn(state);
      const before = (db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n;
      expect(() => make.task(acceptance, "do the thing")).toThrow(CreateError);
      expect((db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n).toBe(before);
    });
  }

  it("a passed or failed parent is told to re-prove it; a dropped one is not", () => {
    for (const state of ["passed", "failed"]) {
      const { make, acceptance } = parentIn(state);
      expect(() => make.task(acceptance, "do the thing")).toThrow(/re-prove it/i);
    }
    const { make, acceptance } = parentIn("dropped");
    expect(() => make.task(acceptance, "do the thing")).toThrow(/never re-proved/i);
  });

  for (const state of ["planned", "ready"]) {
    it(`accepts a task under a ${state} parent`, () => {
      const { db, make, acceptance } = parentIn(state);
      const id = make.task(acceptance, "send the reset mail again");
      const row = db.prepare("SELECT acceptance_test_id, state FROM task WHERE id = ?").get(id) as {
        acceptance_test_id: number;
        state: string;
      };
      expect(row.acceptance_test_id).toBe(acceptance);
      expect(row.state).toBe("planned");
    });
  }
});
