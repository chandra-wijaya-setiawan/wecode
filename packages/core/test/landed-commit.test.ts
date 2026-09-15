import { describe, expect, it } from "vitest";
import {
  ALREADY_IN_THE_BASE,
  deliveredStoryHasLanded,
  landingRecord,
  landingSkipped,
  NEVER_REACHED_THE_BASE,
  REACHED_INSIDE_ANOTHER_MERGE,
  storiesToLand,
  storyBranch,
  type Landing,
  type RecordNode,
  type Snapshot,
} from "../src/index.js";

/** docs/design/14 — "merge once". A task branch is merged into its story branch on every
 *  tick, forever, because nothing in the record says the merge already happened; the story
 *  here is the sha that says so. These are pure over the record: no git, no clock. */

const story = (id: number, slug: string, state: string, landed_sha: string | null = null): RecordNode => ({
  entity: "story",
  id,
  slug,
  state,
  parent_id: 1,
  landed_sha,
});

const snapshot = (...nodes: RecordNode[]): Snapshot => ({ nodes, workers: [] });

const LANDED = "9f1c2b3a4d5e6f70819293a4b5c6d7e8f9012345";

describe("the stories a tick would land", () => {
  it("offers a delivered story with no commit recorded", () => {
    expect(storiesToLand(snapshot(story(1, "password-reset", "delivered")))).toEqual([
      { story: story(1, "password-reset", "delivered"), branch: "story/password-reset" },
    ]);
  });

  it("does not offer the same story a second time once the commit is recorded", () => {
    const first = snapshot(story(1, "password-reset", "delivered"));
    expect(storiesToLand(first)).toHaveLength(1);

    // What the first tick recorded, fed back to the second.
    const { sha } = landingRecord({ kind: "merged", sha: LANDED });
    const second = snapshot(story(1, "password-reset", "delivered", sha));
    expect(storiesToLand(second)).toEqual([]);
  });

  it("does not offer a story that has not asked to land", () => {
    for (const state of ["planned", "in_progress", "dropped"]) {
      expect(storiesToLand(snapshot(story(1, "password-reset", state)))).toEqual([]);
    }
  });

  it("names the branch the lander merges, and nothing else", () => {
    const only = storiesToLand(snapshot(story(7, "session-timeout", "delivered")))[0];
    expect(only?.branch).toBe(storyBranch("session-timeout"));
  });

  it("offers the unlanded ones out of a mixed board", () => {
    const s = snapshot(
      story(1, "landed", "delivered", LANDED),
      story(2, "unlanded", "delivered"),
      story(3, "working", "in_progress"),
    );
    expect(storiesToLand(s).map((t) => t.story.slug)).toEqual(["unlanded"]);
  });
});

describe("why a story was passed over", () => {
  it("says nothing about one that is going to be landed", () => {
    expect(landingSkipped(story(1, "password-reset", "delivered"))).toBeNull();
  });

  it("names the commit it is already in the base as", () => {
    expect(landingSkipped(story(1, "password-reset", "delivered", LANDED))).toBe(
      `${ALREADY_IN_THE_BASE} as 9f1c2b3a4d5e`,
    );
  });

  it("names the state that is not delivered", () => {
    expect(landingSkipped(story(1, "password-reset", "in_progress"))).toBe(
      "in_progress, and only a delivered story lands",
    );
  });
});

describe("what a landing puts on the story", () => {
  it("records the commit the base became", () => {
    expect(landingRecord({ kind: "merged", sha: LANDED })).toEqual({
      sha: LANDED,
      note: "landed as 9f1c2b3a4d5e",
    });
  });

  it("records no commit for a branch already in the base, and says why", () => {
    const already: Landing = { kind: "nothing", why: "already-ancestor" };
    expect(landingRecord(already)).toEqual({ sha: null, note: REACHED_INSIDE_ANOTHER_MERGE });
  });

  it("records no commit for a story with no branch, and says why", () => {
    const gone: Landing = { kind: "nothing", why: "no-branch" };
    expect(landingRecord(gone)).toEqual({ sha: null, note: NEVER_REACHED_THE_BASE });
  });

  it("leaves a story that never reached the base still accused", () => {
    const { sha } = landingRecord({ kind: "nothing", why: "no-branch" });
    const after = snapshot(story(1, "password-reset", "delivered", sha));
    expect(deliveredStoryHasLanded(after).map((v) => v.detail)).toEqual([NEVER_REACHED_THE_BASE]);
  });

  it("clears the accusation once the commit is recorded", () => {
    const { sha } = landingRecord({ kind: "merged", sha: LANDED });
    expect(deliveredStoryHasLanded(snapshot(story(1, "password-reset", "delivered", sha)))).toEqual([]);
  });
});
