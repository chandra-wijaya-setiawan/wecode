import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GitError, Trees } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The harness holds the scope for the tools it grants, and a shell, a generator or a test
 *  run writes around it. `add -A` then carried those strays onto the task branch, and a
 *  merge put them on master. What the branch holds is what the scope named; the stray stays
 *  in the tree, uncommitted, where cleanup reports it. */

let repo: string;
let outside: string;
let trees: Trees;
let n = 0;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const write = (cwd: string, file: string, body: string): void => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), body);
};

/** Every path the branch tip holds — the only question that matters. */
const filesOn = (branch: string): string[] =>
  run(repo, "ls-tree", "-r", "--name-only", branch).split("\n").filter((f) => f !== "");

/** What the tree still carries that nobody has committed — changed or untracked. */
const dirty = (path: string): string[] =>
  [
    run(path, "diff", "--name-only", "HEAD"),
    run(path, "ls-files", "--others", "--exclude-standard"),
  ]
    .flatMap((out) => out.split("\n"))
    .filter((f) => f !== "")
    .sort();

const SCOPE = ["packages/runner/src/git.ts", "packages/runner/test/**"];

/** Stop one ref from moving, and only that one, through git's own `reference-transaction`
 *  hook: a non-zero exit aborts the update. A detached worktree's HEAD is a ref of its own,
 *  so refusing the branch leaves the scoped commit made and the branch behind it. */
const refuse = (ref: string): void => {
  const hook = join(repo, ".git/hooks/reference-transaction");
  writeFileSync(hook, `#!/bin/sh\nwhile read -r old new name; do\n  [ "$name" = "${ref}" ] && exit 1\ndone\nexit 0\n`);
  chmodSync(hook, 0o755);
};

beforeEach(async () => {
  repo = tmp("wecode-scoped-commit-");
  outside = tmp("wecode-scoped-commit-outside-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  write(repo, "packages/runner/src/git.ts", "export const cut = 0;\n");
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

describe("a commit carries only the scope", () => {
  it("commits the in-scope writes and leaves the stray in the tree", async () => {
    const { branch, path } = await attempt();
    write(path, "packages/runner/src/git.ts", "export const cut = 1;\n");
    write(path, "packages/runner/test/git.test.ts", "export const proved = true;\n");
    write(path, "mail.ts", "export const stray = true;\n");

    const sha = await trees.commitAttempt(path, branch, "t: attempt", SCOPE);

    expect(sha).not.toBeNull();
    expect(filesOn(branch).sort()).toEqual([
      "packages/runner/src/git.ts",
      "packages/runner/test/git.test.ts",
    ]);
    expect(run(repo, "show", `${branch}:packages/runner/src/git.ts`)).toBe("export const cut = 1;");
    // Left behind, not lost: the file is still on disk and still uncommitted.
    expect(dirty(path)).toEqual(["mail.ts"]);
    expect(readFileSync(join(path, "mail.ts"), "utf8")).toBe("export const stray = true;\n");
  });

  it("does not commit a stray the attempt staged for itself", async () => {
    const { branch, path } = await attempt();
    write(path, "packages/runner/src/git.ts", "export const cut = 1;\n");
    write(path, "mail.ts", "export const stray = true;\n");
    run(path, "add", "mail.ts");

    await trees.commitAttempt(path, branch, "t: attempt", SCOPE);

    expect(filesOn(branch)).toEqual(["packages/runner/src/git.ts"]);
    expect(dirty(path)).toEqual(["mail.ts"]);
  });

  it("carries an in-scope deletion and leaves an out-of-scope one standing", async () => {
    write(repo, "config/views.yaml", "boxes: []\n");
    run(repo, "add", "-A");
    run(repo, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "views");
    write(repo, "packages/runner/test/old.test.ts", "export const old = true;\n");
    run(repo, "add", "-A");
    run(repo, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "old test");

    const { branch, path } = await attempt();
    rmSync(join(path, "packages/runner/test/old.test.ts"));
    rmSync(join(path, "config/views.yaml"));

    await trees.commitAttempt(path, branch, "t: attempt", SCOPE);

    expect(filesOn(branch).sort()).toEqual(["config/views.yaml", "packages/runner/src/git.ts"]);
    expect(dirty(path)).toEqual(["config/views.yaml"]);
  });

  it("commits nothing when every write is out of scope", async () => {
    const { branch, path } = await attempt();
    const tip = run(repo, "rev-parse", branch);
    write(path, "mail.ts", "export const stray = true;\n");

    expect(await trees.commitAttempt(path, branch, "t: attempt", SCOPE)).toBeNull();

    expect(run(repo, "rev-parse", branch)).toBe(tip);
    expect(dirty(path)).toEqual(["mail.ts"]);
    expect(existsSync(join(path, "mail.ts"))).toBe(true);
  });

  it("commits nothing out of scope even when the scope is empty", async () => {
    const { branch, path } = await attempt();
    const tip = run(repo, "rev-parse", branch);
    write(path, "packages/runner/src/git.ts", "export const cut = 1;\n");

    expect(await trees.commitAttempt(path, branch, "t: attempt", [])).toBeNull();

    expect(run(repo, "rev-parse", branch)).toBe(tip);
    expect(dirty(path)).toEqual(["packages/runner/src/git.ts"]);
  });

  it("stages the whole tree when no scope is given at all", async () => {
    const { branch, path } = await attempt();
    write(path, "mail.ts", "export const stray = true;\n");

    await trees.commitAttempt(path, branch, "t: attempt");

    expect(filesOn(branch).sort()).toEqual(["mail.ts", "packages/runner/src/git.ts"]);
    expect(dirty(path)).toEqual([]);
  });

  it("names the scoped commit it made when the branch will not take it", async () => {
    const { branch, path } = await attempt();
    const tip = run(repo, "rev-parse", branch);
    write(path, "packages/runner/src/git.ts", "export const cut = 1;\n");
    write(path, "mail.ts", "export const stray = true;\n");
    refuse(`refs/heads/${branch}`);

    const err = await trees
      .commitAttempt(path, branch, "t: attempt", SCOPE)
      .catch((e: unknown) => e as GitError);

    // The staging was never the problem: the commit exists, it holds the scope and nothing
    // else, and the only thing that did not happen is the branch moving onto it.
    expect(err.made).toBe(run(path, "rev-parse", "HEAD"));
    expect(run(path, "show", "--name-only", "--format=", "HEAD")).toBe("packages/runner/src/git.ts");
    expect(run(repo, "rev-parse", branch)).toBe(tip);
    expect(dirty(path)).toEqual(["mail.ts"]);
  });

  it("still carries the attempt's own commits, whatever they touched", async () => {
    const { branch, path } = await attempt();
    write(path, "mail.ts", "export const stray = true;\n");
    run(path, "add", "-A");
    run(path, "-c", "user.name=agent", "-c", "user.email=agent@localhost", "commit", "-q", "-m", "its own");
    write(path, "packages/runner/src/git.ts", "export const cut = 1;\n");

    const sha = await trees.commitAttempt(path, branch, "t: attempt", SCOPE);

    // A commit the attempt made is already history: unstaging cannot reach it, and dropping
    // it would lose the rest of that commit too.
    expect(run(repo, "rev-parse", branch)).toBe(sha);
    expect(run(repo, "log", "--format=%s", branch).split("\n").slice(0, 2)).toEqual([
      "t: attempt",
      "its own",
    ]);
    expect(filesOn(branch)).toContain("mail.ts");
    expect(run(repo, "show", `${branch}:packages/runner/src/git.ts`)).toBe("export const cut = 1;");
  });
});
