import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { cascadeReopen } from "../src/cascade.js";
import { Engine } from "../src/index.js";
import { nothingIsOpenUnderASettledParent } from "../src/invariants.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** a-drop-climbs-to-the-requirement.test.ts walks up from a drop. This walks up from the
 *  opposite event: a criteria that was accepted on a count of acceptance_tests, and then a
 *  new acceptance_test hung under it. The count no longer holds and nothing downward
 *  notices — from the criteria's side nothing is missing — so the new test is dispatchable
 *  work under a story that already said it was delivered. invariants.ts sees it from the
 *  child's side; this is the heal. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-20T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const addAcceptanceTest = (criteria: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    slug, criteria, "a second thing is proved", "script", "bash test/two.sh", state, T, T,
  );

const addCriteria = (requirement: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, requirement, "a second criteria", state, T, T,
  );

const ledger = (entity: string, id: number): { verb: string; to_state: string; actor: string }[] =>
  db
    .prepare("SELECT verb,to_state,actor FROM ledger WHERE entity = ? AND entity_id = ? ORDER BY id DESC")
    .all(entity, id) as { verb: string; to_state: string; actor: string }[];

const setState = (table: string, id: number, state: string): void => {
  db.prepare(`UPDATE ${table} SET state = ? WHERE id = ?`).run(state, id);
};

/** The chain as it stands the moment the last acceptance_test passed: everything above the
 *  criteria settled on a guard over the children it could see then. */
const settleTheChain = (): void => {
  setState("acceptance_test", tree.acceptance, "passed");
  setState("task", tree.task, "done");
  setState("task_test", tree.taskTest, "passed");
  setState("acceptance_criteria", tree.criteria, "accepted");
  setState("requirement", tree.requirement, "met");
  setState("story", tree.story, "delivered");
  setState("epic", tree.epic, "delivered");
};

/** What the doctor says about the tree, as sentences. */
const findings = (): string[] =>
  nothingIsOpenUnderASettledParent({
    nodes: [
      { entity: "epic", id: tree.epic, slug: "recovery", state: stateOf(db, "epic", tree.epic), parent_id: tree.release },
      { entity: "story", id: tree.story, slug: "reset", state: stateOf(db, "story", tree.story), parent_id: tree.epic },
      { entity: "requirement", id: tree.requirement, slug: "one-change", state: stateOf(db, "requirement", tree.requirement), parent_id: tree.story },
      { entity: "acceptance_criteria", id: tree.criteria, slug: "emailed", state: stateOf(db, "acceptance_criteria", tree.criteria), parent_id: tree.requirement },
      ...(db.prepare("SELECT id,slug,state FROM acceptance_test WHERE parent_id = ?").all(tree.criteria) as {
        id: number;
        slug: string;
        state: string;
      }[]).map((r) => ({ entity: "acceptance_test" as const, id: r.id, slug: r.slug, state: r.state, parent_id: tree.criteria })),
    ],
    workers: [],
  }).map((v) => v.detail);

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
});

describe("a new acceptance_test under an accepted criteria", () => {
  it("reopens the criteria, which was accepted on a count that no longer holds", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    const r = cascadeReopen(db, "acceptance_test", second);

    expect(r.ok).toBe(true);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
  });

  it("reopens it as nobody's decision, attributed to the cascade", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    cascadeReopen(db, "acceptance_test", second);

    expect(ledger("acceptance_criteria", tree.criteria)[0])
      .toEqual({ verb: "reopen", to_state: "in_progress", actor: "cascade" });
  });

  it("names every rung it revived, and from where", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    const r = cascadeReopen(db, "acceptance_test", second);

    expect(r.ok && r.reopened).toEqual([
      { entity: "acceptance_criteria", id: tree.criteria, verb: "reopen", from: "accepted", to: "in_progress", automatic: true },
      { entity: "requirement", id: tree.requirement, verb: "reopen", from: "met", to: "in_progress", automatic: true },
      { entity: "story", id: tree.story, verb: "reopen", from: "delivered", to: "in_progress", automatic: true },
      { entity: "epic", id: tree.epic, verb: "reopen", from: "delivered", to: "in_progress", automatic: true },
    ]);
  });

  it("carries all the way up: the story no longer claims to be delivered", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    cascadeReopen(db, "acceptance_test", second);

    expect(stateOf(db, "requirement", tree.requirement)).toBe("in_progress");
    expect(stateOf(db, "story", tree.story)).toBe("in_progress");
    expect(stateOf(db, "epic", tree.epic)).toBe("in_progress");
  });

  it("leaves the new child itself alone: the walk is upward only", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    cascadeReopen(db, "acceptance_test", second);

    expect(stateOf(db, "acceptance_test", second)).toBe("planned");
    expect(ledger("acceptance_test", second)).toEqual([]);
  });

  it("does not undo the sibling that did pass, or the task that did finish", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    cascadeReopen(db, "acceptance_test", second);

    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("passed");
    expect(stateOf(db, "task", tree.task)).toBe("done");
  });

  it("proves nothing on the way up: no completion transition fires", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    cascadeReopen(db, "acceptance_test", second);

    expect(ledger("story", tree.story).map((l) => l.verb)).toEqual(["reopen"]);
    expect(engine.may("story", tree.story, "deliver").ok).toBe(false);
  });

  it("clears the finding the doctor raised about it", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");
    expect(findings()).toEqual([
      `planned under acceptance_criteria emailed #${tree.criteria}, which is accepted — its parent is settled and it is not`,
    ]);

    cascadeReopen(db, "acceptance_test", second);

    expect(findings()).toEqual([]);
  });
});

