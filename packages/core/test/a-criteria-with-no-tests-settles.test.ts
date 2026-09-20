import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { cascadeAbandon } from "../src/cascade.js";
import { Engine } from "../src/index.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

/** A criteria whose last acceptance_test is dropped can never be accepted again — `accept`
 *  refuses it with "all 1 acceptance_test are dropped" for ever after. all-dropped.test.ts
 *  pins the half of that which matters most: it must not be proved. This is the other half.
 *  Unprovable is not the same as open, and the criteria is settled here as what it is. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-20T00:00:00.000Z";

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

/** The ledger line an abandonment leaves, newest first. */
const ledger = (entity: string, id: number): { verb: string; to_state: string; actor: string }[] =>
  db
    .prepare("SELECT verb,to_state,actor FROM ledger WHERE entity = ? AND entity_id = ? ORDER BY id DESC")
    .all(entity, id) as { verb: string; to_state: string; actor: string }[];

/** Drop the criteria's only acceptance_test, the way a person does. */
const dropTheLastTest = (): void => {
  expect(engine.apply("acceptance_test", tree.acceptance, "drop", "chief").ok).toBe(true);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
  recordRed(db, tree.acceptance);
});

describe("a criteria whose last acceptance_test is dropped", () => {
  it("is settled, not left open", () => {
    dropTheLastTest();
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");

    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok).toBe(true);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("dropped");
  });

  it("is dropped, never accepted: all-dropped is not all-passed", () => {
    dropTheLastTest();
    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok && r.dropped.map((d) => `${d.entity}:${d.from}->${d.to}`)[0])
      .toBe("acceptance_criteria:in_progress->dropped");
    expect(r.ok && r.dropped.every((d) => d.to === "dropped")).toBe(true);
    expect(engine.may("acceptance_criteria", tree.criteria, "accept").ok).toBe(false);
  });

  it("records it as nobody's decision, attributed to the cascade", () => {
    dropTheLastTest();
    cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(ledger("acceptance_criteria", tree.criteria)[0])
      .toEqual({ verb: "drop", to_state: "dropped", actor: "cascade" });
  });

  it("is nobody's transition: every drop it makes is automatic", () => {
    dropTheLastTest();
    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok && r.dropped.every((d) => d.automatic && d.verb === "drop")).toBe(true);
  });

  it("carries on up: the requirement, story and epic it was the last of go with it", () => {
    dropTheLastTest();
    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok && r.dropped.map((d) => d.entity)).toEqual([
      "acceptance_criteria",
      "requirement",
      "story",
      "epic",
    ]);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("dropped");
    expect(stateOf(db, "requirement", tree.requirement)).toBe("dropped");
    expect(stateOf(db, "story", tree.story)).toBe("dropped");
    expect(stateOf(db, "epic", tree.epic)).toBe("dropped");
  });

  it("stops at the release: abandoning the work does not abandon the version", () => {
    dropTheLastTest();
    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(stateOf(db, "release", tree.release)).toBe("in_progress");
    expect(stateOf(db, "project", tree.project)).toBe("in_progress");
    expect(r.ok && r.held).toEqual({
      entity: "release",
      id: tree.release,
      why: `release #${tree.release} is not abandoned by a cascade: dropping it is a decision`,
    });
  });
});

describe("one live child is enough to hold the parent", () => {
  it("leaves the criteria alone while a sibling test is still ready", () => {
    const second = addTest(tree.criteria, "mail-twice", "ready");
    dropTheLastTest();

    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok && r.dropped).toEqual([]);
    expect(r.ok && r.held).toEqual({
      entity: "acceptance_criteria",
      id: tree.criteria,
      why: `acceptance_criteria #${tree.criteria} still bears acceptance_test #${second} (ready)`,
    });
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
  });

  it("leaves it alone when the sibling passed, because that is a criteria worth accepting", () => {
    const second = addTest(tree.criteria, "mail-twice", "ready");
    recordRed(db, second);
    expect(engine.apply("acceptance_test", second, "pass", "runner").ok).toBe(true);
    dropTheLastTest();

    // the sibling passing already accepted the criteria on the way through apply()
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("accepted");
    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok && r.dropped).toEqual([]);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("accepted");
  });

  it("stops at the requirement a live criteria holds, and names what held it", () => {
    const second = addCriteria(tree.requirement, "second", "in_progress");
    dropTheLastTest();

    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok && r.dropped.map((d) => d.entity)).toEqual(["acceptance_criteria"]);
    expect(r.ok && r.held?.why).toContain(`acceptance_criteria #${second} (in_progress)`);
    expect(stateOf(db, "requirement", tree.requirement)).toBe("in_progress");
    expect(stateOf(db, "story", tree.story)).toBe("in_progress");
  });

  it("does not undo a success the machine will not drop", () => {
    db.prepare("UPDATE requirement SET state = 'met' WHERE id = ?").run(tree.requirement);
    dropTheLastTest();

    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok && r.dropped.map((d) => d.entity)).toEqual(["acceptance_criteria"]);
    expect(r.ok && r.held?.why)
      .toBe(`requirement #${tree.requirement} is met: the machine will not drop it`);
    expect(stateOf(db, "requirement", tree.requirement)).toBe("met");
  });
});

describe("it only follows a drop", () => {
  it("refuses a row that is still live, and says there is nothing to cascade", () => {
    const r = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toBe(`acceptance_test #${tree.acceptance} is ready, not dropped: nothing to cascade`);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
  });

  it("does not abandon a task whose last task_test is dropped: giving up a task is a decision", () => {
    expect(engine.apply("task_test", tree.taskTest, "drop", "chief").ok).toBe(true);

    const r = cascadeAbandon(db, "task_test", tree.taskTest);

    expect(r.ok && r.dropped).toEqual([]);
    expect(r.ok && r.held?.entity).toBe("task");
    expect(stateOf(db, "task", tree.task)).toBe("planned");
  });

  it("refuses a row that is not there", () => {
    const r = cascadeAbandon(db, "acceptance_test", 9999);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toBe("no acceptance_test #9999");
  });

  it("is safe to run twice: the second pass finds every ancestor already dropped", () => {
    dropTheLastTest();
    expect(cascadeAbandon(db, "acceptance_test", tree.acceptance).ok).toBe(true);

    const again = cascadeAbandon(db, "acceptance_test", tree.acceptance);

    expect(again.ok && again.dropped).toEqual([]);
    expect(again.ok && again.held?.why)
      .toBe(`acceptance_criteria #${tree.criteria} is dropped: the machine will not drop it`);
  });
});
