import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { GitError, Trees } from "../src/index.js";
import { settleEnded } from "../src/tick/settle.js";
import type { ScriptReport, Settled } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A tree is cut detached, so committing an attempt is two steps: the commit, then moving
 *  the task branch onto it. The second step can fail on its own — a hook, a permission, a
 *  ref that moved underneath — and then the commit exists with nothing but the tree's HEAD
 *  holding it.
 *
 *  Both halves used to lose it. The error said `git update-ref ...: fatal` and named no
 *  commit, and the pass that settles attempts caught everything into an empty block. So the
 *  tick reported nothing, no sha reached the assignment, and the next attempt's brief read
 *  that null and told a fresh agent "the last attempt left no commit on this branch" over
 *  work that was committed all along. */

let repo: string;
let outside: string;
let db: DatabaseSync;
let make: Maker;
let trees: Trees;
let task: number;
let slug: string;
let worker: number;
let n = 0;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Make one ref refuse to move, and only that one. `reference-transaction` is git's own way
 *  in: the hook sees every proposed update and a non-zero exit aborts the transaction. A
 *  detached worktree's HEAD is a ref of its own, so refusing a branch stops the branch and
 *  leaves the attempt's commit made — which is exactly the case being described. */
const refuse = (ref: string): void => {
  const hook = join(repo, ".git/hooks/reference-transaction");
  writeFileSync(hook, `#!/bin/sh\nwhile read -r old new name; do\n  [ "$name" = "${ref}" ] && exit 1\ndone\nexit 0\n`);
  chmodSync(hook, 0o755);
};

beforeEach(() => {
  repo = tmp("wecode-cannot-commit-");
  outside = tmp("wecode-cannot-commit-outside-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const project = make.project(make.workspace("acme", repo), "storefront", repo);
  const story = make.story(make.epic(make.release(project, "1.0.0"), "recovery"), "password reset");
  const criteria = make.criteria(make.requirement(story, "one change per link"), "emailed in 60s");
  const at = make.acceptanceTest(criteria, "mail arrives", "script", "test -f mail.ts");
  task = make.task(at, "send the mail", { role: "engineer" });
  slug = (db.prepare("SELECT slug FROM task WHERE id = ?").get(task) as { slug: string }).slug;
  // A retry already spent, so a refund would be visible: the rule declines to go below zero.
  db.prepare("UPDATE task SET attempts = 1 WHERE id = ?").run(task);
  worker = make.worker("claude-1", "engineer", "agent");
  trees = new Trees(repo, "main");
});

/** An attempt that has ended with a file in its tree and nothing committed yet — what the
 *  settling pass is handed on the tick after an agent stops. */
const anAttempt = async (): Promise<{ id: number; branch: string; path: string }> => {
  const branch = await trees.taskBranch("s", slug);
  const path = join(outside, `wt-${n++}`);
  await trees.cut(branch, path);
  writeFileSync(join(path, "mail.ts"), "the work\n");
  const id = make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["mail.ts"], tools: [] },
    budget: { tokens: 1000, seconds: 60 },
    worktree: path,
  });
  db.prepare("UPDATE assignment SET phase = 'succeeded' WHERE id = ?").run(id);
  return { id, branch, path };
};

const clean: ScriptReport = { passed: [], failed: [], skipped: [] };

/** The phase, with only what it needs: the walk to the slugs and the examiner are the
 *  daemon's and are handed in, so the subject here is the settling and nothing else. */
const settle = (runTaskTests: () => Promise<ScriptReport> = async () => clean): Promise<Settled> =>
  settleEnded({
    db,
    slugsFor: () => ({ task: slug, story: "s", repo }),
    treesFor: () => trees,
    runTaskTests,
  });

const shaOf = (id: number): string | null =>
  (db.prepare("SELECT commit_sha FROM assignment WHERE id = ?").get(id) as { commit_sha: string | null }).commit_sha;

const attemptsOf = (): number =>
  (db.prepare("SELECT attempts FROM task WHERE id = ?").get(task) as { attempts: number }).attempts;

const failure = async (p: Promise<unknown>): Promise<GitError> => p.catch((err: unknown) => err as GitError);

/** What the runner said for itself, with git's own words cut off the end. Git's failure is
 *  reported as `git update-ref refs/heads/<branch> <sha>: fatal: ...`, so the sha and the
 *  branch are already spelled out there as arguments — asking the whole message whether it
 *  names them is a question that answers itself, and it stayed green when the sentence in
 *  front of it stopped naming either. */
const saidHere = (message: string | undefined): string => (message ?? "").split("git update-ref")[0] ?? "";

