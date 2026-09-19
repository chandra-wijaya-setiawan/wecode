import { describe, expect, it } from "vitest";
import {
  checkRecord,
  INVARIANTS,
  isSettled,
  ITS_PARENT_HAS_FINISHED,
  nothingIsOpenUnderASettledParent,
  successOf,
  CHECKED,
  type Checked,
  type RecordNode,
  type Snapshot,
} from "../src/index.js";

/** Every invariant before this one reads downwards, from a parent to the children that
 *  bear out its claim. This one reads upwards, and the cases below are the ones the
 *  downward checks are all silent about: work still open beneath a parent that has
 *  already finished with it. */

const node = (entity: Checked, id: number, slug: string, state: string, parent_id: number | null = null): RecordNode => ({
  entity,
  id,
  slug,
  state,
  parent_id,
});

const named = (violations: readonly { entity: string; id: number | null; slug: string }[]) =>
  violations.map((v) => `${v.entity}#${v.id ?? "-"} ${v.slug}`);

const snapshot = (...nodes: readonly RecordNode[]): Snapshot => ({ nodes, workers: [] });

const found = (...nodes: readonly RecordNode[]) => named(nothingIsOpenUnderASettledParent(snapshot(...nodes)));

/** A settled parent of each kind, and the state its child would be open in. */
const PAIRS: readonly [Checked, string, Checked, string][] = [
  ["release", "released", "epic", "in_progress"],
  ["epic", "delivered", "story", "in_progress"],
  ["story", "delivered", "requirement", "planned"],
  ["requirement", "met", "acceptance_criteria", "in_progress"],
  ["acceptance_criteria", "accepted", "acceptance_test", "failed"],
  ["acceptance_test", "passed", "task", "ready"],
  ["task", "done", "task_test", "ready"],
];

describe("what counts as settled", () => {
  it.each([...CHECKED])("calls %s dropped settled", (entity) => {
    expect(isSettled(node(entity, 1, "x", "dropped"))).toBe(true);
  });

  it.each([...CHECKED])("calls %s in its own success state settled", (entity) => {
    expect(isSettled(node(entity, 1, "x", successOf(entity)))).toBe(true);
  });

  it.each(["planned", "in_progress", "on_hold", "ready", "failed"])("calls %s open", (state) => {
    expect(isSettled(node("task", 1, "x", state))).toBe(false);
  });

  it("knows the leaf's success state, which no parent row names", () => {
    expect(successOf("task_test")).toBe("passed");
  });
});

describe("a child open under a settled parent", () => {
  it.each(PAIRS)("names the %s's open %s", (parent, settled, child, open) => {
    expect(found(node(parent, 1, "above", settled), node(child, 7, "below", open, 1))).toEqual([`${child}#7 below`]);
  });

  it("names the child and never the parent, because the child is the loose work", () => {
    const v = nothingIsOpenUnderASettledParent(
      snapshot(node("acceptance_test", 1, "mail-arrives", "passed"), node("task", 7, "send-mail", "ready", 1)),
    );
    expect(v[0]?.entity).toBe("task");
    expect(v[0]?.id).toBe(7);
  });

  it("says what the parent is, so the finding can be read without the record", () => {
    const v = nothingIsOpenUnderASettledParent(
      snapshot(node("story", 1, "reset", "delivered"), node("requirement", 7, "one-change", "in_progress", 1)),
    );
    expect(v[0]?.detail).toBe(`in_progress under story reset #1, which is delivered — ${ITS_PARENT_HAS_FINISHED}`);
  });

  it("counts a failed acceptance_test as open: a red test is work outstanding", () => {
    expect(
      found(node("acceptance_criteria", 1, "emailed", "accepted"), node("acceptance_test", 7, "mail-bounces", "failed", 1)),
    ).toEqual(["acceptance_test#7 mail-bounces"]);
  });

  it("is as true of a dropped parent as of a succeeded one", () => {
    expect(found(node("story", 1, "reset", "dropped"), node("requirement", 7, "one-change", "ready", 1))).toEqual([
      "requirement#7 one-change",
    ]);
  });
});

