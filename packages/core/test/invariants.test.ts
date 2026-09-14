import { describe, expect, it } from "vitest";
import {
  allChildrenDroppedIsNotSuccess,
  checkRecord,
  deliveredStoryHasLanded,
  failingCriteriaHasAnOpenTask,
  INVARIANTS,
  schemaVersionIsUnderstood,
  SCHEMA_VERSION,
  readyAcceptanceTestWasRedAtBase,
  readyTaskHasAReadyTaskTest,
  roleWithReadyWorkHasAWorker,
  storyInProgressHasARequirement,
  type Checked,
  type RecordNode,
  type Snapshot,
} from "../src/index.js";

const node = (entity: Checked, id: number, slug: string, state: string, rest: Partial<RecordNode> = {}): RecordNode => ({
  entity,
  id,
  slug,
  state,
  parent_id: null,
  ...rest,
});

/** A record with nothing wrong with it: a story landed, its requirement met, its criteria
 *  accepted, its acceptance_test red before it passed, its task done and proven. Every
 *  check below starts from this and breaks exactly one sentence. */
const clean = (): Snapshot => ({
  nodes: [
    node("release", 1, "v1", "in_progress"),
    node("epic", 1, "recovery", "in_progress", { parent_id: 1 }),
    node("story", 1, "reset", "delivered", { parent_id: 1, landed_sha: "base0000" }),
    node("requirement", 1, "one-change", "met", { parent_id: 1 }),
    node("acceptance_criteria", 1, "emailed", "accepted", { parent_id: 1 }),
    node("acceptance_test", 1, "mail-arrives", "passed", { parent_id: 1, red_at_base_sha: "base0000" }),
    node("task", 1, "send-mail", "done", { parent_id: 1, role: "engineer" }),
    node("task_test", 1, "mailer-called", "passed", { parent_id: 1 }),
  ],
  workers: [{ slug: "ada", role: "engineer" }],
});

/** Replace one node in the clean record, keeping everything else. */
const withNode = (entity: Checked, id: number, patch: Partial<RecordNode>): Snapshot => {
  const base = clean();
  return {
    ...base,
    nodes: base.nodes.map((n) => (n.entity === entity && n.id === id ? { ...n, ...patch } : n)),
  };
};

const named = (violations: readonly { entity: string; id: number | null; slug: string }[]) =>
  violations.map((v) => `${v.entity}#${v.id ?? "-"} ${v.slug}`);

describe("a clean record", () => {
  it("reports nothing", () => {
    expect(checkRecord(clean())).toEqual([]);
  });

  it("reports nothing from any single invariant", () => {
    for (const { name, check } of INVARIANTS) {
      expect(check(clean()), name).toEqual([]);
    }
  });
});

describe("a delivered story has a landed marker", () => {
  const drifted = withNode("story", 1, { landed_sha: null });

  it("names the story that never reached the base", () => {
    expect(named(deliveredStoryHasLanded(drifted))).toEqual(["story#1 reset"]);
  });

  it("is silent for a story that has not claimed delivery", () => {
    expect(deliveredStoryHasLanded(withNode("story", 1, { state: "in_progress", landed_sha: null }))).toEqual([]);
  });
});

describe("a story in progress has at least one requirement", () => {
  const drifted: Snapshot = { ...clean(), nodes: clean().nodes.filter((n) => n.entity !== "requirement") };
  const empty: Snapshot = { ...drifted, nodes: drifted.nodes.map((n) => (n.entity === "story" ? { ...n, state: "in_progress" } : n)) };

  it("names the story with nothing under it", () => {
    expect(named(storyInProgressHasARequirement(empty))).toEqual(["story#1 reset"]);
  });

  it("is silent for a planned story, which is allowed to be empty", () => {
    expect(storyInProgressHasARequirement({ ...drifted, nodes: drifted.nodes.map((n) => (n.entity === "story" ? { ...n, state: "planned" } : n)) })).toEqual([]);
  });
});

