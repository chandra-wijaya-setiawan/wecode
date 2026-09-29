import { describe, expect, it } from "vitest";
import {
  DID_NOT_FIRE,
  INVARIANTS,
  unsettledParentIsNamed,
  type Checked,
  type RecordNode,
  type Snapshot,
} from "../src/index.js";

const node = (entity: Checked, id: number, slug: string, state: string, parent_id: number | null = null): RecordNode => ({
  entity,
  id,
  slug,
  state,
  parent_id,
});

const snapshot = (nodes: readonly RecordNode[]): Snapshot => ({ nodes, workers: [] });

const named = (violations: readonly { entity: string; id: number | null; slug: string }[]) =>
  violations.map((v) => `${v.entity}#${v.id ?? "-"} ${v.slug}`);

/** A story whose requirements are in the states given. The story is the parent under test
 *  and everything above it is left out, so only one sentence can be broken at a time. */
const story = (state: string, ...requirements: readonly string[]): Snapshot =>
  snapshot([
    node("story", 1, "reset", state),
    ...requirements.map((s, i) => node("requirement", i + 1, `one-change-${i + 1}`, s, 1)),
  ]);

describe("a parent whose automatic transition was due and did not fire", () => {
  it("names the parent, not a child", () => {
    expect(named(unsettledParentIsNamed(story("in_progress", "met", "met")))).toEqual(["story#1 reset"]);
  });

  it("counts the settled children as its evidence, and names the verb that owed them", () => {
    expect(unsettledParentIsNamed(story("in_progress", "met", "met"))[0]?.detail).toBe(
      `in_progress with all 2 requirement settled — 2 met — automatic deliver ${DID_NOT_FIRE}`,
    );
  });

  it("counts a dropped child among the settled ones, and says which is which", () => {
    expect(unsettledParentIsNamed(story("in_progress", "met", "dropped", "met"))[0]?.detail).toBe(
      `in_progress with all 3 requirement settled — 2 met, 1 dropped — automatic deliver ${DID_NOT_FIRE}`,
    );
  });

  it("names the verb of the level it is speaking about, not story's", () => {
    const s = snapshot([
      node("requirement", 1, "one-change", "in_progress"),
      node("acceptance_criteria", 1, "resets-once", "accepted", 1),
    ]);
    expect(unsettledParentIsNamed(s)[0]?.detail).toContain(`automatic meet ${DID_NOT_FIRE}`);
  });

  it("reads task's departure state as ready, because finish leaves from there and not in_progress", () => {
    const s = snapshot([
      node("task", 1, "send-mail", "ready"),
      node("task_test", 1, "mailer-called", "passed", 1),
    ]);
    expect(unsettledParentIsNamed(s)[0]?.detail).toBe(
      `ready with all 1 task_test settled — 1 passed — automatic finish ${DID_NOT_FIRE}`,
    );
  });

  it("names every level whose transition is due, because healing one leaves the other standing", () => {
    // The story owes its delivery; the epic's guard is not yet satisfied, since its story is
    // still in flight, so only the story is named.
    const s = snapshot([
      node("epic", 1, "recovery", "in_progress"),
      node("story", 1, "reset", "in_progress", 1),
      node("requirement", 1, "one-change", "met", 1),
    ]);
    expect(named(unsettledParentIsNamed(s))).toEqual(["story#1 reset"]);
  });
});

describe("it is silent where no transition was ever due", () => {
  it("is silent while one child is unsettled, because the guard is not satisfied", () => {
    expect(unsettledParentIsNamed(story("in_progress", "met", "in_progress"))).toEqual([]);
  });

  it("is silent for a parent with no children — that is the empty-shape sentence", () => {
    expect(unsettledParentIsNamed(story("in_progress"))).toEqual([]);
  });

  it("is silent when every child is dropped, because no cascade fires from nothing", () => {
    expect(unsettledParentIsNamed(story("in_progress", "dropped", "dropped"))).toEqual([]);
  });

  it.each(["planned", "on_hold"])(
    "is silent for a %s parent, which has no automatic transition available to it",
    (state) => {
      expect(unsettledParentIsNamed(story(state, "met"))).toEqual([]);
    },
  );

  it.each(["delivered", "dropped"])("is silent for a parent already settled as %s", (state) => {
    expect(unsettledParentIsNamed(story(state, "met"))).toEqual([]);
  });

  it("is silent about a release holding only delivered epics, because releasing is a person's call", () => {
    const s = snapshot([
      node("release", 1, "v1", "in_progress"),
      node("epic", 1, "recovery", "delivered", 1),
    ]);
    expect(unsettledParentIsNamed(s)).toEqual([]);
  });

  it("is silent about an acceptance_test over passed tasks, because passing means having run", () => {
    const s = snapshot([
      node("acceptance_test", 1, "resets-once", "ready"),
      node("task", 1, "send-mail", "done", 1),
    ]);
    expect(unsettledParentIsNamed(s)).toEqual([]);
  });

  it("is silent about a settled leaf that has no children of its own", () => {
    expect(unsettledParentIsNamed(snapshot([node("task_test", 1, "mailer-called", "passed")]))).toEqual([]);
  });
});

describe("the invariant", () => {
  it("is one of the checks a pass runs, so nobody has to ask for it", () => {
    expect(INVARIANTS.map((i) => i.name)).toContain("unsettled_parent_is_named");
  });

  it("reports under its own name", () => {
    for (const v of unsettledParentIsNamed(story("in_progress", "met"))) {
      expect(v.invariant).toBe("unsettled_parent_is_named");
    }
  });
});
