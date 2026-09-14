/** This story's branch had to take master in by hand: the two had grown into the same two
 *  files and would not merge on their own. A suite that merely ran green proved nothing
 *  about that — it ran green before the merge too. So the base is asserted first, and the
 *  two sides of each conflict are asserted to have both survived it.
 *
 *  The ancestry is checked against the commit master pointed at when the merge was made,
 *  not against whatever master has moved on to since: this test is about whether the base
 *  was merged, not about staying caught up with a branch other work keeps advancing. */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Foreman, ClaudeCodeAdapter } from "../src/index.js";

/** master at the moment of the merge — "land story/bug-chores-can-never-dispatch...". */
const MASTER = "86a57fb";

describe("master was merged into this branch", () => {
  it("is an ancestor of the commit under test", () => {
    const base = execFileSync("git", ["rev-parse", MASTER], { encoding: "utf8" }).trim();
    const at = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const merged = execFileSync("git", ["merge-base", base, at], { encoding: "utf8" }).trim();
    expect(merged).toBe(base);
  });

  it("left no conflict marker anywhere in the tree", () => {
    // git grep exits 1 when it finds nothing, which is the answer this test wants.
    let hits = "";
    try {
      hits = execFileSync("git", ["grep", "-l", "-e", "^<<<<<<< ", "-e", "^>>>>>>> ", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      hits = "";
    }
    expect(hits).toBe("");
  });

  it("kept both sides of the foreman: master's chore brief and this branch's history", () => {
    const src = execFileSync("git", ["show", "HEAD:packages/runner/src/foreman.ts"], {
      encoding: "utf8",
    });
    expect(src).toContain("briefFor"); // master's: a chore is told what its check is
    expect(src).toContain("historyFor"); // this branch's: a retry is told what the last attempt did
    // The branch's call site awaited it, so master's async signature is the one that stands.
    expect(src).toContain("private async instructionFor");
    expect(typeof Foreman).toBe("function");
    expect(typeof ClaudeCodeAdapter).toBe("function");
  });
});
