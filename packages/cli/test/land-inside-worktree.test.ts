import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// Imported by path: the rule belongs to core but nothing exports it from the barrel yet,
// and this suite is the only caller that exists.
import { type Checkout, refuseLand } from "../../core/src/land.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** What `wecode land` can see of the repository, read the way the command reads it. */
const checkouts = (cwd: string): Checkout[] =>
  git(cwd, "worktree", "list", "--porcelain")
    .split("\n\n")
    .flatMap((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      return path === undefined
        ? []
        : [{ path: realpathSync(path), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null }];
    });

const toplevel = (cwd: string): string => realpathSync(git(cwd, "rev-parse", "--show-toplevel"));

describe("land refuses to merge in the wrong tree", () => {
  // One repository, a base checkout on master, a story worktree on story/a-guard, and a
  // detached tree of the kind an agent attempt runs in.
  let base = "";
  let storyTree = "";
  let attemptTree = "";
  let trees: Checkout[] = [];

  beforeAll(() => {
    // A fresh parent per run: the worktrees are siblings of the base checkout, and a fixed
    // name in /tmp is one left-behind tree away from a suite that only passes once.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "land-")));
    base = join(root, "base");
    execFileSync("mkdir", [base]);
    git(base, "init", "-q", "-b", "master", ".");
    writeFileSync(join(base, "a.txt"), "a\n");
    git(base, "add", "a.txt");
    git(base, "commit", "-qm", "first");
    git(base, "branch", "story/a-guard");
    storyTree = join(root, "story");
    attemptTree = join(root, "attempt");
    git(base, "worktree", "add", "-q", storyTree, "story/a-guard");
    git(base, "worktree", "add", "-q", "--detach", attemptTree, "master");
    trees = checkouts(base);
  });

  const place = (here: string) => ({ here, branch: "story/a-guard", base: "master", trees });

  it("refuses in the story worktree and says it would merge the branch into itself", () => {
    const why = refuseLand(place(toplevel(storyTree)));
    expect(why).toContain(`land story/a-guard refused in ${realpathSync(storyTree)}`);
    expect(why).toContain("it is the story/a-guard worktree");
    expect(why).toContain("merging story/a-guard there merges it into itself");
  });

  it("says where to run it: the checkout that holds the base branch", () => {
    expect(refuseLand(place(toplevel(storyTree)))).toContain(
      `Run it in ${base}, the checkout that holds master.`,
    );
  });

  it("refuses in a detached attempt tree without naming a branch it does not hold", () => {
    const why = refuseLand(place(toplevel(attemptTree)));
    expect(why).toContain("it is not the tree that holds the base branch");
    expect(why).toContain(`Run it in ${base}`);
  });

  it("allows the merge in the checkout that holds the base branch", () => {
    expect(refuseLand(place(toplevel(base)))).toBeNull();
  });

  it("names the branch a third tree holds, so the operator knows which tree they are in", () => {
    const other = [...trees, { path: "/w/other", branch: "story/b-guard" }];
    expect(refuseLand({ ...place("/w/other"), trees: other })).toContain(
      "it holds story/b-guard, not master",
    );
  });

  it("refuses rather than picks a tree when no checkout holds the base branch", () => {
    const why = refuseLand({
      here: realpathSync(storyTree),
      branch: "story/a-guard",
      base: "master",
      trees: trees.filter((c) => c.branch !== "master"),
    });
    expect(why).toContain("no checkout has master checked out");
    expect(why).toContain("there is no tree the merge into master could happen in");
  });

  it("does not depend on the cwd being the repository root of the tree", () => {
    // `wecode land` is run from wherever the operator stands; the toplevel is what decides.
    const nested = join(storyTree, "sub");
    execFileSync("mkdir", ["-p", nested]);
    expect(refuseLand(place(toplevel(nested)))).toContain("merges it into itself");
  });
});
