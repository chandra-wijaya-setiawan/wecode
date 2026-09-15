import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Field report, 15 Sep. acceptance_test 166 for story 165 failed in loadViews because the
 *  story branch was cut before the services box landed with story 152: the tree was missing
 *  the world, not wrong about it. Re-proving could never have helped, and raiseMergeChores
 *  looked only at `delivered` stories, so the in-progress one got no chore either. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;
/** Every directory an acceptance test ran in, one per line. */
let ran: string;

beforeEach(() => {
  repo = tmp("wecode-stale-tree-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  ran = join(tmp("wecode-ran-"), "where");
  writeFileSync(ran, "");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  const project = make.project(ws, "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

const runner = (): Runner =>
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: {}, integrationBranch: "main" });

const slugOf = (story: number): string =>
  (db.prepare("SELECT slug FROM story WHERE id = ?").get(story) as { slug: string }).slug;

const stateOf = (test: number): string =>
  (db.prepare("SELECT state FROM acceptance_test WHERE id = ?").get(test) as { state: string }).state;

const storyTree = (slug: string): string => join(repo, ".wecode/worktrees", `story-${slug}`);

/** How many times the acceptance test's script has run. The story tree is also where the
 *  base probe runs — detached at the merge-base — so the directory does not tell the two
 *  apart and the count does: one run is the probe alone, two is the probe and a judgement. */
const runs = (): number => readFileSync(ran, "utf8").trim().split("\n").filter(Boolean).length;

/** An in-progress story with one criterion, one script acceptance test, and one task under
 *  it already done — so the examiner will run the test, and the story counts as one with
 *  work under it. The states are written straight onto the record: how a story reaches
 *  them is the cascade's business and every other test's. */
function story(title: string, artefact: string): { id: number; slug: string; test: number } {
  const id = make.story(epic, title);
  const req = make.requirement(id, "it behaves");
  const c = make.criteria(req, "proven by a script");
  const test = make.acceptanceTest(c, "the suite is green", "script", artefact);
  const task = make.task(test, "do the work", { role: "engineer", scope: { write: ["mine.ts"], tools: [] } });

  db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(id);
  db.prepare("UPDATE requirement SET state = 'in_progress' WHERE id = ?").run(req);
  db.prepare("UPDATE acceptance_criteria SET state = 'in_progress' WHERE id = ?").run(c);
  db.prepare("UPDATE acceptance_test SET state = 'ready' WHERE id = ?").run(test);
  db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(task);
  return { id, slug: slugOf(id), test };
}

/** Cut the story branch where main is now, commit `line` to `file` on it, and leave main
 *  free to move on afterwards. */
function branchWith(slug: string, file: string, line: string): void {
  git(repo, "branch", `story/${slug}`, "main");
  const tree = join(repo, `.cut-${slug}`);
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, file), line);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", `work on ${slug}`);
  git(repo, "worktree", "remove", "--force", tree);
}

/** Move the base on, the way story 152 moved it under story 165. */
function baseGains(file: string, line: string): void {
  writeFileSync(join(repo, file), line);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `base gains ${file}`);
}

const contains = (branch: string, base: string): boolean => {
  try {
    git(repo, "merge-base", "--is-ancestor", base, branch);
    return true;
  } catch {
    return false;
  }
};

describe("a story tree behind the base is brought up to it before anything is judged", () => {
  it("merges the base in, then runs the acceptance test in a tree that has the world", async () => {
    // The test needs both halves: its own story's work, and what the base gained after the
    // branch was cut. In the stale tree it can only fail, and the failure says nothing.
    const s = story("the services box", `pwd >> ${ran}; test -f mine.ts && test -f services.ts`);
    branchWith(s.slug, "mine.ts", "mine\n");
    baseGains("services.ts", "the box\n");
    expect(contains(`story/${s.slug}`, "main")).toBe(false);

    const tick = await runner().tick();

    // The refresh happened, and it is the thing docs/design/18 names as the check.
    expect(contains(`story/${s.slug}`, "main")).toBe(true);
    expect(tick.behind).toEqual([]);
    // and because it happened first, the verdict is the true one
    expect(tick.scripts.passed).toContain(s.test);
    expect(stateOf(s.test)).toBe("passed");
    // Run twice: once at the base, to prove it can fail, and once in the refreshed tree.
    expect(runs()).toBe(2);
    // Nothing is owed: a tree that took the base is not a tree to raise a chore about.
    expect(choreFor(db, "refresh", "story", s.id)).toBeNull();
  });
});

