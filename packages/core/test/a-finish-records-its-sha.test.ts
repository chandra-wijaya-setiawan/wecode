import { describe, expect, it } from "vitest";
import { finishedOn, shaTaskFinishedOn, taskFinishesOnItsOwnWork, type TaskWork } from "../src/index.js";

/** A finish names the point in history it happened at.
 *
 *  `a-task-finishes-on-its-own-work.test.ts` proves a task may only finish on a branch
 *  that holds work of its own. This proves the other half: which sha that finish is
 *  recorded on, and that the two answers can never disagree. Pure over the record — the
 *  branch and what it carries are reported by whoever cut and merged it. */

const FIRST = "9f1c2b3a4d5e6f70819293a4b5c6d7e8f9012345";
const SECOND = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const THIRD = "abcdef0123456789abcdef0123456789abcdef01";

const work = (ownCommits: readonly string[]): TaskWork => ({ branch: "task/password-reset", ownCommits });

describe("a finish records its sha", () => {
  it("records the tip of the branch's own work", () => {
    expect(finishedOn(work([FIRST, SECOND, THIRD]))).toBe(THIRD);
  });

  it("records the single commit when the task wrote once", () => {
    expect(finishedOn(work([FIRST]))).toBe(FIRST);
  });

  it("records nothing for a branch holding no work of its own", () => {
    expect(finishedOn(work([]))).toBeNull();
  });

  it("records nothing when no branch was recorded at all", () => {
    expect(finishedOn(null)).toBeNull();
  });

  it("takes the work oldest-first, so the tip is the last attempt and not the first", () => {
    // The attempts are read in the order they were made; a second attempt on the same
    // task finishes on what it wrote, not on what the first one left behind.
    expect(finishedOn(work([FIRST, SECOND]))).not.toBe(FIRST);
    expect(finishedOn(work([FIRST, SECOND]))).toBe(SECOND);
  });

  it("ignores an attempt that recorded a blank sha rather than finishing on nothing", () => {
    expect(finishedOn(work([FIRST, "   "]))).toBe(FIRST);
    expect(finishedOn(work(["", "  "]))).toBeNull();
  });

  it("gives the sha with no surrounding whitespace, so it is usable as it is read", () => {
    expect(finishedOn(work([` ${FIRST}\n`]))).toBe(FIRST);
  });
});

describe("the sha and the guard read one record", () => {
  const agree = (w: TaskWork | null): void => {
    const allowed = taskFinishesOnItsOwnWork(() => w)({ entity: "task", id: 7 }).ok;
    expect(allowed).toBe(finishedOn(w) !== null);
  };

  it("has a sha for every task it lets finish", () => {
    agree(work([FIRST, SECOND]));
    agree(work([FIRST]));
  });

  it("lets no task finish that it has no sha for", () => {
    agree(work([]));
    agree(work(["  "]));
    agree(null);
  });

  it("refuses a refreshed-but-unwritten branch and records no sha for it", () => {
    // A refresh merge brings the base forward and records no attempt sha of its own.
    const refreshed = work([]);
    expect(taskFinishesOnItsOwnWork(() => refreshed)({ entity: "task", id: 7 }).ok).toBe(false);
    expect(finishedOn(refreshed)).toBeNull();
  });
});

describe("the sha is asked for one task", () => {
  const workOf = (id: number): TaskWork | null =>
    id === 7 ? work([FIRST, SECOND]) : id === 8 ? work([]) : null;

  it("answers with the tip of the task it was asked about", () => {
    expect(shaTaskFinishedOn(workOf)(7)).toBe(SECOND);
  });

  it("answers null for a task that wrote nothing, and for one nobody recorded", () => {
    expect(shaTaskFinishedOn(workOf)(8)).toBeNull();
    expect(shaTaskFinishedOn(workOf)(9)).toBeNull();
  });

  it("reads through the same port the guard reads through", () => {
    const asked: number[] = [];
    const port = (id: number): TaskWork | null => {
      asked.push(id);
      return workOf(id);
    };
    shaTaskFinishedOn(port)(7);
    taskFinishesOnItsOwnWork(port)({ entity: "task", id: 7 });
    expect(asked).toEqual([7, 7]);
  });
});