describe("it stops at the first ancestor that is already open", () => {
  it("reopens the criteria and no further when the requirement never settled", () => {
    settleTheChain();
    setState("requirement", tree.requirement, "in_progress");
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    const r = cascadeReopen(db, "acceptance_test", second);

    expect(r.ok && r.reopened.map((x) => x.entity)).toEqual(["acceptance_criteria"]);
    expect(r.ok && r.held).toBe(null);
    expect(stateOf(db, "story", tree.story)).toBe("delivered");
  });

  it("stops at a criteria that is merely on the board, touching nothing at all", () => {
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    const r = cascadeReopen(db, "acceptance_test", second);

    expect(r.ok && r.reopened).toEqual([]);
    expect(r.ok && r.held).toBe(null);
    expect(ledger("acceptance_criteria", tree.criteria)).toEqual([]);
  });

  it("is safe to run twice", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "planned");
    expect(cascadeReopen(db, "acceptance_test", second).ok).toBe(true);

    const again = cascadeReopen(db, "acceptance_test", second);

    expect(again.ok && again.reopened).toEqual([]);
    expect(again.ok && again.held).toBe(null);
  });
});

describe("what a cascade will not revive", () => {
  it("stops at the release: reviving a shipped version is a decision", () => {
    settleTheChain();
    setState("release", tree.release, "released");
    const second = addCriteria(tree.requirement, "second", "planned");

    const r = cascadeReopen(db, "acceptance_criteria", second);

    expect(r.ok && r.reopened.map((x) => x.entity)).toEqual(["requirement", "story", "epic"]);
    expect(r.ok && r.held).toEqual({
      entity: "release",
      id: tree.release,
      why: `release #${tree.release} is not reopened by a cascade: reviving it is a decision`,
    });
    expect(stateOf(db, "release", tree.release)).toBe("released");
  });

  it("stops at a dropped release too, which the machine would otherwise reopen", () => {
    settleTheChain();
    setState("epic", tree.epic, "dropped");
    setState("release", tree.release, "dropped");
    const second = addAcceptanceTest(tree.criteria, "second", "planned");

    const r = cascadeReopen(db, "acceptance_test", second);

    expect(r.ok && r.held?.entity).toBe("release");
    expect(stateOf(db, "release", tree.release)).toBe("dropped");
    expect(stateOf(db, "epic", tree.epic)).toBe("in_progress");
  });

  it("stops at a done task: a task that finished on a branch of its own is revived by a person", () => {
    settleTheChain();
    const second = ins(
      "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      "second", tree.task, "a second unit is proved", "script", "vitest run two", "planned", T, T,
    );

    const r = cascadeReopen(db, "task_test", second);

    expect(r.ok && r.reopened).toEqual([]);
    expect(r.ok && r.held).toEqual({
      entity: "task",
      id: tree.task,
      why: `task #${tree.task} is not reopened by a cascade: reviving it is a decision`,
    });
    expect(stateOf(db, "task", tree.task)).toBe("done");
  });
});

describe("it only follows a live child", () => {
  it("refuses a child that is dropped: nothing is owed to abandoned work", () => {
    settleTheChain();
    const second = addAcceptanceTest(tree.criteria, "second", "dropped");

    const r = cascadeReopen(db, "acceptance_test", second);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.why)
      .toBe(`acceptance_test #${second} is dropped, not open: nothing to cascade`);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("accepted");
  });

  it("refuses a child that succeeded: a passed test is what the parent settled on", () => {
    settleTheChain();

    const r = cascadeReopen(db, "acceptance_test", tree.acceptance);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.why)
      .toBe(`acceptance_test #${tree.acceptance} is passed, not open: nothing to cascade`);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("accepted");
  });

  it("refuses a row that is not there", () => {
    const r = cascadeReopen(db, "acceptance_test", 9999);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toBe("no acceptance_test #9999");
  });
});
