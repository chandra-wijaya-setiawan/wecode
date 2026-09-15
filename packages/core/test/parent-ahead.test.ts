import { describe, expect, it } from "vitest";
import { Engine, Repo, registry } from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** The seeded tree with the task's parent acceptance_test forced to `state`. The seed
 *  leaves it `ready`, which is what a task is normally created under; the subject here is
 *  what `start` does when the parent never got that far. */
const parentIn = (state: string) => {
  const db = freshDb();
  const tree = seed(db);
  db.prepare("UPDATE acceptance_test SET state = ? WHERE id = ?").run(state, tree.acceptance);
  return { db, tree, engine: new Engine(db) };
};

const why = (r: { ok: boolean; why?: string }): string => (r.ok ? "" : (r.why ?? ""));

describe("a task is refused a start under a planned acceptance_test", () => {
  it("refuses, and names the parent and the state", () => {
    const { engine, tree } = parentIn("planned");
    const r = engine.apply("task", tree.task, "start", "chief");
    expect(r.ok).toBe(false);
    expect(why(r)).toContain(`acceptance_test #${tree.acceptance}`);
    expect(why(r)).toContain("planned");
  });

  it("names the command that clears it, and that command is legal from planned", () => {
    const { db, engine, tree } = parentIn("planned");
    expect(why(engine.apply("task", tree.task, "start", "chief"))).toContain(
      "`wecode acceptance_test deliver <id>`",
    );
    // Not merely quotable: the verb the refusal names actually moves the parent on.
    expect(engine.apply("acceptance_test", tree.acceptance, "deliver", "chief").ok).toBe(true);
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("ready");
  });

  it("leaves the task in planned, so nothing is dispatched", () => {
    const { db, engine, tree } = parentIn("planned");
    expect(engine.apply("task", tree.task, "start", "chief").ok).toBe(false);
    expect(stateOf(db, "task", tree.task)).toBe("planned");
  });

  it("refuses the same before anything is written, so `may` agrees with `apply`", () => {
    const { engine, tree } = parentIn("planned");
    const asked = engine.may("task", tree.task, "start");
    expect(asked.ok).toBe(false);
    expect(why(asked)).toBe(why(engine.apply("task", tree.task, "start", "chief")));
  });

  it("allows the start once the parent is delivered", () => {
    const { db, engine, tree } = parentIn("planned");
    engine.apply("acceptance_test", tree.acceptance, "deliver", "chief");
    expect(engine.apply("task", tree.task, "start", "chief").ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });

  it("allows a start under a ready parent — the seeded case is untouched", () => {
    const { db, engine, tree } = parentIn("ready");
    expect(engine.apply("task", tree.task, "start", "chief").ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });

  it("allows a start under a failed parent, which a retry is exactly for", () => {
    const { db, engine, tree } = parentIn("failed");
    expect(engine.apply("task", tree.task, "start", "chief").ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });

  it("asks the task's own tests first: a planned task_test still answers for itself", () => {
    const { db, engine, tree } = parentIn("planned");
    db.prepare("UPDATE task_test SET state = 'planned' WHERE id = ?").run(tree.taskTest);
    expect(why(engine.apply("task", tree.task, "start", "chief"))).toContain("no task_test is ready");
  });

  it("reads the parent through the same link the cascade climbs", () => {
    const { db, tree } = parentIn("planned");
    const repo = new Repo(db);
    expect(repo.parentOf("task", tree.task)).toEqual({ entity: "acceptance_test", id: tree.acceptance });
    expect(registry(repo).task_may_be_attempted({ entity: "task", id: tree.task }).ok).toBe(false);
  });
});
