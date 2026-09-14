import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
    await trees.landStory("password-reset", storyTree).catch(() => undefined);
    expect(run(repo, "rev-parse", "main")).toBe(before);
    expect(run(repo, "log", "--oneline", "main")).not.toContain("delivered");
  });

  it("does not silently retarget the merge into the base checkout", async () => {
    await trees.landStory("password-reset", storyTree).catch(() => undefined);
    // The story tree's own HEAD is untouched too: nothing was merged anywhere.
    expect(run(storyTree, "rev-parse", "HEAD")).toBe(run(repo, "rev-parse", "story/password-reset"));
    expect(run(repo, "status", "--porcelain")).toBe("");
  });

  it("lands when run in the checkout that holds the base", async () => {
    const sha = await trees.landStory("password-reset", repo);
    expect(run(repo, "rev-parse", "main")).toBe(sha);
    expect(run(repo, "log", "--oneline", "main")).toContain("delivered");
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