describe("a parent whose every child is dropped is not in a success state", () => {
  it("names the requirement whose only criteria was dropped", () => {
    const drifted = withNode("acceptance_criteria", 1, { state: "dropped" });
    expect(named(allChildrenDroppedIsNotSuccess(drifted))).toContain("requirement#1 one-change");
  });

  it("names the epic whose only story was dropped", () => {
    const base = withNode("epic", 1, { state: "delivered" });
    const drifted: Snapshot = {
      ...base,
      nodes: base.nodes.map((n) => (n.entity === "story" ? { ...n, state: "dropped" } : n)),
    };
    expect(named(allChildrenDroppedIsNotSuccess(drifted))).toContain("epic#1 recovery");
  });

  it("is silent when one child of several survives", () => {
    const base = clean();
    const withSecond: Snapshot = {
      ...base,
      nodes: [
        ...base.nodes.map((n) => (n.entity === "requirement" ? { ...n, state: "dropped" } : n)),
        node("requirement", 2, "one-use", "met", { parent_id: 1 }),
      ],
    };
    expect(named(allChildrenDroppedIsNotSuccess(withSecond))).not.toContain("story#1 reset");
  });

  it("is silent for a childless parent, which is a different sentence", () => {
    const leafOnly: Snapshot = { ...clean(), nodes: [node("task", 9, "lonely", "done", { role: "engineer" })] };
    expect(allChildrenDroppedIsNotSuccess(leafOnly)).toEqual([]);
  });
});

describe("a ready acceptance_test has been observed red at base", () => {
  const drifted = withNode("acceptance_test", 1, { state: "ready", red_at_base_sha: null });

  it("names the test nobody has seen fail", () => {
    expect(named(readyAcceptanceTestWasRedAtBase(drifted))).toEqual(["acceptance_test#1 mail-arrives"]);
  });

  it("is silent once a red run is recorded", () => {
    expect(readyAcceptanceTestWasRedAtBase(withNode("acceptance_test", 1, { state: "ready" }))).toEqual([]);
  });
});

describe("every role with ready work has at least one worker", () => {
  const drifted: Snapshot = { ...withNode("task", 1, { state: "ready" }), workers: [] };

  it("names the role nobody fills", () => {
    expect(named(roleWithReadyWorkHasAWorker(drifted))).toEqual(["role#- engineer"]);
  });

  it("is silent when the role has a worker", () => {
    expect(roleWithReadyWorkHasAWorker(withNode("task", 1, { state: "ready" }))).toEqual([]);
  });

  it("is silent when the unfilled role has no ready work", () => {
    expect(roleWithReadyWorkHasAWorker({ ...clean(), workers: [] })).toEqual([]);
  });

  it("names a role once however many tasks wait on it", () => {
    const base = withNode("task", 1, { state: "ready" });
    const two: Snapshot = {
      ...base,
      workers: [],
      nodes: [...base.nodes, node("task", 2, "queue-mail", "ready", { parent_id: 1, role: "engineer" })],
    };
    expect(named(roleWithReadyWorkHasAWorker(two))).toEqual(["role#- engineer"]);
  });
});

describe("a ready task has a task_test that is ready or passed", () => {
  it("names the task that does not say how it proves itself", () => {
    const base = withNode("task", 1, { state: "ready" });
    const drifted: Snapshot = { ...base, nodes: base.nodes.filter((n) => n.entity !== "task_test") };
    expect(named(readyTaskHasAReadyTaskTest(drifted))).toEqual(["task#1 send-mail"]);
  });

  it("names the task whose only task_test is planned", () => {
    const base = withNode("task", 1, { state: "ready" });
    const drifted: Snapshot = {
      ...base,
      nodes: base.nodes.map((n) => (n.entity === "task_test" ? { ...n, state: "planned" } : n)),
    };
    expect(named(readyTaskHasAReadyTaskTest(drifted))).toEqual(["task#1 send-mail"]);
  });

  it("accepts a task_test that is ready as well as one that passed", () => {
    const base = withNode("task", 1, { state: "ready" });
    const ready: Snapshot = {
      ...base,
      nodes: base.nodes.map((n) => (n.entity === "task_test" ? { ...n, state: "ready" } : n)),
    };
    expect(readyTaskHasAReadyTaskTest(ready)).toEqual([]);
  });
});

