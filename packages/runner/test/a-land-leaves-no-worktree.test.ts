import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tmp } from "../../core/test/tmpdir.js";
import { branchesToRemoveAfterLanding } from "../../core/src/land.js";
import { Trees } from "../src/index.js";

/** Landing is the point at which a story's branches stop being copies of unread work.
 *  A task branch that was actually merged can go with the story; a branch that was not
 *  merged is still the only place its work has been read, so cleanup must not guess. */
let repo: string;
let trees: Trees;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = tmp("wecode-land-cleanup-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@localhost");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  trees = new Trees(repo, "main");
});

const commitTask = async (storyTree: string, slug: string): Promise<void> => {
  const branch = await trees.taskBranch("shipped", slug);
  const attempt = tmp(`wecode-land-attempt-${slug}-`);
  await trees.cut(branch, attempt);
  writeFileSync(join(attempt, `${slug}.ts`), "merged\n");
  await trees.commitAttempt(attempt, branch, `finish ${slug}`);
  await trees.release(attempt);
  await trees.mergeTaskIntoStory(branch, "shipped", storyTree);
};

describe("a landed story leaves no worktree for work it merged", () => {
  it("removes its tree and merged branches, but leaves an unmerged branch alone", async () => {
    const storyTree = tmp("wecode-land-story-");
    await trees.storyTree("shipped", storyTree);
    await commitTask(storyTree, "send-mail");
    await commitTask(storyTree, "run-report");

    // This branch has unread work and even an open checkout. It is deliberately not part of
    // the merged list handed to cleanup: landing must not infer that it was safe to delete.
    const unreadBranch = await trees.taskBranch("shipped", "unread-work");
    const unreadTree = tmp("wecode-land-unread-");
    await trees.cut(unreadBranch, unreadTree);
    writeFileSync(join(unreadTree, "not-reviewed.ts"), "keep me\n");

    const removable = branchesToRemoveAfterLanding(`story/shipped`, [
      { branch: "task/send-mail", merged: true },
      { branch: "task/run-report", merged: true },
      { branch: unreadBranch, merged: false },
    ]);
    expect(removable).toEqual(["story/shipped", "task/send-mail", "task/run-report"]);
    const report = await trees.cleanupLanded(
      "shipped",
      storyTree,
      removable.filter((branch) => branch.startsWith("task/")).map((branch) => branch.slice("task/".length)),
    );

    expect(report.left).toEqual([]);
    expect(report.removed).toEqual([
      storyTree,
      "story/shipped",
      "task/send-mail",
      "task/run-report",
    ]);
    expect(existsSync(storyTree)).toBe(false);
    expect(git(repo, "branch", "--list", "story/shipped")).toBe("");
    expect(git(repo, "branch", "--list", "task/send-mail")).toBe("");
    expect(git(repo, "branch", "--list", "task/run-report")).toBe("");

    // The branch, its checkout, and its uncommitted work all survive the landing.
    expect(git(repo, "branch", "--list", "task/unread-work").trim()).toContain("task/unread-work");
    expect(existsSync(join(unreadTree, "not-reviewed.ts"))).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(`worktree ${unreadTree}`);
  });
});
