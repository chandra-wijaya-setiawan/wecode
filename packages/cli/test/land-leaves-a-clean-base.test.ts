import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";
// Imported by path: the rules belong to core but nothing exports them from the barrel.
import { refuseDirtyBase, reportAbort, reportLeftover } from "../../core/src/land.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

/** A base checkout on master with a story branch that touches the same file, so the two
 *  conflict on demand. The wecode database is kept outside the repository: `git add -A`
 *  would otherwise sweep it into a commit, and a later checkout would swap the file out
 *  from under the open handle. */
function fixture(): { repo: string; db: string } {
  const root = tmp("land-clean-");
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

/** The story branch, off master, changing `a.txt` to `text`. */
const storyBranch = (repo: string, branch: string, text: string): void => {
  git(repo, "checkout", "-q", "-b", branch);
  writeFileSync(join(repo, "a.txt"), text);
  git(repo, "commit", "-qam", `on ${branch}`);
  git(repo, "checkout", "-q", "master");
};

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
  // Nothing settles a parent but a settled child, so the story reaches `delivered` only by
  // its acceptance test passing — and a pass is only allowed once the test has been red.
  recordRed(open(process.env["WECODE_DB"] as string), 1);
  expect(run(["acceptance_test", "pass", "1"])).toBe(0);
  expect(out.join("")).toContain("story #1  in_progress → delivered");
  out.length = 0;
}

const porcelain = (repo: string): string => git(repo, "status", "--porcelain");

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

describe("landing a story onto the base", () => {
  it("refuses a dirty base out loud, naming the branch and the changes", () => {
    const { repo, db } = fixture();
    process.env["WECODE_DB"] = db;
    storyBranch(repo, "story/pay-up", "story\n");
    process.chdir(repo);
    deliveredStory();
    writeFileSync(join(repo, "a.txt"), "half-finished thought\n");

    expect(run(["land", "1"])).toBe(1);
    const said = err.join("");
    expect(said).toContain("master has uncommitted changes");
    expect(said).toContain("the landing merge would commit them as part of the story");
    expect(said).toContain("M a.txt");
    expect(said).toContain("commit or stash them first");
    // Refused means untouched: the edit is still there and master has not moved.
    expect(porcelain(repo)).toContain("M a.txt");
    expect(git(repo, "log", "--oneline")).not.toContain("land story/pay-up");
  });

  it("refuses a base that is already mid-merge rather than committing somebody else's merge", () => {
    const { repo, db } = fixture();
    process.env["WECODE_DB"] = db;
    storyBranch(repo, "story/pay-up", "story\n");
    storyBranch(repo, "other", "other\n");
    writeFileSync(join(repo, "a.txt"), "master moved\n");
    git(repo, "commit", "-qam", "master moves");
    process.chdir(repo);
    deliveredStory();
    // Leave a conflicted merge of `other` sitting in the tree, the way an interrupted
    // operator does: `git status --porcelain -uno` and MERGE_HEAD both see it.
    expect(() => git(repo, "merge", "other")).toThrow();

    expect(run(["land", "1"])).toBe(1);
    const said = err.join("");
    expect(said).toContain("a merge is already in progress on master");
    expect(said).toContain("git merge --abort");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  });

  it("leaves the base clean when the merge lands", () => {
    const { repo, db } = fixture();
    process.env["WECODE_DB"] = db;
    git(repo, "checkout", "-q", "-b", "story/pay-up");
    writeFileSync(join(repo, "b.txt"), "new\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-qm", "on the story");
    git(repo, "checkout", "-q", "master");
    process.chdir(repo);
    deliveredStory();

    expect(run(["land", "1"])).toBe(0);
    expect(out.join("")).toContain("story/pay-up landed on master");
    expect(porcelain(repo)).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(repo, "log", "--oneline")).toContain("land story/pay-up");
  });

  it("leaves the base clean when the merge conflicts, and says the tree is as it was", () => {
    const { repo, db } = fixture();
    process.env["WECODE_DB"] = db;
    storyBranch(repo, "story/pay-up", "story\n");
    writeFileSync(join(repo, "a.txt"), "master moved\n");
    git(repo, "commit", "-qam", "master moves");
    process.chdir(repo);
    deliveredStory();

    expect(run(["land", "1"])).toBe(1);
    const said = err.join("");
    expect(said).toContain("story/pay-up conflicts with your branch in:");
    expect(said).toContain("the merge was aborted, so your tree is as you left it");
    expect(porcelain(repo)).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });
});

describe("the rules the command speaks through", () => {
  const clean = { here: "/w/base", base: "master", dirty: [] as string[], merging: false };

  it("lets a clean base through", () => {
    expect(refuseDirtyBase(clean)).toBeNull();
    expect(reportLeftover(clean)).toBeNull();
  });

  it("names the tree, the branch and every changed file", () => {
    const why = refuseDirtyBase({ ...clean, dirty: [" M a.txt", "?? no", "A  b.txt"] });
    expect(why).toContain("land refused in /w/base: master has uncommitted changes");
    expect(why).toContain("   M a.txt");
    expect(why).toContain("  A  b.txt");
  });

  it("puts the half-finished merge before the changes it left behind", () => {
    // Mid-merge is the worse of the two and the one with a different remedy, so it is what
    // the operator is told, even though the tree is dirty as well.
    const why = refuseDirtyBase({ ...clean, dirty: ["UU a.txt"], merging: true });
    expect(why).toContain("a merge is already in progress on master");
    expect(why).not.toContain("uncommitted changes");
  });

  it("does not claim the tree is as it was when the abort left the merge standing", () => {
    const why = reportAbort({ ...clean, dirty: ["UU a.txt"], merging: true }, "story/pay-up");
    expect(why).toContain("the merge was NOT undone");
    expect(why).toContain("master in /w/base is still mid-merge");
    expect(why).toContain("  UU a.txt");
    expect(why).toContain("do not commit there");
    expect(why).not.toContain("as you left it");
  });

  it("reports changes the merge left behind even when no merge is standing", () => {
    const left = reportLeftover({ ...clean, dirty: [" M a.txt"] });
    expect(left).toContain("master in /w/base was left with uncommitted changes");
    expect(left).toContain("   M a.txt");
  });

  it("says so even when a standing merge has staged everything and shows nothing dirty", () => {
    const left = reportLeftover({ ...clean, merging: true });
    expect(left).toContain("still mid-merge");
    expect(left).toContain("(no tracked file differs)");
  });
});
