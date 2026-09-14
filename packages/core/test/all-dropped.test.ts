import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/index.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

/** Dropping the last live child used to satisfy the success guards — all-dropped is
 *  all-settled — so the parent cascaded to a success state it could not come back from:
 *  drop is not legal from one. Story 148 is delivered and empty to this day, and four more
 *  landed doing nothing the same way. Every case here cascades to success against the code
 *  as it was. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-14T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const addTest = (criteria: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    slug, criteria, "a second thing is proved", "script", "bash test/two.sh", state, T, T,
  );

const addCriteria = (requirement: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, requirement, "a second criteria", state, T, T,
  );

const addRequirement = (story: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, story, "a second requirement", state, T, T,
  );

const addStory = (epic: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, epic, "a second story", state, T, T,
  );

/** Drop the whole tree below `level`, so that level's last live child is the one dropped. */
const dropDownTo = (level: "criteria" | "requirement" | "story"): void => {
  expect(engine.apply("acceptance_test", tree.acceptance, "drop", "chief").ok).toBe(true);
  if (level === "criteria") return;
  expect(engine.apply("acceptance_criteria", tree.criteria, "drop", "chief").ok).toBe(true);
  if (level === "requirement") return;
  expect(engine.apply("requirement", tree.requirement, "drop", "chief").ok).toBe(true);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
  recordRed(db, tree.acceptance);
});

describe("dropping the last child does not prove the parent", () => {
  it("leaves the criteria where it was, and droppable, when its last test is dropped", () => {
    const r = engine.apply("acceptance_test", tree.acceptance, "drop", "chief");
    expect(r.ok).toBe(true);
    expect(r.ok && r.changes.map((c) => `${c.entity}:${c.to}`)).toEqual(["acceptance_test:dropped"]);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");

    expect(engine.may("acceptance_criteria", tree.criteria, "drop").ok).toBe(true);
    expect(engine.apply("acceptance_criteria", tree.criteria, "drop", "chief").ok).toBe(true);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("dropped");
  });

  it("leaves the requirement where it was, and droppable, when its last criteria is dropped", () => {
    dropDownTo("requirement");
    expect(stateOf(db, "requirement", tree.requirement)).toBe("in_progress");

    expect(engine.may("requirement", tree.requirement, "drop").ok).toBe(true);
    expect(engine.apply("requirement", tree.requirement, "drop", "chief").ok).toBe(true);
    expect(stateOf(db, "requirement", tree.requirement)).toBe("dropped");
  });

  it("leaves the story where it was, and droppable, when its last requirement is dropped", () => {
    dropDownTo("story");
    expect(stateOf(db, "story", tree.story)).toBe("in_progress");

    expect(engine.may("story", tree.story, "drop").ok).toBe(true);
    expect(engine.apply("story", tree.story, "drop", "chief").ok).toBe(true);
    expect(stateOf(db, "story", tree.story)).toBe("dropped");
  });

  it("leaves the epic where it was, and droppable, when its last story is dropped", () => {
    dropDownTo("story");
    expect(engine.apply("story", tree.story, "drop", "chief").ok).toBe(true);
    expect(stateOf(db, "epic", tree.epic)).toBe("in_progress");

    expect(engine.may("epic", tree.epic, "drop").ok).toBe(true);
    expect(engine.apply("epic", tree.epic, "drop", "chief").ok).toBe(true);
    expect(stateOf(db, "epic", tree.epic)).toBe("dropped");
  });

  it("drops the task when its last task_test is dropped, rather than finishing it", () => {
    expect(engine.apply("task", tree.task, "start", "chief").ok).toBe(true);
    expect(engine.apply("task_test", tree.taskTest, "drop", "runner").ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("ready");

    expect(engine.may("task", tree.task, "finish").ok).toBe(false);
    expect(engine.apply("task", tree.task, "drop", "chief").ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("dropped");
  });

  it("says why, naming what was dropped", () => {
    engine.apply("acceptance_test", tree.acceptance, "drop", "chief");
    const r = engine.may("acceptance_criteria", tree.criteria, "accept");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("all 1 acceptance_test are dropped");
  });

  it("does not cascade an all-dropped tree to success on settle either", () => {
    dropDownTo("story");
    expect(engine.apply("story", tree.story, "drop", "chief").ok).toBe(true);
    expect(engine.settle()).toEqual([]);
    expect(stateOf(db, "epic", tree.epic)).toBe("in_progress");
  });
});

describe("one child that succeeded is enough", () => {
  it("accepts the criteria when one test passed and the rest are dropped", () => {
    const second = addTest(tree.criteria, "mail-twice", "ready");
    recordRed(db, second);
    expect(engine.apply("acceptance_test", second, "pass", "runner").ok).toBe(true);
    expect(engine.apply("acceptance_test", tree.acceptance, "drop", "chief").ok).toBe(true);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("accepted");
  });

  it("meets the requirement when one criteria was accepted and the rest are dropped", () => {
    addCriteria(tree.requirement, "second", "accepted");
    dropDownTo("requirement");
    expect(stateOf(db, "requirement", tree.requirement)).toBe("met");
  });

  it("delivers the story when one requirement was met and the rest are dropped", () => {
    addRequirement(tree.story, "second", "met");
    dropDownTo("story");
    expect(stateOf(db, "story", tree.story)).toBe("delivered");
  });

  it("delivers the epic when one story was delivered and the rest are dropped", () => {
    addStory(tree.epic, "second", "delivered");
    dropDownTo("story");
    expect(engine.apply("story", tree.story, "drop", "chief").ok).toBe(true);
    expect(stateOf(db, "epic", tree.epic)).toBe("delivered");
  });
});

describe("a childless parent proves nothing, at any level", () => {
  const empty: [string, number][] = [];

  beforeEach(() => {
    empty.length = 0;
    empty.push(
      ["acceptance_criteria", addCriteria(tree.requirement, "empty-criteria", "in_progress")],
      ["requirement", addRequirement(tree.story, "empty-requirement", "in_progress")],
      ["story", addStory(tree.epic, "empty-story", "in_progress")],
    );
  });

  it("refuses the success verb and says there is nothing to prove it", () => {
    for (const [entity, id] of empty) {
      const verb = { acceptance_criteria: "accept", requirement: "meet", story: "deliver" }[entity] as string;
      const r = engine.may(entity as "story", id, verb);
      expect(r.ok, `${entity} ${verb}`).toBe(false);
      expect(!r.ok && r.why).toContain("nothing proves it");
    }
  });

  it("is never carried to success by settle", () => {
    engine.settle();
    for (const [entity, id] of empty) expect(stateOf(db, entity, id)).toBe("in_progress");
  });

  it("may still be dropped by somebody who says so", () => {
    for (const [entity, id] of empty) {
      expect(engine.apply(entity as "story", id, "drop", "chief").ok, entity).toBe(true);
      expect(stateOf(db, entity, id)).toBe("dropped");
    }
  });
});