describe("a tree that cannot be refreshed is not judged", () => {
  it("leaves the test where it stands and says the tree is behind", async () => {
    // Both sides edit README.md, so the base will not merge into the branch.
    const s = story("the conflicted one", `pwd >> ${ran}; test -f mine.ts`);
    branchWith(s.slug, "mine.ts", "mine\n");
    git(repo, "worktree", "add", "-q", join(repo, ".cut-again"), `story/${s.slug}`);
    writeFileSync(join(repo, ".cut-again", "README.md"), "the story's idea\n");
    git(join(repo, ".cut-again"), "add", "-A");
    git(join(repo, ".cut-again"), "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "ours");
    git(repo, "worktree", "remove", "--force", join(repo, ".cut-again"));
    baseGains("README.md", "the base's idea\n");

    const tick = await runner().tick();

    expect(tick.behind).toEqual([{ story: s.id, why: expect.stringContaining(`story/${s.slug}`) }]);
    expect(tick.behind[0]?.why).toContain("main");
    // Not judged: no verdict either way, and the test is exactly where it was.
    expect(tick.scripts.passed).not.toContain(s.test);
    expect(tick.scripts.failed).not.toContain(s.test);
    expect(stateOf(s.test)).toBe("ready");
    // Once only: the base probe. The story tree was never judged in.
    expect(runs()).toBe(1);
    // and the half-merge is not left standing in the tree for the next tick to trip on
    expect(git(storyTree(s.slug), "status", "--porcelain")).toBe("");
    expect(contains(`story/${s.slug}`, "main")).toBe(false);

    // A second tick reaches the same answer rather than drifting into a verdict.
    const again = await runner().tick();
    expect(again.behind.map((b) => b.story)).toEqual([s.id]);
    expect(stateOf(s.test)).toBe("ready");
  });
});

describe("an in-progress story gets the chore too", () => {
  it("raises refresh for a story that is nowhere near delivered", async () => {
    const s = story("still in flight", `pwd >> ${ran}; test -f mine.ts`);
    branchWith(s.slug, "mine.ts", "mine\n");
    git(repo, "worktree", "add", "-q", join(repo, ".cut-again"), `story/${s.slug}`);
    writeFileSync(join(repo, ".cut-again", "README.md"), "the story's idea\n");
    git(join(repo, ".cut-again"), "add", "-A");
    git(join(repo, ".cut-again"), "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "ours");
    git(repo, "worktree", "remove", "--force", join(repo, ".cut-again"));
    baseGains("README.md", "the base's idea\n");

    expect(
      (db.prepare("SELECT state FROM story WHERE id = ?").get(s.id) as { state: string }).state,
    ).toBe("in_progress");

    const tick = await runner().tick();

    const refresh = choreFor(db, "refresh", "story", s.id);
    expect(refresh).not.toBeNull();
    expect(refresh?.check).toBe("the base is an ancestor of the branch");
    expect(refresh?.state).toBe("planned");
    expect(tick.chores).toContain(refresh?.id);

    // And only refresh. `merge` is still a delivered story's: a branch in flight is
    // expected to diverge from the base, and nobody owes that merge yet.
    expect(choreFor(db, "merge", "story", s.id)).toBeNull();

    // Raised once, not once a tick.
    const second = await runner().tick();
    expect(choreFor(db, "refresh", "story", s.id)?.id).toBe(refresh?.id);
    expect(second.chores).toContain(refresh?.id);
    expect(
      (db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n,
    ).toBe(1);
  });
});
