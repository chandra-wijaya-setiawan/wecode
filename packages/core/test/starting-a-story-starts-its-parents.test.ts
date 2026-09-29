import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { cascadeStart } from "../src/cascade.js";
import { Engine } from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** The upward half of the cascade that apply.ts does not run. apply.ts climbs only on a
 *  *completion*, so a story started under a planned epic left the whole spine above it
 *  planned. The downward half — abandonment — is drop-cascades-to-tests.test.ts's subject.
 */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

/** The seed starts every node. Put the spine above the story back where a freshly planned
 *  tree has it, so starting the story is the first beginning anywhere. */
const plan = (...tables: string[]) => {
  for (const t of tables) {
    db.prepare(`UPDATE ${t} SET state = 'planned' WHERE id = ?`).run(
      tree[t as "story" | "epic" | "release" | "project"],
    );
  }
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
});

describe("starting a story starts the epic and release above it", () => {
  beforeEach(() => plan("story", "epic", "release", "project"));

  it("starts every planned ancestor, up to the project", () => {
    expect(engine.apply("story", tree.story, "start", "chief").ok).toBe(true);

    const r = cascadeStart(db, "story", tree.story);
    expect(r.ok).toBe(true);
    expect(stateOf(db, "epic", tree.epic)).toBe("in_progress");
    expect(stateOf(db, "release", tree.release)).toBe("in_progress");
    expect(stateOf(db, "project", tree.project)).toBe("in_progress");
  });

  it("names each one it started, parent first, as automatic", () => {
    engine.apply("story", tree.story, "start", "chief");
    const r = cascadeStart(db, "story", tree.story);

    expect(r.ok && r.started).toEqual([
      { entity: "epic", id: tree.epic, verb: "start", from: "planned", to: "in_progress", automatic: true },
      { entity: "release", id: tree.release, verb: "start", from: "planned", to: "in_progress", automatic: true },
      { entity: "project", id: tree.project, verb: "start", from: "planned", to: "in_progress", automatic: true },
    ]);
    expect(r.ok && r.kept).toEqual([]);
  });

  it("leaves the story itself alone: the actor who started it stays the actor", () => {
    engine.apply("story", tree.story, "start", "chief");
    cascadeStart(db, "story", tree.story);

    expect(stateOf(db, "story", tree.story)).toBe("in_progress");
    const lines = db
      .prepare("SELECT actor FROM ledger WHERE entity = 'story' AND entity_id = ?")
      .all(tree.story) as { actor: string }[];
    expect(lines.map((l) => l.actor)).toEqual(["chief"]);
  });

  it("writes one ledger line per ancestor, attributed to the cascade", () => {
    engine.apply("story", tree.story, "start", "chief");
    cascadeStart(db, "story", tree.story);

    const lines = db
      .prepare(
        "SELECT entity, verb, from_state, to_state, actor FROM ledger WHERE actor = 'cascade' ORDER BY id",
      )
      .all() as { entity: string; verb: string; from_state: string; to_state: string }[];
    expect(lines).toEqual([
      { entity: "epic", verb: "start", from_state: "planned", to_state: "in_progress", actor: "cascade" },
      { entity: "release", verb: "start", from_state: "planned", to_state: "in_progress", actor: "cascade" },
      { entity: "project", verb: "start", from_state: "planned", to_state: "in_progress", actor: "cascade" },
    ]);
  });

  it("touches nothing twice: a second run finds everything already begun", () => {
    engine.apply("story", tree.story, "start", "chief");
    cascadeStart(db, "story", tree.story);

    const again = cascadeStart(db, "story", tree.story);
    expect(again.ok && again.started).toEqual([]);
    expect(again.ok && again.kept.map((k) => k.entity)).toEqual(["epic", "release", "project"]);
  });
});

describe("what it refuses to cascade from", () => {
  it("refuses a row that has not started itself", () => {
    plan("story");
    const r = cascadeStart(db, "story", tree.story);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("is planned, not started");
    expect(stateOf(db, "epic", tree.epic)).toBe("in_progress");
  });

  it("refuses a row that is not there", () => {
    const r = cascadeStart(db, "story", 9999);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toBe("no story #9999");
  });

  it("cascades from any depth, not just a story", () => {
    plan("epic", "release", "project");
    const r = cascadeStart(db, "requirement", tree.requirement);
    expect(r.ok && r.started.map((s) => s.entity)).toEqual(["epic", "release", "project"]);
    expect(stateOf(db, "story", tree.story)).toBe("in_progress");
  });

  it("has nothing to climb above a project", () => {
    const r = cascadeStart(db, "project", tree.project);
    expect(r.ok && r.started).toEqual([]);
    expect(r.ok && r.kept).toEqual([]);
  });
});

describe("an ancestor the machine will not start", () => {
  it("keeps one on hold, and says which state kept it", () => {
    plan("story", "release", "project");
    db.prepare("UPDATE epic SET state = 'on_hold' WHERE id = ?").run(tree.epic);
    engine.apply("story", tree.story, "start", "chief");

    const r = cascadeStart(db, "story", tree.story);
    expect(r.ok && r.kept).toEqual([{ entity: "epic", id: tree.epic, state: "on_hold" }]);
    expect(stateOf(db, "epic", tree.epic)).toBe("on_hold");
  });

  it("keeps climbing past it: a planned release above a held epic still starts", () => {
    plan("story", "release", "project");
    db.prepare("UPDATE epic SET state = 'on_hold' WHERE id = ?").run(tree.epic);
    engine.apply("story", tree.story, "start", "chief");

    cascadeStart(db, "story", tree.story);
    expect(stateOf(db, "release", tree.release)).toBe("in_progress");
    expect(stateOf(db, "project", tree.project)).toBe("in_progress");
  });

  it("does not reopen a dropped ancestor", () => {
    plan("story", "release");
    db.prepare("UPDATE epic SET state = 'dropped' WHERE id = ?").run(tree.epic);
    engine.apply("story", tree.story, "start", "chief");

    const r = cascadeStart(db, "story", tree.story);
    expect(r.ok && r.kept[0]).toEqual({ entity: "epic", id: tree.epic, state: "dropped" });
    expect(stateOf(db, "epic", tree.epic)).toBe("dropped");
  });
});

describe("it is one transaction", () => {
  it("writes the whole spine or none of it", () => {
    plan("story", "epic", "release", "project");
    engine.apply("story", tree.story, "start", "chief");

    // The epic starts, then the release refuses to be written. If the walk were not one
    // transaction the epic would be left started under a planned release.
    db.exec("CREATE TRIGGER no_release BEFORE UPDATE ON release BEGIN SELECT RAISE(ABORT, 'no'); END");

    expect(() => cascadeStart(db, "story", tree.story)).toThrow();
    expect(stateOf(db, "epic", tree.epic)).toBe("planned");
    expect(stateOf(db, "project", tree.project)).toBe("planned");
  });
});
