import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";
// Imported by path: the rule belongs to core but nothing exports it from the barrel.
import { reportLeftover, stagedLeftover } from "../../core/src/land.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

/** A base checkout on master, with the wecode database kept outside the repository so
 *  `git add -A` cannot sweep it into a commit. */
function fixture(): { repo: string; db: string } {
  const root = tmp("land-staged-");
  const repo = join(root, "repo");
  const dbDir = join(root, "db");
  mkdirSync(repo);
  mkdirSync(dbDir);
  git(repo, "init", "-q", "-b", "master", ".");
  git(repo, "config", "user.name", "Tess");
  git(repo, "config", "user.email", "tess@example.com");
  writeFileSync(join(repo, "a.txt"), "base\n");
  // The acceptance test's artefact has to resolve, so the script it names is a real file.
  writeFileSync(join(repo, "x.sh"), "exit 0\n");
  git(repo, "add", "a.txt", "x.sh");
  git(repo, "commit", "-qm", "first");
  return { repo, db: join(dbDir, "wecode.db") };
}

/** Story #1, delivered, slug `pay-up` — the only state `land` will look at. */
function deliveredStory(): void {
  expect(run(["init"])).toBe(0);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "billing"]);
  run(["story", "create", "--parent", "1", "pay up"]);
  run(["requirement", "create", "--parent", "1", "one change per link"]);
  run(["acceptance_criteria", "create", "--parent", "1", "the bill is paid"]);
  run(["acceptance_test", "create", "--parent", "1", "it is paid", "--artefact", "bash x.sh"]);
  for (const e of ["project", "release", "epic", "story", "requirement", "acceptance_criteria"]) {
    expect(run([e, "start", "1"])).toBe(0);
  }
  run(["acceptance_test", "deliver", "1"]);
  recordRed(open(process.env["WECODE_DB"] as string), 1);
  expect(run(["acceptance_test", "pass", "1"])).toBe(0);
  out.length = 0;
}

/** The story branch, off master, adding `b.txt`. */
function storyBranch(repo: string): void {
  git(repo, "checkout", "-q", "-b", "story/pay-up");
  writeFileSync(join(repo, "b.txt"), "new\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-qm", "on the story");
  git(repo, "checkout", "-q", "master");
}

/** A `post-merge` hook that writes a file and stages it — the real way a base ends up with
 *  a staged diff after a landing merge that itself succeeded. */
function stagingHook(repo: string): void {
  const hook = join(repo, ".git", "hooks", "post-merge");
  writeFileSync(hook, "#!/bin/sh\nprintf generated > generated.txt\ngit add generated.txt\n");
  chmodSync(hook, 0o755);
}

let out: string[];
let err: string[];
let cwd = "";

beforeEach(() => {
  cwd = process.cwd();
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
});

describe("a land leaves no diff staged", () => {
  it("says the leftover is staged, and gives the command that unstages it", () => {
    const { repo, db } = fixture();
    process.env["WECODE_DB"] = db;
    storyBranch(repo);
    process.chdir(repo);
    deliveredStory();
    stagingHook(repo);

    // The merge itself succeeded, so the landing is recorded — but the command does not
    // report success while the base is holding something the next commit would carry.
    expect(run(["land", "1"])).toBe(1);
    expect(out.join("")).toContain("story/pay-up landed on master");
    const said = err.join("");
    expect(said).toContain("the base was not left clean");
    expect(said).toContain("was left with a staged diff, already in the index");
    expect(said).toContain("A  generated.txt");
    expect(said).toContain("the next commit made in that tree carries it");
    expect(said).toContain("git restore --staged .");
    // It is the staged-diff remedy, not the mid-merge one: no merge is standing.
    expect(said).not.toContain("git merge --abort");
    // And the index really is holding it — the report is about the tree as it is.
    expect(git(repo, "status", "--porcelain")).toContain("A  generated.txt");
  });

  it("stays silent when the land leaves the index clean", () => {
    const { repo, db } = fixture();
    process.env["WECODE_DB"] = db;
    storyBranch(repo);
    process.chdir(repo);
    deliveredStory();

    expect(run(["land", "1"])).toBe(0);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(err.join("")).not.toContain("staged");
  });
});

describe("the rule the command speaks through", () => {
  const clean = { here: "/w/base", base: "master", dirty: [] as string[], merging: false };

  it("counts an index column that is neither a space nor a question mark", () => {
    expect(stagedLeftover(["A  b.txt", " M a.txt", "?? c.txt", "MM d.txt", ""])).toEqual([
      "A  b.txt",
      "MM d.txt",
    ]);
  });

  it("keeps calling an unstaged leftover what it was called before", () => {
    const left = reportLeftover({ ...clean, dirty: [" M a.txt"] });
    expect(left).toContain("was left with uncommitted changes");
    expect(left).toContain("git merge --abort");
    expect(left).not.toContain("staged");
  });

  it("names every staged path and speaks of them in the plural", () => {
    const left = reportLeftover({ ...clean, dirty: ["A  b.txt", "M  a.txt", " M c.txt"] });
    expect(left).toContain("master in /w/base was left with a staged diff");
    expect(left).toContain("  A  b.txt");
    expect(left).toContain("  M  a.txt");
    expect(left).toContain("   M c.txt");
    expect(left).toContain("carries them, whoever makes it");
    expect(left).toContain("unstage them");
  });

  it("puts a standing merge first, because its remedy is the other one", () => {
    // `UU` is an index column too, but a tree mid-merge is not unstaged by a restore.
    const left = reportLeftover({ ...clean, dirty: ["UU a.txt"], merging: true });
    expect(left).toContain("still mid-merge");
    expect(left).toContain("git merge --abort");
    expect(left).not.toContain("staged diff");
  });

  it("still reports nothing for a clean base", () => {
    expect(reportLeftover(clean)).toBeNull();
  });
});
