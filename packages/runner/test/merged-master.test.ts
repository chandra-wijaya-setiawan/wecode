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
import { Foreman, ClaudeCodeAdapter, type Work } from "../src/index.js";

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

/** master was taken in a second time, and the same two files conflicted again — this time
 *  over the prompt itself. master asks a retry to read what the last attempt committed; this
 *  branch asks every attempt for a lesson and tells the next one what was learned. Taking
 *  either side would have compiled and silently dropped a feature, so both are named. */
describe("the second merge of master", () => {
  /** master at the moment of that merge — "land story/bug-a-condition-that-becomes-true...". */
  const MASTER = "39dca37";

  it("is an ancestor of the commit under test", () => {
    const base = execFileSync("git", ["rev-parse", MASTER], { encoding: "utf8" }).trim();
    expect(() => {
      execFileSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], { stdio: "ignore" });
    }).not.toThrow();
  });

  it("leaves Work carrying both the lessons and the history", () => {
    const ports = execFileSync("git", ["show", "HEAD:packages/runner/src/ports.ts"], {
      encoding: "utf8",
    });
    expect(ports).toContain("readonly lessons?: readonly string[]");
    expect(ports).toContain("readonly history: History | null");
  });

  it("puts both halves in one prompt", () => {
    const work: Work = {
      id: 1,
      objective_type: "task",
      objective_id: 1,
      instruction: "send the mail",
      scope: { write: ["src/**"], tools: ["bash"] },
      budget: { tokens: 100, seconds: 10 },
      worktree: "/tmp/wt",
      session: null,
      lessons: ["pnpm -r build first"],
      history: { attempts: 1, reason: "timeout", commit: "deadbee", failures: [] },
    };
    const prompt = (new ClaudeCodeAdapter() as unknown as { prompt(w: Work): string }).prompt(work);
    // This branch's: what was learned goes in, and the next lesson is asked for.
    expect(prompt).toContain("What earlier attempts on this repository learned:");
    expect(prompt).toContain("- pnpm -r build first");
    expect(prompt).toContain("beginning LESSON:");
    // master's: a retry is pointed at the commit the last attempt left.
    expect(prompt).toContain("## What happened before");
    expect(prompt).toContain("git show deadbee");
  });

  /** Both sides named by what they do, not by the statements they were once written as.
   *  The foreman has since been ported onto core's typed query layer: the lesson table is
   *  the record's, by migration `010-lesson.sql`, and the foreman neither declares it nor
   *  spells a query against it any more. Asserting the old `CREATE TABLE` text here would
   *  pin the merge to an implementation the merge was never about — so what is asserted is
   *  that both reads are still reachable, and that the lesson one goes through core. */
  it("keeps both of the foreman's reads: the project's lessons and the task's attempts", () => {
    const src = execFileSync("git", ["show", "HEAD:packages/runner/src/foreman.ts"], {
      encoding: "utf8",
    });
    expect(src).toContain("lessonsFor");
    expect(src).toContain("recordLesson");
    expect(src).toMatch(/\baddLesson\b/); // core's writer, which owns the table
    expect(src).toContain("historyFor");
    expect(src).toContain("failuresFor");
    expect(src).toContain("function lastLine");
  });
});
