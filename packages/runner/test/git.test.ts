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

describe("cleanup once a story has landed", () => {
  const land = async (storyTree: string, ...taskSlugs: string[]) => {
    for (const slug of taskSlugs) {
      const branch = await trees.taskBranch("s", slug);
      const path = join(repo, "..", `wt-${slug}-${Date.now()}`);
      await trees.cut(branch, path);
      writeFileSync(join(path, `${slug}.ts`), "x\n");
      await trees.commitAttempt(path, branch, slug);
      await trees.release(path);
      await trees.mergeTaskIntoStory(branch, "s", storyTree);
    }
  };

  it("removes the story tree, the story branch and each task branch", async () => {
    const storyTree = join(repo, "..", `story-clean-${Date.now()}`);
    await land(storyTree, "send-mail", "expire-token");

    const report = await trees.cleanupLanded("s", storyTree, ["send-mail", "expire-token"]);

    expect(existsSync(storyTree)).toBe(false);
    expect(report.left).toEqual([]);
    expect(report.removed).toEqual([storyTree, "story/s", "task/send-mail", "task/expire-token"]);
    expect(run(repo, "branch", "--list", "story/s")).toBe("");
    expect(run(repo, "branch", "--list", "task/*")).toBe("");
  });

  it("leaves a story tree holding uncommitted files, and its branch with it", async () => {
    const storyTree = join(repo, "..", `story-dirty-${Date.now()}`);
    await land(storyTree, "send-mail");
    writeFileSync(join(storyTree, "half-done.ts"), "nobody has seen this\n");

    const report = await trees.cleanupLanded("s", storyTree, ["send-mail"]);

    expect(existsSync(join(storyTree, "half-done.ts"))).toBe(true);
    expect(report.left).toEqual([
      { what: storyTree, why: "uncommitted files nobody has seen" },
      { what: "story/s", why: `its tree is still standing at ${storyTree}` },
    ]);
    expect(run(repo, "branch", "--list", "story/s").trim()).toContain("story/s");
    expect(report.removed).toEqual(["task/send-mail"]);
  });

  it("counts an untracked file as unseen work", async () => {
    const storyTree = join(repo, "..", `story-untracked-${Date.now()}`);
    await land(storyTree, "send-mail");
    writeFileSync(join(storyTree, "scratch.txt"), "notes\n");

    const report = await trees.cleanupLanded("s", storyTree, []);
    expect(report.left[0]).toEqual({ what: storyTree, why: "uncommitted files nobody has seen" });
    expect(existsSync(storyTree)).toBe(true);
  });

  it("leaves a task branch whose own tree is still dirty", async () => {
    const storyTree = join(repo, "..", `story-taskdirty-${Date.now()}`);
    await land(storyTree, "send-mail");
    const stray = join(repo, "..", `wt-stray-${Date.now()}`);
    run(repo, "worktree", "add", stray, "task/send-mail");
    writeFileSync(join(stray, "in-flight.ts"), "mid-edit\n");

    const report = await trees.cleanupLanded("s", storyTree, ["send-mail"]);

    expect(existsSync(join(stray, "in-flight.ts"))).toBe(true);
    expect(run(repo, "branch", "--list", "task/send-mail").trim()).toContain("task/send-mail");
    expect(report.left).toEqual([
      { what: stray, why: "uncommitted files nobody has seen" },
      { what: "task/send-mail", why: `its tree is still standing at ${stray}` },
    ]);
    expect(report.removed).toContain(storyTree);
  });

  it("releases a clean task tree before deleting its branch", async () => {
    const storyTree = join(repo, "..", `story-taskclean-${Date.now()}`);
    await land(storyTree, "send-mail");
    const spare = join(repo, "..", `wt-spare-${Date.now()}`);
    run(repo, "worktree", "add", spare, "task/send-mail");

    const report = await trees.cleanupLanded("s", storyTree, ["send-mail"]);

    expect(existsSync(spare)).toBe(false);
    expect(report.removed).toContain(spare);
    expect(report.removed).toContain("task/send-mail");
  });

  it("is safe to run twice: the second pass has nothing left to do", async () => {
    const storyTree = join(repo, "..", `story-twice-${Date.now()}`);
    await land(storyTree, "send-mail");
    await trees.cleanupLanded("s", storyTree, ["send-mail"]);

    const again = await trees.cleanupLanded("s", storyTree, ["send-mail"]);
    expect(again).toEqual({ removed: [], left: [] });
  });
});

describe("the integration branch", () => {
  it("is whatever the repository's HEAD says, not an assumption", async () => {
    const other = mkdtempSync(join(tmpdir(), "wecode-master-"));
    run(other, "init", "-q", "-b", "master");
    run(other, "config", "user.name", "t");
    run(other, "config", "user.email", "t@localhost");
    writeFileSync(join(other, "README.md"), "x\n");
    run(other, "add", "-A");
    run(other, "commit", "-q", "-m", "seed");

    const t = new Trees(other);
    expect(await t.integrationBranch()).toBe("master");
    await t.storyBranch("s");
    expect(run(other, "rev-parse", "story/s")).toBe(run(other, "rev-parse", "master"));
  });
});
