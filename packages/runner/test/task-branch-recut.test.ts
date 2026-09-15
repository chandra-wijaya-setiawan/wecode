import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Trees } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

let repo: string;
let trees: Trees;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A commit on whatever branch is checked out. */
const commit = (name: string): string => {
  writeFileSync(join(repo, `${name}.md`), `${name}\n`);
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", name);
  return run(repo, "rev-parse", "HEAD");
};

beforeEach(() => {
  repo = tmp("wecode-recut-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  commit("seed");
  trees = new Trees(repo, "main");
});

describe("a task branch is re-cut when the story has moved past it", () => {
  it("moves a branch the story branch left behind to the story tip", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    const cutAt = run(repo, "rev-parse", task);

    // A sibling task merges: the story branch advances, this branch does not.
    run(repo, "checkout", "-q", "story/password-reset");
    const sibling = commit("sibling");
    run(repo, "checkout", "-q", "main");
    expect(run(repo, "rev-parse", task)).toBe(cutAt);

    expect(await trees.taskBranch("password-reset", "send-mail")).toBe(task);
    expect(run(repo, "rev-parse", task)).toBe(sibling);
  });

  it("re-cuts a branch whose tip shares no history with the story at all", async () => {
    // The slug was used before, on a branch from another life entirely.
    run(repo, "checkout", "-q", "--orphan", "other");
    const orphan = commit("elsewhere");
    run(repo, "branch", "task/send-mail", orphan);
    run(repo, "checkout", "-q", "main");

    await expect(trees.taskBranch("password-reset", "send-mail")).rejects.toThrow(
      /not a descendant of story\/password-reset/,
    );
    expect(run(repo, "rev-parse", "task/send-mail")).toBe(orphan);
  });

  it("leaves a branch that is already at, or ahead of, the story tip alone", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    expect(run(repo, "rev-parse", task)).toBe(run(repo, "rev-parse", "story/password-reset"));

    // An attempt commits on the task branch; the story branch has not moved.
    run(repo, "checkout", "-q", task);
    const attempt = commit("attempt");
    run(repo, "checkout", "-q", "main");

    expect(await trees.taskBranch("password-reset", "send-mail")).toBe(task);
    expect(run(repo, "rev-parse", task)).toBe(attempt);
  });

  it("refuses rather than losing an attempt when both branches have moved", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    run(repo, "checkout", "-q", task);
    const attempt = commit("attempt");
    run(repo, "checkout", "-q", "story/password-reset");
    commit("sibling");
    run(repo, "checkout", "-q", "main");

    await expect(trees.taskBranch("password-reset", "send-mail")).rejects.toThrow(
      /re-cutting it would lose them/,
    );
    expect(run(repo, "rev-parse", task)).toBe(attempt);
  });

  it("cuts an assignment's tree from the re-cut tip, not the stale one", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    run(repo, "checkout", "-q", "story/password-reset");
    commit("sibling");
    run(repo, "checkout", "-q", "main");

    await trees.taskBranch("password-reset", "send-mail");
    const path = join(tmp("wecode-recut-tree-"), "wt");
    await trees.cut(task, path);
    expect(run(path, "log", "--format=%s", "-1")).toBe("sibling");
  });
});