describe("a commit the branch will not take", () => {
  it("names the commit it made, and the branch that would not move", async () => {
    const { branch, path } = await anAttempt();
    refuse(`refs/heads/${branch}`);

    const err = await failure(trees.commitAttempt(path, branch, "t: attempt"));

    expect(err).toBeInstanceOf(GitError);
    expect(err.made).toBe(git(path, "rev-parse", "HEAD"));
    // The sentence carries both halves in its own right: which commit exists, and which ref
    // did not move. Read ahead of git's echo of the command, which spells both out anyway.
    expect(saidHere(err.message)).toContain(err.made ?? "no sha");
    expect(saidHere(err.message)).toContain(branch);
  });

  it("leaves the commit standing in the tree and the branch where it was", async () => {
    const { branch, path } = await anAttempt();
    const tip = git(repo, "rev-parse", branch);
    refuse(`refs/heads/${branch}`);

    await expect(trees.commitAttempt(path, branch, "t: attempt")).rejects.toThrow(/would not move/);

    expect(git(repo, "rev-parse", branch)).toBe(tip);
    expect(git(path, "log", "-1", "--format=%s")).toBe("t: attempt");
    expect(git(path, "show", "HEAD:mail.ts")).toBe("the work");
  });

  it("names a commit the attempt made for itself when that is what cannot be carried", async () => {
    const { branch, path } = await anAttempt();
    git(path, "add", "-A");
    git(path, "-c", "user.name=agent", "-c", "user.email=agent@localhost", "commit", "-q", "-m", "its own");
    const own = git(path, "rev-parse", "HEAD");
    refuse(`refs/heads/${branch}`);

    // Nothing is left to stage, so the fast-forward is the whole of the commit here.
    const err = await failure(trees.commitAttempt(path, branch, "t: attempt"));

    expect(err.made).toBe(own);
  });

  it("names no commit when the refusal came before any commit was made", async () => {
    const { branch } = await anAttempt();
    const attached = join(outside, "attached");
    git(repo, "worktree", "add", "-q", attached, "-b", "other");

    const err = await failure(trees.commitAttempt(attached, branch, "t: attempt"));

    // A sha on this one would be a lie: the refusal is why there is nothing to point at.
    expect(err.message).toMatch(/branch other is checked out/);
    expect(err.made).toBeNull();
  });
});

describe("the pass that settles an attempt", () => {
  it("records the sha the attempt made, so no retry is told it left no commit", async () => {
    const { id, branch, path } = await anAttempt();
    refuse(`refs/heads/${branch}`);

    await settle();

    // The commit is reachable from the tree's HEAD alone; the record is what says so.
    expect(shaOf(id)).toBe(git(path, "rev-parse", "HEAD"));
    expect(shaOf(id)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("says what stopped it, in git's own words", async () => {
    const { id, branch, path } = await anAttempt();
    refuse(`refs/heads/${branch}`);

    const settled = await settle();

    // Read off the tree rather than off the record: the saying and the recording are two
    // halves, and a test that asked the record for the sha would prove only one of them.
    expect(settled.stopped.map((s) => s.id)).toEqual([id]);
    expect(saidHere(settled.stopped[0]?.why)).toContain(branch);
    expect(saidHere(settled.stopped[0]?.why)).toContain(git(path, "rev-parse", "HEAD"));
    // And git's own words are carried through rather than replaced by a summary of them.
    expect(settled.stopped[0]?.why).toContain("git update-ref");
  });

  it("leaves the tree standing and claims nothing was committed", async () => {
    const { id, branch, path } = await anAttempt();
    const tip = git(repo, "rev-parse", branch);
    refuse(`refs/heads/${branch}`);

    const settled = await settle();

    expect(settled.committed).toEqual([]);
    // The tree is the only thing holding the commit, so it is not released.
    expect(existsSync(path)).toBe(true);
    expect(git(repo, "rev-parse", branch)).toBe(tip);
  });

  it("refunds no retry for an attempt that did write something", async () => {
    const { branch } = await anAttempt();
    refuse(`refs/heads/${branch}`);

    await settle();

    expect(attemptsOf()).toBe(1);
  });

  it("says so for a failure that is not git's either, and records no sha", async () => {
    const { id, path } = await anAttempt();

    const settled = await settle(() => Promise.reject(new Error("the tree would not build")));

    expect(settled.stopped).toEqual([{ id, why: "the tree would not build" }]);
    expect(shaOf(id)).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  it("settles the attempt nothing stopped exactly as it always did", async () => {
    const { id, branch, path } = await anAttempt();

    const settled = await settle();

    expect(settled.stopped).toEqual([]);
    expect(settled.committed).toEqual([id]);
    expect(shaOf(id)).toBe(git(repo, "rev-parse", branch));
    expect(git(repo, "show", `${branch}:mail.ts`)).toBe("the work");
    expect(existsSync(path)).toBe(false);
  });
});
