import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GitError, Trees } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** `git merge` exits 0 and prints "Already up to date" when there was nothing to merge, so a
 *  task merge that left the story branch exactly where it was is indistinguishable, from its
 *  exit code, from one that landed the work. The daemon records the landing either way and
 *  the task is never merged again. So the story tip is read either side of the merge and a
 *  merge that moved nothing is refused, naming the branch, the story and the tip it is
 *  still at. */

let repo: string;
let trees: Trees;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (cwd: string, files: Record<string, string>): void => {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), body);
  }
  run(cwd, "add", "-A");
  run(cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "w");
};

beforeEach(() => {
  repo = tmp("wecode-moved-nothing-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  commit(repo, { "README.md": "seed\n" });
  trees = new Trees(repo, "main");
});

const failureOf = async (branch: string, slug: string, tree: string): Promise<Error | null> =>
  trees.mergeTaskIntoStory(branch, slug, tree).then(
    () => null,
    (e: Error) => e,
  );

describe("a task merge that leaves the story branch where it was", () => {
  it("is refused when the task branch is already in the story", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    const cut = await trees.cut(task, tmp("wecode-moved-nothing-task-"));
    commit(cut, { "src/mail.ts": "the task\n" });
    run(repo, "update-ref", `refs/heads/${task}`, run(cut, "rev-parse", "HEAD"));

    const tree = await trees.storyTree("password-reset", tmp("wecode-moved-nothing-story-"));
    // merged once, for real: the story gains the work
    await trees.mergeTaskIntoStory(task, "password-reset", tree);
    const landed = run(tree, "rev-parse", "HEAD");

    // merged again: git says "Already up to date" and exits 0
    const err = await failureOf(task, "password-reset", tree);

    expect(err).toBeInstanceOf(GitError);
    expect(err?.message).toContain("merge task/send-mail into story/password-reset moved nothing");
    expect(err?.message).toContain(`story/password-reset is still at ${landed.slice(0, 12)}`);
    expect(err?.message).toContain("already in story/password-reset");
    // and the refusal is a report, not a change: the story is where the first merge left it
    expect(run(tree, "rev-parse", "HEAD")).toBe(landed);
    expect(run(repo, "rev-parse", "refs/heads/story/password-reset")).toBe(landed);
  });

  it("says nothing of the kind when the merge did move the story", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    const cut = await trees.cut(task, tmp("wecode-moved-nothing-ok-"));
    commit(cut, { "src/mail.ts": "the task\n" });
    run(repo, "update-ref", `refs/heads/${task}`, run(cut, "rev-parse", "HEAD"));
    const tree = await trees.storyTree("password-reset", tmp("wecode-moved-nothing-okstory-"));
    const was = run(tree, "rev-parse", "HEAD");

    await expect(trees.mergeTaskIntoStory(task, "password-reset", tree)).resolves.toBeUndefined();

    expect(run(tree, "rev-parse", "HEAD")).not.toBe(was);
    expect(run(repo, "rev-parse", "refs/heads/story/password-reset")).toBe(
      run(tree, "rev-parse", "HEAD"),
    );
  });

  it("still reports a failed merge as a failure, not as a merge that moved nothing", async () => {
    const tree = await trees.storyTree("password-reset", tmp("wecode-moved-nothing-gone-"));

    const err = await failureOf("task/never-existed", "password-reset", tree);

    expect(err).toBeInstanceOf(GitError);
    expect(err?.message).toContain("merge task/never-existed into story/password-reset failed");
    expect(err?.message).not.toContain("moved nothing");
  });
});
