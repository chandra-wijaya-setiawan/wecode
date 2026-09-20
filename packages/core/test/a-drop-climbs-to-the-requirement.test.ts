import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { cascadeAbandon } from "../src/cascade.js";
import { Engine } from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** a-criteria-with-no-tests-settles.test.ts starts the climb at an acceptance_test. This
 *  starts it a rung higher: somebody drops the criteria itself, and the requirement it was
 *  the last criteria of has nothing left to prove it. `met` is unreachable from there — the
 *  requirement is unprovable work on the board unless the drop is carried up to it. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-20T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

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

const ledger = (entity: string, id: number): { verb: string; to_state: string; actor: string }[] =>
  db
    .prepare("SELECT verb,to_state,actor FROM ledger WHERE entity = ? AND entity_id = ? ORDER BY id DESC")
    .all(entity, id) as { verb: string; to_state: string; actor: string }[];

/** Drop the requirement's only criteria, the way a person does. */
const dropTheLastCriteria = (): void => {
  expect(engine.apply("acceptance_criteria", tree.criteria, "drop", "chief").ok).toBe(true);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
});

describe("a requirement whose last criteria is dropped", () => {
  it("is settled, not left unprovable on the board", () => {
    dropTheLastCriteria();
    expect(stateOf(db, "requirement", tree.requirement)).toBe("in_progress");

    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(r.ok).toBe(true);
    expect(stateOf(db, "requirement", tree.requirement)).toBe("dropped");
  });

  it("is dropped, never met: all-dropped is not all-accepted", () => {
    dropTheLastCriteria();

    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(r.ok && r.dropped[0]).toEqual({
      entity: "requirement",
      id: tree.requirement,
      verb: "drop",
      from: "in_progress",
      to: "dropped",
      automatic: true,
    });
    expect(engine.may("requirement", tree.requirement, "meet").ok).toBe(false);
  });

  it("records it as nobody's decision, attributed to the cascade", () => {
    dropTheLastCriteria();
    cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(ledger("requirement", tree.requirement)[0])
      .toEqual({ verb: "drop", to_state: "dropped", actor: "cascade" });
  });

  it("leaves the criteria itself to the person who dropped it", () => {
    dropTheLastCriteria();
    const before = ledger("acceptance_criteria", tree.criteria);

    cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(ledger("acceptance_criteria", tree.criteria)).toEqual(before);
    expect(before[0]?.actor).toBe("chief");
  });

  it("carries on up: the story and epic it was the last of go with it", () => {
    dropTheLastCriteria();

    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(r.ok && r.dropped.map((d) => d.entity)).toEqual(["requirement", "story", "epic"]);
    expect(stateOf(db, "story", tree.story)).toBe("dropped");
    expect(stateOf(db, "epic", tree.epic)).toBe("dropped");
  });

  it("stops at the release: abandoning the work does not abandon the version", () => {
    dropTheLastCriteria();

    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(stateOf(db, "release", tree.release)).toBe("in_progress");
    expect(r.ok && r.held).toEqual({
      entity: "release",
      id: tree.release,
      why: `release #${tree.release} is not abandoned by a cascade: dropping it is a decision`,
    });
  });
});

describe("one live criteria is enough to hold the requirement", () => {
  it("leaves the requirement alone, and names the criteria that held it", () => {
    const second = addCriteria(tree.requirement, "second", "in_progress");
    dropTheLastCriteria();

    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(r.ok && r.dropped).toEqual([]);
    expect(r.ok && r.held).toEqual({
      entity: "requirement",
      id: tree.requirement,
      why: `requirement #${tree.requirement} still bears acceptance_criteria #${second} (in_progress)`,
    });
    expect(stateOf(db, "requirement", tree.requirement)).toBe("in_progress");
    expect(stateOf(db, "story", tree.story)).toBe("in_progress");
  });

  it("carries the requirement up but stops at a story a live sibling requirement holds", () => {
    const second = addRequirement(tree.story, "second", "in_progress");
    dropTheLastCriteria();

    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(r.ok && r.dropped.map((d) => d.entity)).toEqual(["requirement"]);
    expect(r.ok && r.held?.why).toContain(`requirement #${second} (in_progress)`);
    expect(stateOf(db, "requirement", tree.requirement)).toBe("dropped");
    expect(stateOf(db, "story", tree.story)).toBe("in_progress");
  });

  it("does not undo a requirement the machine will not drop", () => {
    db.prepare("UPDATE requirement SET state = 'met' WHERE id = ?").run(tree.requirement);
    dropTheLastCriteria();

    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(r.ok && r.dropped).toEqual([]);
    expect(r.ok && r.held?.why)
      .toBe(`requirement #${tree.requirement} is met: the machine will not drop it`);
    expect(stateOf(db, "requirement", tree.requirement)).toBe("met");
  });
});

describe("it only follows a drop", () => {
  it("refuses a criteria that is still live", () => {
    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.why)
      .toBe(`acceptance_criteria #${tree.criteria} is in_progress, not dropped: nothing to cascade`);
    expect(stateOf(db, "requirement", tree.requirement)).toBe("in_progress");
  });

  it("is safe to run twice", () => {
    dropTheLastCriteria();
    expect(cascadeAbandon(db, "acceptance_criteria", tree.criteria).ok).toBe(true);

    const again = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(again.ok && again.dropped).toEqual([]);
    expect(again.ok && again.held?.why)
      .toBe(`requirement #${tree.requirement} is dropped: the machine will not drop it`);
  });
});