describe("every stray child, not the first", () => {
  const strays = snapshot(
    node("acceptance_criteria", 1, "emailed", "accepted"),
    node("acceptance_test", 7, "mail-arrives", "passed", 1),
    node("acceptance_test", 8, "mail-bounces", "failed", 1),
    node("acceptance_test", 9, "mail-queues", "ready", 1),
    node("acceptance_test", 10, "mail-retries", "planned", 1),
  );

  it("names one finding per open child", () => {
    expect(named(nothingIsOpenUnderASettledParent(strays))).toEqual([
      "acceptance_test#8 mail-bounces",
      "acceptance_test#9 mail-queues",
      "acceptance_test#10 mail-retries",
    ]);
  });

  it("finds strays at every level of one record in the same pass", () => {
    const deep = snapshot(
      node("epic", 1, "recovery", "delivered"),
      node("story", 1, "reset", "delivered", 1),
      node("story", 2, "lockout", "in_progress", 1),
      node("requirement", 1, "one-change", "planned", 1),
      node("acceptance_criteria", 1, "emailed", "accepted", 1),
      node("acceptance_test", 1, "mail-arrives", "ready", 1),
    );
    expect(named(nothingIsOpenUnderASettledParent(deep))).toEqual([
      "story#2 lockout",
      "requirement#1 one-change",
      "acceptance_test#1 mail-arrives",
    ]);
  });
});

describe("what it stays quiet about", () => {
  it("is silent when the parent is still open", () => {
    expect(found(node("story", 1, "reset", "in_progress"), node("requirement", 7, "one-change", "ready", 1))).toEqual([]);
  });

  it("is silent when every child settled too", () => {
    expect(
      found(
        node("story", 1, "reset", "delivered"),
        node("requirement", 7, "one-change", "met", 1),
        node("requirement", 8, "one-use", "dropped", 1),
      ),
    ).toEqual([]);
  });

  it("is silent for a settled parent with no children at all", () => {
    expect(found(node("story", 1, "reset", "delivered"))).toEqual([]);
  });

  it("does not reach past its own children to another parent's", () => {
    expect(
      found(
        node("story", 1, "reset", "delivered"),
        node("story", 2, "lockout", "in_progress"),
        node("requirement", 7, "one-change", "ready", 2),
      ),
    ).toEqual([]);
  });

  it("does not count an orphan, which nobody settled above", () => {
    expect(found(node("story", 1, "reset", "delivered"), node("requirement", 7, "one-change", "ready", null))).toEqual([]);
  });
});

describe("the doctor runs it", () => {
  it("is one of the checks a pass makes", () => {
    expect(INVARIANTS.map((i) => i.name)).toContain("nothing_is_open_under_a_settled_parent");
  });

  it("reports it from a whole pass, under its own name", () => {
    const v = checkRecord(snapshot(node("task", 1, "send-mail", "done"), node("task_test", 7, "mailer-called", "ready", 1)));
    expect(v.map((x) => x.invariant)).toContain("nothing_is_open_under_a_settled_parent");
    expect(named(v.filter((x) => x.invariant === "nothing_is_open_under_a_settled_parent"))).toEqual([
      "task_test#7 mailer-called",
    ]);
  });

  it("is quiet on a record whose every parent is settled over settled children", () => {
    const whole = snapshot(
      node("release", 1, "v1", "released"),
      node("epic", 1, "recovery", "delivered", 1),
      node("story", 1, "reset", "delivered", 1),
      node("requirement", 1, "one-change", "met", 1),
      node("acceptance_criteria", 1, "emailed", "accepted", 1),
      node("acceptance_test", 1, "mail-arrives", "passed", 1),
      node("task", 1, "send-mail", "done", 1),
      node("task_test", 1, "mailer-called", "passed", 1),
    );
    expect(nothingIsOpenUnderASettledParent(whole)).toEqual([]);
  });
});
