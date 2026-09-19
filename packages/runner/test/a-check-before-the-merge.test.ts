/** A checklist before the merge, and only one line on it may change the record.
 *
 *  The landing gate was a boolean: every acceptance test passed, and there is at least one.
 *  Every way of failing it therefore came out the same — merge held, chore raised — and the
 *  three situations underneath are not the same thing at all. A story whose last task is
 *  still running is unfinished. A story whose pass was taken in a tree that has since moved
 *  is unproved. A story delivered above nothing at all is *wrong*, and only that last one
 *  is something wecode is entitled to undo.
 *
 *  So what is proved here is the classification, and chiefly what it forbids: a merge held
 *  for any of the other three reasons reopens nothing. Reopening a story because its task
 *  had not landed yet would throw away work that was about to be true. */
import { describe, expect, it } from "vitest";
import {
  CHECKS,
  IT_PROVES_A_TREE_NOBODY_HAS,
  NOTHING_PROVES_IT,
  premerge,
  why,
  type Named,
  type Subject,
  type TestRow,
} from "../src/premerge.js";

const story = (state: string): Subject["story"] => ({ entity: "story", id: 7, slug: "password-reset", state });

const test_ = (id: number, state: string, provenance_sha?: string | null): TestRow => ({
  entity: "acceptance_test",
  id,
  slug: `t${id}`,
  state,
  provenance_sha,
});

const task = (id: number, state: string): Named & { entity: "task" } => ({
  entity: "task",
  id,
  slug: `k${id}`,
  state,
});

/** A story that merges: delivered, one test passed at the tree it stands at, task done. */
const ready = (over: Partial<Subject> = {}): Subject => ({
  story: story("delivered"),
  tests: [test_(1, "passed", "abc123def456")],
  tasks: [task(11, "done")],
  tree_sha: "abc123def456",
  merges: true,
  ...over,
});

const classes = (s: Subject): string[] => premerge(s).findings.map((f) => f.classification);
const checks = (s: Subject): string[] => premerge(s).findings.map((f) => f.check);

describe("a check before the merge", () => {
  it("passes a story that is delivered, proved at its own tree, and merges", () => {
    const list = premerge(ready());
    expect(list.findings).toEqual([]);
    expect(list.merge).toBe(true);
    expect(list.reopen).toEqual([]);
    expect(why(list)).toBe("");
  });

  it("classifies a delivered story with nothing passed under it as a false claim", () => {
    const list = premerge(ready({ tests: [test_(1, "dropped")] }));
    expect(classes(ready({ tests: [test_(1, "dropped")] }))).toEqual(["false_claim"]);
    const found = list.findings[0]!;
    expect(found.check).toBe(CHECKS.proved);
    expect(found.subject.entity).toBe("story");
    expect(found.why).toContain(NOTHING_PROVES_IT);
  });

  it("reopens the story a false claim was found against, with the verb its machine takes", () => {
    const list = premerge(ready({ tests: [] }));
    expect(list.merge).toBe(false);
    expect(list.reopen).toEqual([{ entity: "story", id: 7, verb: "reopen" }]);
    expect(list.findings[0]!.why).toContain("it has no acceptance test");
  });

  /** The whole point of the classification. Each of these holds the merge and reopens
   *  nothing: the record is not lying in any of them, and the story is still on its way to
   *  being true. */
  it.each([
    ["an unfinished story", ready({ story: story("in_progress"), tests: [test_(1, "ready")] }), "outstanding"],
    ["a red acceptance test", ready({ tests: [test_(1, "passed", "abc123def456"), test_(2, "failed")] }), "outstanding"],
    ["a task still in hand", ready({ tasks: [task(11, "ready")] }), "outstanding"],
    ["a pass against a tree that moved", ready({ tests: [test_(1, "passed", "0ldsha0ldsha")] }), "stale"],
    ["a branch that will not merge", ready({ merges: false }), "blocked"],
  ])("holds the merge for %s without reopening anything", (_name, subject, classification) => {
    const list = premerge(subject);
    expect(list.merge).toBe(false);
    expect(list.findings.map((f) => f.classification)).toContain(classification);
    expect(list.findings.some((f) => f.classification === "false_claim")).toBe(false);
    expect(list.reopen).toEqual([]);
  });

  /** Design 19: re-proving a verdict is a decision. The strongest thing a stale pass earns
   *  is the merge not happening — never an `invalidate` wecode made up for itself. */
  it("never proposes a verb against a verdict, however stale", () => {
    const list = premerge(ready({ tests: [test_(1, "passed", "0ldsha0ldsha")] }));
    expect(list.findings[0]!.classification).toBe("stale");
    expect(list.findings[0]!.why).toContain(IT_PROVES_A_TREE_NOBODY_HAS);
    expect(list.reopen).toEqual([]);
  });

  it("is quiet about provenance when the verdict is unstamped or nobody read the tree", () => {
    expect(premerge(ready({ tests: [test_(1, "passed")] })).merge).toBe(true);
    expect(premerge(ready({ tests: [test_(1, "passed", null)] })).merge).toBe(true);
    expect(premerge(ready({ tree_sha: null, tests: [test_(1, "passed", "0ldsha0ldsha")] })).merge).toBe(true);
  });

  /** An unfinished story is held once, for being unfinished — never accused of a claim it
   *  is not making. This is the false positive the classification exists to prevent. */
  it("does not call an undelivered story a false claim, even with nothing passed under it", () => {
    const list = premerge(ready({ story: story("in_progress"), tests: [] }));
    expect(checks(ready({ story: story("in_progress"), tests: [] }))).toEqual([CHECKS.delivered]);
    expect(list.findings[0]!.why).toBe("it is in_progress, not delivered");
    expect(list.reopen).toEqual([]);
  });

  it("names every open test and every open task separately, not the story once", () => {
    const list = premerge(
      ready({
        tests: [test_(1, "passed", "abc123def456"), test_(2, "failed"), test_(3, "ready")],
        tasks: [task(11, "ready"), task(12, "done"), task(13, "dropped")],
      }),
    );
    expect(list.findings.map((f) => [f.subject.entity, f.subject.id])).toEqual([
      ["acceptance_test", 2],
      ["acceptance_test", 3],
      ["task", 11],
    ]);
  });

  /** Every item runs. The reason a merge is held is the whole list, so the first failure
   *  does not hide the four behind it. */
  it("runs every item rather than stopping at the first failure", () => {
    const list = premerge({
      story: story("delivered"),
      tests: [test_(1, "failed")],
      tasks: [task(11, "ready")],
      tree_sha: "abc123def456",
      merges: false,
    });
    expect(list.findings.map((f) => f.check)).toEqual([
      CHECKS.proved,
      CHECKS.settled,
      CHECKS.tasks,
      CHECKS.merges,
    ]);
    expect(list.findings.map((f) => f.classification)).toEqual([
      "false_claim",
      "outstanding",
      "outstanding",
      "blocked",
    ]);
    expect(list.reopen).toEqual([{ entity: "story", id: 7, verb: "reopen" }]);
  });

  it("counts the classifications in the one line a chore's reason carries", () => {
    const line = why(
      premerge({
        story: story("delivered"),
        tests: [test_(1, "failed")],
        tasks: [task(11, "ready")],
        tree_sha: "abc123def456",
        merges: false,
      }),
    );
    expect(line).toContain("held (1 false_claim, 2 outstanding, 1 blocked)");
    expect(line).toContain(CHECKS.merges);
  });
});
