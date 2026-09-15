import { describe, expect, it } from "vitest";
import { board } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** The filter holds every epic and story still open — planned and in_progress alike — so
 *  `roadmap` named a thing the query never selected. The name is `open`, and `roadmap` is
 *  gone from the board rather than kept beside it as an alias. */
describe("the open filter", () => {
  it("is reachable as open, and roadmap is not a key of the board", () => {
    const db = freshDb();
    seed(db);
    const b = board(db);

    expect(Array.isArray(b.open)).toBe(true);
    expect("roadmap" in b).toBe(false);
  });

  it("carries an epic that is only planned beside a story in progress", () => {
    const db = freshDb();
    const tree = seed(db);
    const T = "2026-09-13T00:00:00.000Z";
    db.prepare(
      "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("billing", tree.release, "billing", "planned", T, T);
    const planned = (db.prepare("SELECT id FROM epic WHERE slug = 'billing'").get() as { id: number }).id;

    const rows = board(db).open;

    expect(rows.find((r) => r.id === planned)).toMatchObject({
      what: "billing",
      state: "planned",
      detail: "epic",
    });
    expect(rows.find((r) => r.id === tree.story && r.detail.endsWith("tasks"))).toMatchObject({
      what: "password reset",
      state: "in_progress",
    });
  });
});
