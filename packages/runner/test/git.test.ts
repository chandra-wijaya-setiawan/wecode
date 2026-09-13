import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Trees } from "../src/index.js";

let repo: string;
let trees: Trees;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-git-"));
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "seed");
  trees = new Trees(repo, "main");
});

describe("branches", () => {
  it("cuts a story branch from the integration branch, once", async () => {
    const a = await trees.storyBranch("password-reset");
    const b = await trees.storyBranch("password-reset");
    expect(a).toBe("story/password-reset");
    expect(b).toBe(a);
    expect(run(repo, "rev-parse", a)).toBe(run(repo, "rev-parse", "main"));
  });

  it("cuts a task branch from the story branch", async () => {
    const task = await trees.taskBranch("password-reset", "send-mail");
    expect(task).toBe("task/send-mail");
    expect(run(repo, "rev-parse", task)).toBe(run(repo, "rev-parse", "story/password-reset"));
  });
});

describe("a worktree per attempt", () => {
  it("cuts a fresh tree and releases it", async () => {
    const branch = await trees.taskBranch("s", "t");
    const path = join(repo, "..", `wt-${Date.now()}`);
    await trees.cut(branch, path);
    expect(existsSync(join(path, "README.md"))).toBe(true);
    await trees.release(path);
    expect(existsSync(path)).toBe(false);
  });

  it("commits what the attempt wrote, onto the task branch", async () => {
    const branch = await trees.taskBranch("s", "t");
    const path = join(repo, "..", `wt2-${Date.now()}`);
    await trees.cut(branch, path);
    writeFileSync(join(path, "mail.ts"), "export const send = () => {};\n");

    const sha = await trees.commitAttempt(path, branch, "send-mail: attempt");
    expect(sha).not.toBeNull();
    expect(run(repo, "rev-parse", branch)).toBe(sha);
    expect(run(repo, "show", "--name-only", "--format=", branch)).toContain("mail.ts");
    await trees.release(path);
  });

  it("commits nothing when the attempt wrote nothing", async () => {
    const branch = await trees.taskBranch("s", "t");
    const path = join(repo, "..", `wt3-${Date.now()}`);
    await trees.cut(branch, path);
    expect(await trees.commitAttempt(path, branch, "empty")).toBeNull();
    await trees.release(path);
  });
});

describe("merging", () => {
  it("lands a task branch on the story branch without touching the integration checkout", async () => {
    const branch = await trees.taskBranch("s", "t");
    const path = join(repo, "..", `wt4-${Date.now()}`);
    await trees.cut(branch, path);
    writeFileSync(join(path, "mail.ts"), "x\n");
    await trees.commitAttempt(path, branch, "attempt");
    await trees.release(path);

    await trees.mergeTaskIntoStory(branch, "s", join(repo, "..", `story-${Date.now()}`));
    expect(run(repo, "ls-tree", "--name-only", "story/s")).toContain("mail.ts");
    expect(run(repo, "status", "--porcelain")).toBe("");
    expect(run(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