describe("a criteria with a failing acceptance_test has an open task under it", () => {
  const failed = (taskState: string | null): Snapshot => {
    const base = withNode("acceptance_test", 1, { state: "failed" });
    return {
      ...base,
      nodes: taskState === null
        ? base.nodes.filter((n) => n.entity !== "task" && n.entity !== "task_test")
        : base.nodes.map((n) => (n.entity === "task" ? { ...n, state: taskState } : n)),
    };
  };

  it("names the criteria whose failed test has no task at all under it", () => {
    expect(named(failingCriteriaHasAnOpenTask(failed(null)))).toEqual(["acceptance_criteria#1 emailed"]);
  });

  it("names the criteria whose failed test is only worked by a task that is done", () => {
    expect(named(failingCriteriaHasAnOpenTask(failed("done")))).toEqual(["acceptance_criteria#1 emailed"]);
  });

  it("says which test of the criteria it means", () => {
    expect(failingCriteriaHasAnOpenTask(failed(null))[0]?.detail).toContain("mail-arrives");
  });

  it.each(["planned", "ready", "failed"])("is silent while a task under the test is %s", (state) => {
    expect(failingCriteriaHasAnOpenTask(failed(state))).toEqual([]);
  });

  it("is silent for a test that has not failed", () => {
    expect(failingCriteriaHasAnOpenTask(clean())).toEqual([]);
  });
});

describe("the record's schema_version is the one this build understands", () => {
  it("names the version the file is at", () => {
    const v = schemaVersionIsUnderstood({ ...clean(), schema_version: 999 });
    expect(named(v)).toEqual(["schema_version#- 999"]);
    expect(v[0]?.detail).toContain(String(SCHEMA_VERSION));
  });

  it("names a record with no version row at all, which reads as 0", () => {
    expect(named(schemaVersionIsUnderstood({ ...clean(), schema_version: 0 }))).toEqual(["schema_version#- 0"]);
  });

  it("is silent at the version this build understands", () => {
    expect(schemaVersionIsUnderstood({ ...clean(), schema_version: SCHEMA_VERSION })).toEqual([]);
  });

  it("is silent for a caller that did not ask about the version", () => {
    expect(schemaVersionIsUnderstood(clean())).toEqual([]);
  });
});

/** One record that breaks every invariant at once, so a pass has to report them all. */
const broken: Snapshot = {
  schema_version: 0,
  nodes: [
    node("epic", 1, "recovery", "delivered", { parent_id: 1 }),
    node("epic", 2, "signin", "in_progress", { parent_id: 1 }),
    node("story", 1, "reset", "dropped", { parent_id: 1 }),
    node("story", 2, "lockout", "delivered", { parent_id: 2 }),
    node("story", 3, "unlock", "in_progress", { parent_id: 2 }),
    node("acceptance_criteria", 1, "emailed", "in_progress", { parent_id: 1 }),
    node("acceptance_test", 1, "mail-arrives", "ready", { parent_id: 1 }),
    node("acceptance_test", 2, "mail-bounces", "failed", { parent_id: 1 }),
    node("task", 1, "send-mail", "ready", { parent_id: 1, role: "engineer" }),
  ],
  workers: [],
};

describe("one pass", () => {
  it("reports every invariant that the record breaks", () => {
    expect(new Set(checkRecord(broken).map((v) => v.invariant))).toEqual(new Set(INVARIANTS.map((i) => i.name)));
  });

  it("reports every violation under its own invariant's name", () => {
    for (const { name, check } of INVARIANTS) {
      expect(check(broken).length, name).toBeGreaterThan(0);
      for (const v of check(broken)) expect(v.invariant).toBe(name);
    }
  });

  it("names the entity that broke it, never its parent or its child", () => {
    expect(named(checkRecord(broken)).sort()).toEqual(
      [
        "acceptance_criteria#1 emailed",
        "acceptance_test#1 mail-arrives",
        "epic#1 recovery",
        "schema_version#- 0",
        "role#- engineer",
        "story#2 lockout",
        "story#3 unlock",
        "task#1 send-mail",
      ].sort(),
    );
  });
});
