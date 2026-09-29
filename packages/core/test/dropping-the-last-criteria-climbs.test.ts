import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { cascadeAbandon, cascadeDrop } from "../src/cascade.js";
import { Engine } from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** The climb entered at a criteria somebody dropped directly, rather than at the
 *  acceptance_test whose drop emptied one. Two things follow from that entry point and
 *  from no other, so they are proved here rather than with the rest of the climb:
 *
 *  - the climb is upward only, so the acceptance_test and task still hanging under the
 *    dropped criteria are untouched by it — that tree is `cascadeDrop`'s to abandon, and a
 *    caller that runs only the climb has not abandoned it;
 *  - the two walks together settle the whole tree from the one drop, in either order. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const dropTheCriteria = (): void => {
  expect(engine.apply("acceptance_criteria", tree.criteria, "drop", "chief").ok).toBe(true);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
});

describe("the climb from a criteria dropped directly", () => {
  it("settles the requirement, story and epic it was the last criteria of", () => {
    dropTheCriteria();

    const r = cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(r.ok && r.dropped.map((d) => d.entity)).toEqual(["requirement", "story", "epic"]);
    expect(stateOf(db, "requirement", tree.requirement)).toBe("dropped");
    expect(stateOf(db, "story", tree.story)).toBe("dropped");
    expect(stateOf(db, "epic", tree.epic)).toBe("dropped");
    expect(stateOf(db, "release", tree.release)).toBe("in_progress");
  });

  it("climbs only: the test and task under the criteria are left where they were", () => {
    dropTheCriteria();

    cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("ready");
    expect(stateOf(db, "task", tree.task)).toBe("planned");
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("ready");
  });

  it("is the half of the cascade the downward walk does not do", () => {
    dropTheCriteria();

    cascadeDrop(db, "acceptance_criteria", tree.criteria);

    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("dropped");
    expect(stateOf(db, "requirement", tree.requirement)).toBe("in_progress");
  });

  it("settles the whole tree when both walks run, whichever goes first", () => {
    dropTheCriteria();

    expect(cascadeDrop(db, "acceptance_criteria", tree.criteria).ok).toBe(true);
    expect(cascadeAbandon(db, "acceptance_criteria", tree.criteria).ok).toBe(true);

    for (const [table, id] of [
      ["acceptance_test", tree.acceptance],
      ["task", tree.task],
      ["task_test", tree.taskTest],
      ["requirement", tree.requirement],
      ["story", tree.story],
      ["epic", tree.epic],
    ] as const) {
      expect([table, stateOf(db, table, id)]).toEqual([table, "dropped"]);
    }
  });

  it("proves nothing on the way up: the requirement is dropped, and `meet` is gone", () => {
    dropTheCriteria();

    cascadeAbandon(db, "acceptance_criteria", tree.criteria);

    expect(engine.may("requirement", tree.requirement, "meet").ok).toBe(false);
    expect(engine.may("story", tree.story, "deliver").ok).toBe(false);
  });
});
