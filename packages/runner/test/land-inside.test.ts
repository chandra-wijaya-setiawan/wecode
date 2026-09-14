import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Trees } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

// Field report 105. `land` run while standing in the story's own worktree merged the story
// branch into itself: nothing reached the base and the operator was told it landed.

let repo: string;
let storyTree: string;
let trees: Trees;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commitOn = (cwd: string, name: string): void => {
  writeFileSync(join(cwd, name), `${name}\n`);
  run(cwd, "add", "-A");
  run(cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", name);
};

beforeEach(async () => {
  repo = tmp("wecode-land-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "seed");

  trees = new Trees(repo, "main");
  storyTree = await trees.storyTree("password-reset", tmp("wecode-land-story-"));
  commitOn(storyTree, "delivered.txt");
  run(repo, "update-ref", "refs/heads/story/password-reset", run(storyTree, "rev-parse", "HEAD"));
});

describe("landing from inside the story's worktree", () => {
  it("refuses, naming the tree it is in and the tree to run it in", async () => {
    const err = await trees.landStory("password-reset", storyTree).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(storyTree);
    expect(message).toContain("story/password-reset");
    expect(message).toContain(repo);
  });

  it("leaves the base without the story's commit", async () => {
    const before = run(repo, "rev-parse", "main");
    // The reported defect is not just a missing merge: git said "Already up to date" and
    // land returned a sha, so the operator was told it landed. It must throw instead.
    await expect(trees.landStory("password-reset", storyTree)).rejects.toThrow();
    expect(run(repo, "rev-parse", "main")).toBe(before);
    expect(run(repo, "log", "--oneline", "main")).not.toContain("delivered");
  });

  it("does not silently retarget the merge into the base checkout", async () => {
    await expect(trees.landStory("password-reset", storyTree)).rejects.toThrow();
    // The story tree's own HEAD is untouched too: nothing was merged anywhere.
    expect(run(storyTree, "rev-parse", "HEAD")).toBe(run(repo, "rev-parse", "story/password-reset"));
    expect(run(repo, "status", "--porcelain")).toBe("");
  });

  it("lands when run in the checkout that holds the base", async () => {
    const sha = await trees.landStory("password-reset", repo);
    expect(run(repo, "rev-parse", "main")).toBe(sha);
    expect(run(repo, "log", "--oneline", "main")).toContain("delivered");
  });

  it("refuses from a subdirectory of the story's worktree", async () => {
    mkdirSync(join(storyTree, "packages", "core"), { recursive: true });
    const before = run(repo, "rev-parse", "main");
    const err = await trees
      .landStory("password-reset", join(storyTree, "packages", "core"))
      .catch((e: Error) => e);
    expect((err as Error).message).toContain(storyTree);
    expect((err as Error).message).toContain(repo);
    expect(run(repo, "rev-parse", "main")).toBe(before);
  });

  it("refuses from a detached tree at the story tip, the shape an attempt is cut into", async () => {
    const detached = await trees.cut("story/password-reset", tmp("wecode-land-detached-"));
    const before = run(repo, "rev-parse", "main");
    const err = await trees.landStory("password-reset", detached).catch((e: Error) => e);
    expect((err as Error).message).toContain(detached);
    expect((err as Error).message).toContain(repo);
    expect(run(repo, "rev-parse", "main")).toBe(before);
    expect(run(detached, "rev-parse", "HEAD")).toBe(run(repo, "rev-parse", "story/password-reset"));
  });

  it("refuses when no checkout holds the base at all", async () => {
    run(repo, "checkout", "-q", "-b", "parked");
    const before = run(repo, "rev-parse", "main");
    const err = await trees.landStory("password-reset", storyTree).catch((e: Error) => e);
    expect((err as Error).message).toContain("main");
    expect((err as Error).message).toContain(storyTree);
    expect(run(repo, "rev-parse", "main")).toBe(before);
  });

  it("names the branch a third tree holds instead of the base", async () => {
    const other = tmp("wecode-land-other-");
    run(repo, "worktree", "add", "-q", "-b", "side", other, "main");
    const err = await trees.landStory("password-reset", other).catch((e: Error) => e);
    expect((err as Error).message).toContain(other);
    expect((err as Error).message).toContain("side");
    expect(run(repo, "rev-parse", "main")).toBe(run(repo, "rev-parse", "side"));
  });
});
