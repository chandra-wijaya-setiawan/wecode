import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Work } from "../src/ports.js";
import { refuseWithoutWorktree, worktreeRefusal } from "../src/worker.js";
import { tmp } from "../../core/test/tmpdir.js";

const work = (worktree: string, over: Partial<Work> = {}): Work => ({
  id: 41,
  objective_type: "task",
  objective_id: 7,
  instruction: "split the label out of the tree cell",
  scope: { paths: [] } as unknown as Work["scope"],
  budget: { tokens: 1000, seconds: 60 },
  worktree,
  session: null,
  history: null,
  ...over,
});

describe("a run without a worktree is refused", () => {
  it("lets work whose worktree is an existing directory through", () => {
    expect(refuseWithoutWorktree(work(tmp()))).toBeNull();
    expect(worktreeRefusal(work(tmp()))).toBe("");
  });

  it("refuses work whose worktree does not exist", () => {
    const missing = join(tmp(), "pruned");
    const seen = refuseWithoutWorktree(work(missing));
    expect(seen?.phase).toBe("failed");
    expect(seen?.phase === "failed" && seen.reason).toBe("lost");
    expect(worktreeRefusal(work(missing))).toContain("does not exist");
  });

  it("refuses work whose worktree is a file rather than a directory", () => {
    const file = join(tmp(), "not-a-tree");
    writeFileSync(file, "");
    const said = worktreeRefusal(work(file));
    expect(said).toContain("is not a directory");
    expect(said).not.toContain("does not exist");
  });

  it("refuses work that names no worktree at all", () => {
    expect(worktreeRefusal(work("  "))).toContain("names no worktree at all");
    expect(refuseWithoutWorktree(work(""))).not.toBeNull();
  });

  // The point of the story: a refusal a person can act on. The board shows the reason, so
  // the reason has to say which assignment stopped and what it was for.
  it("names the assignment, its objective and the path in the refusal", () => {
    const missing = join(tmp(), "gone");
    const said = worktreeRefusal(work(missing));
    expect(said).toContain("assignment 41");
    expect(said).toContain("task 7");
    expect(said).toContain(missing);
    expect(said).toContain("split the label out of the tree cell");
  });

  it("names the objective kind it was given, not a guessed one", () => {
    const said = worktreeRefusal(
      work(join(tmp(), "gone"), { objective_type: "acceptance_test", objective_id: 12 }),
    );
    expect(said).toContain("acceptance_test 12");
  });

  it("carries the refusal to the record as the attempt's lesson", () => {
    const missing = join(tmp(), "gone");
    const seen = refuseWithoutWorktree(work(missing));
    expect(seen?.phase === "failed" && seen.lesson).toBe(worktreeRefusal(work(missing)));
  });

  it("keeps the session so a refusal is attributable to the attempt that had one", () => {
    const seen = refuseWithoutWorktree(work(join(tmp(), "gone"), { session: "sess-9" }));
    expect(seen?.session).toBe("sess-9");
    expect(seen?.spent).toEqual({ tokens: 0, seconds: 0 });
  });

  it("spends nothing, because nothing was run", () => {
    const seen = refuseWithoutWorktree(work(join(tmp(), "gone")));
    expect(seen?.spent).toEqual({ tokens: 0, seconds: 0 });
    expect(seen?.session).toBeNull();
  });

  it("says nothing about the work when the assignment carries no instruction", () => {
    const said = worktreeRefusal(work(join(tmp(), "gone"), { instruction: "   " }));
    expect(said).toContain("assignment 41");
    expect(said).not.toContain("The work was:");
  });

  it("refuses on the path it was given, without trimming it into a different path", () => {
    const dir = tmp();
    const said = worktreeRefusal(work(`${dir} `));
    expect(said).toContain(`${dir} `);
    expect(said).toContain("does not exist");
    expect(said).not.toContain("names no worktree at all");
  });
});
