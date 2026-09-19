import { describe, expect, it } from "vitest";
import {
  ALLOW,
  automaticFrom,
  check,
  isTerminal,
  loadMachines,
  MachineError,
  refuse,
  STATEFUL,
  transitionFor,
  type GuardRegistry,
} from "../src/index.js";

const set = loadMachines();
const ctx = { entity: "task", id: 1 };

describe("the table loads and checks itself", () => {
  it("has a machine for every stateful entity and no others", () => {
    expect(Object.keys(set).sort()).toEqual([...STATEFUL].sort());
  });

  it("refuses a machine whose transition names an unknown state", () => {
    expect(() => loadMachines(new URL("./fixtures/unknown-state.yaml", import.meta.url).pathname))
      .toThrow(MachineError);
  });

  it("refuses a machine whose transition names an unknown guard", () => {
    expect(() => loadMachines(new URL("./fixtures/unknown-guard.yaml", import.meta.url).pathname))
      .toThrow(MachineError);
  });
});

describe("a task is about the work, not the attempt", () => {
  it("never enters a phase that belongs to an assignment", () => {
    expect(set.task.states).toEqual(["planned", "ready", "done", "failed", "dropped"]);
  });

  it("is ready only through a guard", () => {
    expect(transitionFor(set.task, "planned", "start")?.guard).toBe("task_may_be_attempted");
  });

  /** A transition names one guard, so the branch question and the tests question are asked
   *  under the single name the registry binds. `finish-asks-the-branch.test.ts` proves the
   *  binding; this only holds the table to naming a guard at all. */
  it("is done only through a guard", () => {
    expect(transitionFor(set.task, "ready", "finish")?.guard).toBe("every_task_test_settled");
  });
});

describe("check", () => {
  const open: GuardRegistry = { task_may_be_attempted: () => ALLOW };

  it("allows a legal verb whose guard allows it", () => {
    const r = check(set.task, "planned", "start", open, ctx);
    expect(r.ok && r.applied.to).toBe("ready");
  });

  it("names the legal verbs when one is not", () => {
    const r = check(set.task, "planned", "finish", open, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("start");
  });

  it("refuses a verb whose guard refuses, with the guard's reason", () => {
    const shut: GuardRegistry = { task_may_be_attempted: () => refuse("no task_test is ready") };
    const r = check(set.task, "planned", "start", shut, ctx);
    expect(!r.ok && r.why).toBe("no task_test is ready");
  });

  it("refuses a guard nobody implemented, rather than waving it through", () => {
    const r = check(set.task, "planned", "start", {}, ctx);
    expect(!r.ok && r.why).toContain("not implemented");
  });

  it("says so when the state is terminal", () => {
    const r = check(set.task, "done", "retry", open, ctx);
    expect(!r.ok && r.why).toContain("terminal");
  });
});

describe("the cascade is invoked by nobody", () => {
  it.each([
    ["acceptance_criteria", "in_progress", "accept"],
    ["requirement", "in_progress", "meet"],
    ["story", "in_progress", "deliver"],
    ["epic", "in_progress", "deliver"],
    ["task", "ready", "finish"],
  ] as const)("%s.%s is automatic", (entity, from, verb) => {
    expect(automaticFrom(set[entity], from).map((t) => t.verb)).toContain(verb);
  });

  it("shipping is a decision, not a cascade", () => {
    expect(automaticFrom(set.release, "in_progress")).toEqual([]);
  });
});

describe("an assignment carries the attempt", () => {
  it("has five phases", () => {
    expect(set.assignment.states).toHaveLength(5);
  });

  it("has no retry: a retry is a new assignment", () => {
    expect(set.assignment.transitions.some((t) => t.verb === "retry")).toBe(false);
  });

  it("ends for good", () => {
    expect(isTerminal(set.assignment, "succeeded")).toBe(true);
    expect(isTerminal(set.assignment, "failed")).toBe(true);
  });
});
