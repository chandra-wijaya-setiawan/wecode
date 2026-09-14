import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Trees } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The worktree is cut `--detach`, so an attempt that commits for itself moves HEAD and not
 *  the task branch. Every case here is work that only exists in the attempt's own commits. */

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

/** What the branch actually holds — the only question that matters. */
const fileOn = (branch: string, file: string): string => run(repo, "show", `${branch}:${file}`);
const logOf = (branch: string): string[] => run(repo, "log", "--format=%s", branch).split("\n");

beforeEach(async () => {
  repo = tmp("wecode-attempt-");
  outside = tmp("wecode-attempt-outside-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  run(repo, "add", "-A");
  run(repo, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "seed");
  trees = new Trees(repo, "main");
});

const attempt = async (): Promise<{ branch: string; path: string }> => {
  const branch = await trees.taskBranch("s", "t");
  const path = join(outside, `wt-${n++}`);
  await trees.cut(branch, path);
  return { branch, path };
};

describe("an attempt that commits for itself", () => {
  it("carries both of its own commits onto the task branch", async () => {
    const { branch, path } = await attempt();
    commit(path, "a.ts", "export const a = 1;\n", "first");
    commit(path, "b.ts", "export const b = 2;\n", "second");

    const sha = await trees.commitAttempt(path, branch, "t: attempt");

    expect(sha).toBe(run(path, "rev-parse", "HEAD"));
    expect(run(repo, "rev-parse", branch)).toBe(sha);
    expect(logOf(branch).slice(0, 2)).toEqual(["second", "first"]);
    expect(fileOn(branch, "a.ts")).toBe("export const a = 1;");
    expect(fileOn(branch, "b.ts")).toBe("export const b = 2;");
  });

  it("keeps its commits and the dirty files it never staged", async () => {
    const { branch, path } = await attempt();
    commit(path, "a.ts", "export const a = 1;\n", "first");
    writeFileSync(join(path, "loose.ts"), "export const loose = 3;\n");

    const sha = await trees.commitAttempt(path, branch, "t: attempt");

    expect(run(repo, "rev-parse", branch)).toBe(sha);
    expect(logOf(branch).slice(0, 2)).toEqual(["t: attempt", "first"]);
    expect(fileOn(branch, "a.ts")).toBe("export const a = 1;");
    expect(fileOn(branch, "loose.ts")).toBe("export const loose = 3;");
  });

  it("carries a merge it performed, so history work is possible at all", async () => {
    run(repo, "branch", "other", "main");
    const worker = join(outside, "worker");
    run(repo, "worktree", "add", "-q", worker, "other");
    commit(worker, "moved.ts", "export const moved = 4;\n", "on other");
    run(repo, "worktree", "remove", "--force", worker);

    const { branch, path } = await attempt();
    run(path, "-c", "user.name=agent", "-c", "user.email=agent@localhost", "merge", "--no-ff", "-q", "-m", "merge other", "other");

    await trees.commitAttempt(path, branch, "t: attempt");

    expect(run(repo, "merge-base", "--is-ancestor", "other", branch)).toBe("");
    expect(fileOn(branch, "moved.ts")).toBe("export const moved = 4;");
  });

  it("refuses, naming both tips, when HEAD cannot fast-forward the branch", async () => {
    const { branch, path } = await attempt();
    commit(path, "a.ts", "export const a = 1;\n", "attempt side");
    const elsewhere = join(outside, "elsewhere");
    run(repo, "worktree", "add", "-q", "--detach", elsewhere, branch);
    commit(elsewhere, "z.ts", "export const z = 9;\n", "branch side");
    run(repo, "update-ref", `refs/heads/${branch}`, run(elsewhere, "rev-parse", "HEAD"));

    await expect(trees.commitAttempt(path, branch, "t: attempt")).rejects.toThrow(/diverged/);
    expect(fileOn(branch, "z.ts")).toBe("export const z = 9;");
  });
});
