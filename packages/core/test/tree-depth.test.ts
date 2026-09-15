import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { type Node, tree } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const T = "2026-09-13T00:00:00.000Z";

let db: DatabaseSync;
let ids: ReturnType<typeof seed>;
/** a delivered story with one met requirement under it, and a dropped story with nothing */
let delivered: number;
let childless: number;

const lastId = (): number => (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

/** Every node in the returned shape, cut included. */
const flatten = (nodes: readonly Node[]): Node[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);

const entities = (nodes: readonly Node[]): string[] => [...new Set(flatten(nodes).map((n) => n.entity))];

const find = (nodes: readonly Node[], entity: string, id: number): Node => {
  const hit = flatten(nodes).find((n) => n.entity === entity && n.id === id);
  if (hit === undefined) throw new Error(`no ${entity} ${id} in the tree`);
  return hit;
};

const only = (nodes: readonly Node[]): Node => {
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
};

beforeEach(() => {
  db = freshDb();
  ids = seed(db);
  // seed leaves one of everything open. A second story, delivered, with one met
  // requirement under it, so the rollup has something in each bucket to count and the
  // counts differ between a node and its direct children.
  db.prepare("INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(
    "lockout",
    ids.epic,
    "lockout",
    "delivered",
    T,
    T,
  );
  delivered = lastId();
  db.prepare(
    "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run("no-lock", delivered, "three failures lock the account", "met", T, T);
  // and a dropped story with no children at all
  db.prepare("INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(
    "sms",
    ids.epic,
    "reset by sms",
    "dropped",
    T,
    T,
  );
  childless = lastId();
});

describe("tree depth", () => {
  it("stops at story by default", () => {
    const forest = tree(db, ids.project, {});
    expect(entities(forest)).toEqual(["project", "release", "epic", "story"]);
    expect(find(forest, "story", ids.story).children).toEqual([]);
  });

  it("reaches task_test at the deepest depth", () => {
    const forest = tree(db, ids.project, { depth: "task_test" });
    expect(entities(forest)).toEqual([
      "project",
      "release",
      "epic",
      "story",
      "requirement",
      "acceptance_criteria",
      "acceptance_test",
      "task",
      "task_test",
    ]);
    expect(find(forest, "task_test", ids.taskTest).children).toEqual([]);
  });

  it("returns every level when no options are passed, as it did before depth existed", () => {
    expect(entities(tree(db, ids.project))).toEqual(entities(tree(db, ids.project, { depth: "task_test" })));
    expect(find(tree(db, ids.project), "task", ids.task).id).toBe(ids.task);
  });

  it("cuts at any named level in between", () => {
    expect(entities(tree(db, ids.project, { depth: "project" }))).toEqual(["project"]);
    expect(entities(tree(db, ids.project, { depth: "epic" }))).toEqual(["project", "release", "epic"]);
    expect(entities(tree(db, ids.project, { depth: "task" }))).not.toContain("task_test");
  });
});

describe("tree rollup", () => {
  it("counts every descendant, not only the direct children", () => {
    const project = only(tree(db, ids.project, { depth: "task_test" }));
    // one each of release, epic, requirement, criteria, acceptance_test, task, task_test
    // open, plus the open story; one delivered story and one met requirement; one dropped story
    expect(project.rollup).toEqual({ done: 2, open: 8, failed: 1 });
    expect(project.children).toHaveLength(1);
  });

  it("counts the same descendants whether or not the tree is cut", () => {
    const deep = only(tree(db, ids.project, { depth: "task_test" }));
    const shallow = only(tree(db, ids.project, {}));
    expect(shallow.rollup).toEqual(deep.rollup);
    expect(find(tree(db, ids.project, {}), "story", ids.story).rollup).toEqual({ done: 0, open: 5, failed: 0 });
  });

  it("excludes the node's own state from its rollup", () => {
    const story = find(tree(db, ids.project, {}), "story", delivered);
    expect(story.state).toBe("delivered");
    expect(story.rollup).toEqual({ done: 1, open: 0, failed: 0 });
  });

  it("is all zeroes for a leaf", () => {
    const leaf = find(tree(db, ids.project, { depth: "task_test" }), "task_test", ids.taskTest);
    expect(leaf.rollup).toEqual({ done: 0, open: 0, failed: 0 });
  });

  it("reads the live state", () => {
    db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(ids.task);
    db.prepare("UPDATE task_test SET state = 'failed' WHERE id = ?").run(ids.taskTest);
    expect(only(tree(db, ids.project, {})).rollup).toEqual({ done: 3, open: 6, failed: 2 });
  });
});

describe("the fold marker", () => {
  it("is set exactly where children exist below the cut", () => {
    const forest = tree(db, ids.project, {});
    const folded = flatten(forest).filter((n) => n.folded);
    // the two stories that bear requirements, and nothing else: the childless story is at
    // the cut but has nothing behind it, and everything above the cut shows its children
    expect(folded.map((n) => [n.entity, n.id])).toEqual([
      ["story", ids.story],
      ["story", delivered],
    ]);
    expect(find(forest, "story", childless).folded).toBe(false);
  });

  it("is never set when nothing is cut off", () => {
    expect(flatten(tree(db, ids.project, { depth: "task_test" })).filter((n) => n.folded)).toEqual([]);
    expect(flatten(tree(db, ids.project)).filter((n) => n.folded)).toEqual([]);
  });

  it("is set on the project itself at depth project", () => {
    const project = only(tree(db, ids.project, { depth: "project" }));
    expect(project.folded).toBe(true);
    expect(project.rollup).toEqual({ done: 2, open: 8, failed: 1 });
  });

  it("clears once the children behind it are gone", () => {
    expect(find(tree(db, ids.project, {}), "story", delivered).folded).toBe(true);
    db.prepare("DELETE FROM requirement WHERE story_id = ?").run(delivered);
    expect(find(tree(db, ids.project, {}), "story", delivered).folded).toBe(false);
  });
});
