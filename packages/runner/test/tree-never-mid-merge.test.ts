import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, Trees } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Both merges `Trees` makes — a task into the story tree, and a story into the base
 *  checkout — left the tree they ran in mid-merge when they conflicted: a conflicted index,
 *  `MERGE_HEAD` written, and half of another branch in the working files. The story tree is
 *  reused by the next task merge and by the examiner; the base checkout is a person's. Both
 *  are left as they were, and the error says which of the two happened. */

let repo: string;
let trees: Trees;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (cwd: string, name: string, body: string): void => {
  writeFileSync(join(cwd, name), body);
  run(cwd, "add", "-A");
  run(cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", `${name}: ${body}`);
};

/** Where git keeps this worktree's own state — `MERGE_HEAD` lives here, not in the repo. */
const gitDirOf = (tree: string): string => run(tree, "rev-parse", "--absolute-git-dir");

beforeEach(() => {
  repo = tmp("wecode-mid-merge-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "seed");
  trees = new Trees(repo, "main");
});

/** A task branch and a story branch that both rewrote README.md: the merge can only
 *  conflict. Returns the story tree, already holding the story's own version. */
async function conflictingTask(storySlug: string, taskSlug: string): Promise<string> {
  const task = await trees.taskBranch(storySlug, taskSlug);
  const cut = await trees.cut(task, tmp("wecode-mid-merge-task-"));
  commit(cut, "README.md", "the task's idea\n");
  run(repo, "update-ref", `refs/heads/${task}`, run(cut, "rev-parse", "HEAD"));

  const tree = await trees.storyTree(storySlug, tmp("wecode-mid-merge-story-"));
  commit(tree, "README.md", "the story's idea\n");
  run(repo, "update-ref", `refs/heads/story/${storySlug}`, run(tree, "rev-parse", "HEAD"));
  return tree;
}

/** An abort that will not run: every other git goes through untouched, and `merge --abort`
 *  alone fails, leaving the conflicted merge standing exactly as a refused abort does. */
let savedPath: string | undefined;

function wedgeTheAbort(): void {
  const bin = tmp("wecode-mid-merge-shim-");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = merge ] && [ "$2" = --abort ]; then\n  echo "fatal: refusing to abort" >&2\n  exit 128\nfi\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  );
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
}

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  savedPath = undefined;
});

describe("a task merge that conflicts", () => {
  it("leaves the story tree as it was, and says so", async () => {
    const tree = await conflictingTask("password-reset", "send-mail");
    const was = run(tree, "rev-parse", "HEAD");

    const err = await trees
      .mergeTaskIntoStory("task/send-mail", "password-reset", tree)
      .then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(GitError);
    expect(err?.message).toContain("merge task/send-mail into story/password-reset failed");
    expect(err?.message).toContain("no merge is left standing: the tree is as it was");

    // and the sentence is true of the tree
    expect(existsSync(join(gitDirOf(tree), "MERGE_HEAD"))).toBe(false);
    expect(run(tree, "status", "--porcelain")).toBe("");
    expect(run(tree, "rev-parse", "HEAD")).toBe(was);
  });

  it("says the story tree is left mid-merge when the abort will not run", async () => {
    const tree = await conflictingTask("password-reset", "send-mail");
    wedgeTheAbort();

    const err = await trees
      .mergeTaskIntoStory("task/send-mail", "password-reset", tree)
      .then(() => null, (e: Error) => e);

    expect(err?.message).toContain("the merge would not abort");
    expect(err?.message).toContain(tree);
    expect(err?.message).toContain("wants a person");
    // the claim is checked, not assumed
    expect(existsSync(join(gitDirOf(tree), "MERGE_HEAD"))).toBe(true);
  });
});

describe("a landing merge that conflicts", () => {
  it("leaves the base checkout as it was, and says so", async () => {
    const story = await trees.storyBranch("password-reset");
    const cut = await trees.cut(story, tmp("wecode-mid-merge-land-"));
    commit(cut, "README.md", "the story's idea\n");
    run(repo, "update-ref", `refs/heads/${story}`, run(cut, "rev-parse", "HEAD"));
    commit(repo, "README.md", "the base's idea\n");
    const was = run(repo, "rev-parse", "HEAD");

    const err = await trees.land("password-reset", repo).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(GitError);
    expect(err?.message).toContain("land story/password-reset failed");
    expect(err?.message).toContain("no merge is left standing: the tree is as it was");
    expect(existsSync(join(gitDirOf(repo), "MERGE_HEAD"))).toBe(false);
    expect(run(repo, "status", "--porcelain")).toBe("");
    expect(run(repo, "rev-parse", "HEAD")).toBe(was);
  });
});
