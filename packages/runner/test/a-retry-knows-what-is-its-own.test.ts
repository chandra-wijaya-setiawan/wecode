import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type Inherited, Trees, inheritedReport } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A rejected attempt still commits, so a retry opens a branch that already has work on it.
 *  Every case here is the same question: of the commits it can see, which are the previous
 *  attempt's and which are the base it was cut from. */

let repo: string;
let outside: string;
let trees: Trees;
let n = 0;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (cwd: string, file: string, body: string, message: string): void => {
  writeFileSync(join(cwd, file), body);
  run(cwd, "add", "-A");
  run(cwd, "-c", "user.name=agent", "-c", "user.email=agent@localhost", "commit", "-q", "-m", message);
};

beforeEach(() => {
  repo = tmp("wecode-inherited-");
  outside = tmp("wecode-inherited-outside-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  run(repo, "add", "-A");
  run(repo, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "seed");
  trees = new Trees(repo, "main");
});

/** One attempt: a tree at the task branch tip, two commits of its own, committed back. */
const attemptWrites = async (...messages: string[]): Promise<string> => {
  const branch = await trees.taskBranch("s", "t");
  const path = join(outside, `wt-${n++}`);
  await trees.cut(branch, path);
  for (const m of messages) commit(path, `${m}.ts`, `export const ${m} = 1;\n`, m);
  await trees.commitAttempt(path, branch, `t: ${messages.join(", ")}`);
  return branch;
};

describe("what a retry inherits", () => {
  it("names the story tip as the base when nothing has been attempted", async () => {
    await trees.taskBranch("s", "t");

    const inherited = await trees.inherited("t", "s");

    expect(inherited.commits).toEqual([]);
    expect(inherited.base).toEqual({ ref: "story/s", sha: run(repo, "rev-parse", "story/s") });
  });

  it("answers for a task branch that does not exist yet", async () => {
    await trees.storyBranch("s");

    const inherited = await trees.inherited("t", "s");

    expect(inherited.commits).toEqual([]);
    expect(inherited.base.sha).toBe(run(repo, "rev-parse", "story/s"));
  });

  it("lists the previous attempt's commits, newest first, and stops at the base", async () => {
    const base = run(repo, "rev-parse", await trees.storyBranch("s"));
    await attemptWrites("first", "second");

    const inherited = await trees.inherited("t", "s");

    expect(inherited.commits.map((c) => c.subject)).toEqual(["second", "first"]);
    expect(inherited.base).toEqual({ ref: "story/s", sha: base });
    // The shas are the branch's own, in the branch's own order.
    expect(inherited.commits.map((c) => c.sha)).toEqual(
      run(repo, "log", "--format=%H", `${base}..task/t`).split("\n"),
    );
  });

  it("counts a sibling's landed work as the base, not as the attempt's", async () => {
    const story = await trees.storyBranch("s");
    await attemptWrites("mine");
    // A sibling task merges into the story after this attempt was cut.
    const sibling = join(outside, "sibling");
    run(repo, "worktree", "add", "-q", "--detach", sibling, story);
    commit(sibling, "theirs.ts", "export const theirs = 1;\n", "theirs");
    run(repo, "update-ref", `refs/heads/${story}`, run(sibling, "rev-parse", "HEAD"));

    const inherited = await trees.inherited("t", "s");

    expect(inherited.commits.map((c) => c.subject)).toEqual(["mine"]);
    // Not the story tip, which the task branch does not even contain.
    expect(inherited.base.sha).not.toBe(run(repo, "rev-parse", story));
    expect(inherited.base.sha).toBe(run(repo, "merge-base", story, "task/t"));
  });

  it("keeps the earlier attempt's commits once a second attempt has added to them", async () => {
    const base = run(repo, "rev-parse", await trees.storyBranch("s"));
    await attemptWrites("first");
    await attemptWrites("second");

    const inherited = await trees.inherited("t", "s");

    expect(inherited.commits.map((c) => c.subject)).toEqual(["second", "first"]);
    expect(inherited.base.sha).toBe(base);
  });

  it("falls back to the integration branch when there is no story branch", async () => {
    const inherited = await trees.inherited("t", "s");

    expect(inherited.base).toEqual({ ref: "main", sha: run(repo, "rev-parse", "main") });
    expect(inherited.commits).toEqual([]);
  });
});

describe("the sentence a retry is told", () => {
  const sha = (c: string): string => c.repeat(40);

  it("says the branch is all base when there is nothing of its own", () => {
    const inherited: Inherited = { base: { ref: "story/s", sha: sha("a") }, commits: [] };

    expect(inheritedReport("task/t", inherited)).toBe(
      "task/t has no commits of its own: all of it is the base, story/s aaaaaaaaaaaa.",
    );
  });

  it("names every attempt commit, and the sha to diff the attempt's work against", () => {
    const inherited: Inherited = {
      base: { ref: "story/s", sha: sha("a") },
      commits: [
        { sha: sha("c"), subject: "second" },
        { sha: sha("b"), subject: "first" },
      ],
    };

    expect(inheritedReport("task/t", inherited)).toBe(
      "task/t carries 2 commits from a previous attempt, newest first:\n" +
        "  cccccccccccc second\n" +
        "  bbbbbbbbbbbb first\n" +
        "Everything below bbbbbbbbbbbb is the base, story/s aaaaaaaaaaaa. " +
        "Diff against aaaaaaaaaaaa to see only the attempt's work.",
    );
  });

  it("counts one commit in the singular", () => {
    const inherited: Inherited = {
      base: { ref: "story/s", sha: sha("a") },
      commits: [{ sha: sha("b"), subject: "only" }],
    };

    expect(inheritedReport("task/t", inherited)).toContain("carries 1 commit from a previous");
  });

  it("describes a real branch the same way it reads it", async () => {
    await attemptWrites("first");
    const inherited = await trees.inherited("t", "s");

    const report = inheritedReport("task/t", inherited);

    expect(report).toContain(inherited.commits[0].sha.slice(0, 12));
    expect(report).toContain(inherited.base.sha.slice(0, 12));
  });
});
