import { describe, expect, it } from "vitest";
import { allChildrenDroppedIsNotSuccess, checkRecord, type Checked, type RecordNode, type Snapshot } from "../src/index.js";

/** `all_children_dropped_is_not_success` stopped at the level the drop happened at. An epic
 *  delivered by a story that was itself delivered on nothing but dropped requirements went
 *  unnamed: the story was accused, the epic — making the same false claim, one level up, and
 *  the one a person reads a release off — was not. Healing the story would have left the
 *  epic saying it had shipped something.
 *
 *  Every case here is silent against the check as it was. */

const node = (entity: Checked, id: number, slug: string, state: string, parent_id: number | null = null): RecordNode => ({
  entity,
  id,
  slug,
  state,
  parent_id,
});

const snap = (nodes: readonly RecordNode[]): Snapshot => ({ nodes, workers: [], schema_version: undefined });

const named = (s: Snapshot) => allChildrenDroppedIsNotSuccess(s).map((v) => `${v.entity}#${v.id}`);

const detailOf = (s: Snapshot, entity: string) =>
  allChildrenDroppedIsNotSuccess(s).find((v) => v.entity === entity)?.detail;

/** One release → epic → story → requirement chain, each in the state given. Deeper levels
 *  are left out; a childless parent is a different sentence and this file never relies on
 *  it. */
const chain = (states: { release?: string; epic: string; story: string; requirement: string }): Snapshot =>
  snap([
    ...(states.release === undefined ? [] : [node("release", 1, "v1", states.release)]),
    node("epic", 1, "recovery", states.epic, 1),
    node("story", 1, "reset", states.story, 1),
    node("requirement", 1, "one-change", states.requirement, 1),
  ]);

describe("a delivered epic above an all-dropped tree", () => {
  const drifted = chain({ epic: "delivered", story: "delivered", requirement: "dropped" });

  it("is named, and not only the story under it", () => {
    expect(named(drifted)).toEqual(["epic#1", "story#1"]);
  });

  it("says the story proved nothing, rather than claiming it was dropped", () => {
    expect(detailOf(drifted, "epic")).toBe("delivered with every story proving nothing");
    expect(detailOf(drifted, "story")).toBe("delivered with every requirement dropped");
  });

  it("is reported by the whole pass, not just by the check in isolation", () => {
    expect(checkRecord(drifted).filter((v) => v.entity === "epic")).toEqual([
      {
        invariant: "all_children_dropped_is_not_success",
        entity: "epic",
        id: 1,
        slug: "recovery",
        detail: "delivered with every story proving nothing",
      },
    ]);
  });

  it("carries on up: a released release above the same tree is named too", () => {
    const whole = chain({ release: "released", epic: "delivered", story: "delivered", requirement: "dropped" });
    expect(named(whole)).toEqual(["release#1", "epic#1", "story#1"]);
  });
});

describe("what still holds the epic up", () => {
  it("one story delivered on a met requirement, however many are dropped", () => {
    const held = snap([
      node("epic", 1, "recovery", "delivered", 1),
      node("story", 1, "reset", "delivered", 1),
      node("requirement", 1, "one-change", "met", 1),
      node("story", 2, "empty", "dropped", 1),
    ]);
    expect(named(held)).toEqual([]);
  });

  it("one story dropped and one delivered on nothing is still nothing", () => {
    const drifted = snap([
      node("epic", 1, "recovery", "delivered", 1),
      node("story", 1, "reset", "delivered", 1),
      node("requirement", 1, "one-change", "dropped", 1),
      node("story", 2, "empty", "dropped", 1),
    ]);
    expect(named(drifted)).toEqual(["epic#1", "story#1"]);
    expect(detailOf(drifted, "epic")).toBe("delivered with every story proving nothing");
  });

  it("an epic that has not claimed delivery, whatever is under it", () => {
    expect(named(chain({ epic: "in_progress", story: "delivered", requirement: "dropped" }))).toEqual(["story#1"]);
  });

  it("a dropped epic, which is honest about it", () => {
    expect(named(chain({ epic: "dropped", story: "delivered", requirement: "dropped" }))).toEqual(["story#1"]);
  });

  it("an epic whose story is still planned under a dropped requirement", () => {
    expect(named(chain({ epic: "delivered", story: "planned", requirement: "dropped" }))).toEqual([]);
  });
});
