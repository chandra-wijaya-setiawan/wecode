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

const commit = (name: string): string => {
  writeFileSync(join(repo, `${name}.md`), `${name}\n`);
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", name);
  return run(repo, "rev-parse", "HEAD");
};

/** Leave `task/send-mail` diverged from its story: one commit of its own, one sibling
 *  commit on the story branch it does not have. */
const diverge = async (attemptFile: string): Promise<string> => {
  const task = await trees.taskBranch("password-reset", "send-mail");
  run(repo, "checkout", "-q", task);
  const attempt = commit(attemptFile);
  run(repo, "checkout", "-q", "story/password-reset");
  commit(`sibling-${attemptFile}`);
  run(repo, "checkout", "-q", "main");
  return attempt;
};

beforeEach(() => {
  repo = tmp("wecode-attempt-tag-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  commit("seed");
  trees = new Trees(repo, "main");
});

describe("a diverged task branch is tagged as an attempt and re-cut", () => {
  it("does not stall the queue: the task branch is handed back, at the story tip", async () => {
    await diverge("attempt");
    const storyTip = run(repo, "rev-parse", "story/password-reset");

    expect(await trees.taskBranch("password-reset", "send-mail")).toBe("task/send-mail");
    expect(run(repo, "rev-parse", "task/send-mail")).toBe(storyTip);
  });

  it("loses nothing: the diverged tip is still reachable by its tag", async () => {
    const attempt = await diverge("attempt");
    await trees.taskBranch("password-reset", "send-mail");

    expect(run(repo, "rev-parse", "attempt/send-mail/1")).toBe(attempt);
    expect(run(repo, "log", "--format=%s", "-1", "attempt/send-mail/1")).toBe("attempt");
  });

  it("numbers each attempt in the order it was set aside", async () => {
    const first = await diverge("first");
    await trees.taskBranch("password-reset", "send-mail");
    const second = await diverge("second");
    await trees.taskBranch("password-reset", "send-mail");

    expect(await trees.attemptTags("task/send-mail")).toEqual([
      "attempt/send-mail/1",
      "attempt/send-mail/2",
    ]);
    expect(run(repo, "rev-parse", "attempt/send-mail/1")).toBe(first);
    expect(run(repo, "rev-parse", "attempt/send-mail/2")).toBe(second);
  });

  it("tags nothing when the branch is simply behind the story", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    run(repo, "checkout", "-q", "story/password-reset");
    commit("sibling");
    run(repo, "checkout", "-q", "main");

    await trees.taskBranch("password-reset", "send-mail");
    expect(await trees.attemptTags(task)).toEqual([]);
  });

  it("tags nothing when the branch is ahead of the story — that work is not orphaned", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    run(repo, "checkout", "-q", task);
    const attempt = commit("attempt");
    run(repo, "checkout", "-q", "main");

    await trees.taskBranch("password-reset", "send-mail");
    expect(run(repo, "rev-parse", task)).toBe(attempt);
    expect(await trees.attemptTags(task)).toEqual([]);
  });

  it("cuts the next assignment's tree from the re-cut tip, not the tagged one", async () => {
    await diverge("attempt");
    const task = await trees.taskBranch("password-reset", "send-mail");

    const path = join(tmp("wecode-attempt-tree-"), "wt");
    await trees.cut(task, path);
    expect(run(path, "log", "--format=%s", "-1")).toBe("sibling-attempt");
  });

  it("survives the branch being deleted: the tag is the copy that outlives it", async () => {
    const attempt = await diverge("attempt");
    await trees.taskBranch("password-reset", "send-mail");
    run(repo, "branch", "-D", "task/send-mail");

    expect(run(repo, "rev-parse", "attempt/send-mail/1")).toBe(attempt);
    expect(run(repo, "cat-file", "-t", attempt)).toBe("commit");
  });
});
