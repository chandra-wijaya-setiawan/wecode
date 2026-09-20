import { describe, expect, it } from "vitest";
import { taskFinishesOnItsOwnWork, type TaskWork } from "../src/index.js";

/** A task may only reach `done` on a branch that holds a commit of its own.
 *
 *  Pure over the record: no git, no clock. The branch and what it carries are reported by
 *  whoever cut and merged it. */

const SHA = "9f1c2b3a4d5e6f70819293a4b5c6d7e8f9012345";
const BASE = "1122334455667788990011223344556677889900";

const work = (ownCommits: readonly string[]): TaskWork => ({ branch: "task/password-reset", ownCommits });

const guardFor = (w: TaskWork | null) => taskFinishesOnItsOwnWork(() => w);

const ctx = { entity: "task", id: 7 };

describe("a task finishes on its own work", () => {
  it("lets a task whose branch holds a commit finish", () => {
    expect(guardFor(work([SHA]))(ctx)).toEqual({ ok: true });
  });

  it("refuses a branch with no commit of its own, and names the branch", () => {
    const r = guardFor(work([]))(ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("task/password-reset");
    expect(!r.ok && r.why).toContain("no commit of its own");
  });

  it("refuses a task no branch was recorded for, rather than waving it through", () => {
    const r = guardFor(null)(ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("#7");
  });

  it("asks about the task it is applied to, not some other one", () => {
    const guard = taskFinishesOnItsOwnWork((id) => (id === 7 ? work([SHA]) : work([])));
    expect(guard({ entity: "task", id: 7 }).ok).toBe(true);
    expect(guard({ entity: "task", id: 8 }).ok).toBe(false);
  });

  it("refuses an entity that is not worked on a branch at all", () => {
    const r = guardFor(work([SHA]))({ entity: "story", id: 7 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("story");
  });
});

describe("a refresh is not work", () => {
  /** A refresh merge brings the base's commits forward onto the task branch. The branch is
   *  then several commits long and still carries nothing the task wrote, which is exactly
   *  the finish this guard is here to refuse. */
  it("refuses a branch whose only commits came from the base", () => {
    const refreshed: TaskWork = { branch: "task/password-reset", ownCommits: [] };
    expect(guardFor(refreshed)(ctx).ok).toBe(false);
  });

  it("allows a branch that has been refreshed and then written to", () => {
    const written: TaskWork = { branch: "task/password-reset", ownCommits: [SHA] };
    expect(guardFor(written)(ctx).ok).toBe(true);
    expect(written.ownCommits).not.toContain(BASE);
  });
});
