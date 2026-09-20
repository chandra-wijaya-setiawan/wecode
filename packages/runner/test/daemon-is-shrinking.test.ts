import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { contains, hasCommit, mergesCleanly, orphanedBy, tipOf } from "../src/tick/refresh.js";

/** The refresh and the behind-ness checks are one module.
 *
 *  They are reads of the git graph and of nothing else — no ledger, no trees, no runner
 *  state — so they were never the daemon's to own, and three callers reached a private
 *  method on the runner for each of them. `tick/refresh.ts` is where they live now, and
 *  each is exercised here against a real repository rather than against the source text:
 *  a move that keeps the names and loses a rule would pass a grep and fail these. */

const src = (module: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${module}`, import.meta.url)), "utf8");

/** The source with its prose taken out. `daemon.ts` still talks about the refresh in
 *  comments, so the assertions about what left it are made against the code. */
const code = (module: string): string =>
  src(module).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

describe("the refresh and behind checks are a module of their own", () => {
  it("exports the five reads, and the runner holds no second copy of any of them", () => {
    const moved = code("tick/refresh.ts");
    const exported = [...moved.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    expect(exported).toEqual(["hasCommit", "contains", "tipOf", "mergesCleanly", "conflictedPaths", "orphanedBy"]);
    // `droppedTips` is `orphanedBy`'s alone, so it came with it and stayed private.
    expect(moved).toMatch(/^async function droppedTips\(/m);

    // Each one shells out in exactly one place now: the new module. What is left in the
    // daemon is a one-line delegation, which runs no git of its own.
    const left = code("daemon.ts");
    for (const gone of ["merge-base", "merge-tree", "rev-parse", "reflog", "a refresh adds the base"]) {
      expect(left, `${gone} stayed in daemon.ts`).not.toContain(gone);
    }
    expect(left).toContain(`import * as refresh from "./tick/refresh.js"`);
  });

  /** The reads that are the runner's stay the runner's. `orphanedBy` needs the attempt
   *  commits the ledger recorded, and the walk to them is a walk up the ERD — so they are
   *  handed in as rows rather than the module growing a database of its own. */
  it("takes no ledger with it", () => {
    const moved = code("tick/refresh.ts");
    expect(moved).not.toContain("DatabaseSync");
    expect(moved).not.toContain("queries(");
    expect(moved).not.toContain("tbl.");
    expect(moved).toMatch(/landed: readonly \{ task: number; sha: string \}\[\]/);
  });

  /** A real repository: two commits on `master`, a `feature` branch cut from the first. */
  let repo = "";
  let first = "";
  let second = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "refresh-"));
    git(repo, "init", "-q", "-b", "master");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "one");
    first = git(repo, "rev-parse", "HEAD");
    git(repo, "branch", "feature");
    writeFileSync(join(repo, "b.txt"), "two\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "two");
    second = git(repo, "rev-parse", "HEAD");
  });

  it("says whether a ref is a commit, and what it stands at", async () => {
    expect(await hasCommit(repo, "master")).toBe(true);
    expect(await hasCommit(repo, "nowhere")).toBe(false);
    expect(await tipOf(repo, "refs/heads/master")).toBe(second);
    expect(await tipOf(repo, "refs/heads/nowhere")).toBeNull();
  });

  it("reads the merge off the graph rather than off a report", async () => {
    // `feature` is behind master: master's tip is not in it, but its own base is.
    expect(await contains(repo, "feature", first)).toBe(true);
    expect(await contains(repo, "feature", second)).toBe(false);
    expect(await contains(repo, "master", second)).toBe(true);
  });

  /** A ref that is not there is not a conflict. Read off merge-tree's exit code alone a
   *  story that never had a branch owes a merge chore no merge could ever discharge, which
   *  is the rule the missing-ref guard carries. */
  it("calls a merge clean when it is, and when one side is not there at all", async () => {
    expect(await mergesCleanly(repo, "master", "feature")).toBe(true);
    expect(await mergesCleanly(repo, "master", "story/never-cut")).toBe(true);

    // Both sides add `c.txt` with different contents, which merge-tree cannot settle.
    git(repo, "checkout", "-q", "feature");
    writeFileSync(join(repo, "c.txt"), "theirs\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "theirs");
    git(repo, "checkout", "-q", "master");
    writeFileSync(join(repo, "c.txt"), "ours\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ours");

    expect(await mergesCleanly(repo, "master", "feature")).toBe(false);
  });

  /** The whole point of the orphan read: `git reset --hard base` passes "is the base an
   *  ancestor" while doing the opposite of the work. */
  it("names the merged work a reset threw away", async () => {
    const tree = mkdtempSync(join(tmpdir(), "orphan-"));
    git(tree, "init", "-q", "-b", "story/x");
    git(tree, "config", "user.email", "t@t");
    git(tree, "config", "user.name", "t");
    writeFileSync(join(tree, "base.txt"), "base\n");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "base");
    const base = git(tree, "rev-parse", "HEAD");
    writeFileSync(join(tree, "work.txt"), "work\n");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "the task's work");
    const work = git(tree, "rev-parse", "HEAD");

    const landed = [{ task: 7, sha: work }];
    expect(await orphanedBy(tree, "story/x", landed)).toBeNull();

    git(tree, "reset", "-q", "--hard", base);
    const why = await orphanedBy(tree, "story/x", landed);
    expect(why).toContain(`task 7 at ${work.slice(0, 12)}`);
    expect(why).toContain("a refresh adds the base, it does not replace the branch");
  });

  /** Nothing the ledger knows of was lost, but the branch's own reflog remembers a tip it
   *  can no longer reach — a worker's commit, a settled conflict, a refresh's merge. */
  it("names a former tip the ledger never recorded", async () => {
    const tree = mkdtempSync(join(tmpdir(), "reflog-"));
    git(tree, "init", "-q", "-b", "story/y");
    git(tree, "config", "user.email", "t@t");
    git(tree, "config", "user.name", "t");
    writeFileSync(join(tree, "base.txt"), "base\n");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "base");
    const base = git(tree, "rev-parse", "HEAD");
    writeFileSync(join(tree, "by-hand.txt"), "by hand\n");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "a commit nothing recorded");
    const dropped = git(tree, "rev-parse", "HEAD");
    git(tree, "reset", "-q", "--hard", base);

    const why = await orphanedBy(tree, "story/y", []);
    expect(why).toContain("it no longer reaches a commit it already held");
    expect(why).toContain(dropped.slice(0, 12));
  });
});
