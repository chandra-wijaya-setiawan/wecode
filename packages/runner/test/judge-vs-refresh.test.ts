import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Field report, 15 Sep. Chore 4, kind `refresh`, target story 165, was running when
 *  acceptance_test 166 was judged at 21:14 and failed on the stale-tree loadViews error.
 *  The chore then finished, the branch gained the base, and the same test passed at 21:17
 *  with nothing else changed. The red verdict was a race against a repair the tick had
 *  asked for itself, and it cost the next attempt its budget. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;
/** Every directory an acceptance test ran in, one per line. */
let ran: string;

beforeEach(() => {
  repo = tmp("wecode-judge-refresh-");
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

/** How many times the acceptance test's script has run. The base probe runs in the story
 *  tree too, so one run is the probe alone and two is the probe and a judgement. */
const runs = (): number => readFileSync(ran, "utf8").trim().split("\n").filter(Boolean).length;

/** An in-progress story with one script acceptance test and one done task under it, so the
 *  examiner would run the test if the tick let it. */
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

/** Cut the story branch at main and commit `line` to `file` on it. */
function branchWith(slug: string, file: string, line: string): void {
  git(repo, "branch", `story/${slug}`, "main");
  const tree = join(repo, `.cut-${slug}`);
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, file), line);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", `work on ${slug}`);
  git(repo, "worktree", "remove", "--force", tree);
}

function baseGains(file: string, line: string): void {
  writeFileSync(join(repo, file), line);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `base gains ${file}`);
}

/** The story 165 shape: a branch that conflicts with the base, so the tick cannot refresh
 *  the tree itself and raises the chore instead. */
function conflicted(title: string): { id: number; slug: string; test: number } {
  const s = story(title, `pwd >> ${ran}; test -f mine.ts`);
  branchWith(s.slug, "mine.ts", "mine\n");
  const cut = join(repo, ".cut-again");
  git(repo, "worktree", "add", "-q", cut, `story/${s.slug}`);
  writeFileSync(join(cut, "README.md"), "the story's idea\n");
  git(cut, "add", "-A");
  git(cut, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "ours");
  git(repo, "worktree", "remove", "--force", cut);
  baseGains("README.md", "the base's idea\n");
  return s;
}

const setChoreState = (id: number, state: string): void => {
  db.prepare("UPDATE chore SET state = ? WHERE id = ?").run(state, id);
};

describe("a story with an open refresh chore is not judged", () => {
  it("skips it while the chore is running, and says why rather than going red", async () => {
    const s = conflicted("the services box");
    // Tick one raises the chore. A worker then takes it: the repair is under way.
    await runner().tick();
    const chore = choreFor(db, "refresh", "story", s.id);
    expect(chore).not.toBeNull();
    setChoreState(chore?.id ?? 0, "running");
    const before = runs();

    const tick = await runner().tick();

    // No verdict either way — this is the 21:14 failure that never happens now.
    expect(tick.scripts.failed).not.toContain(s.test);
    expect(tick.scripts.passed).not.toContain(s.test);
    expect(stateOf(s.test)).toBe("ready");
    // and the tree was not entered at all, not even for the base probe's sibling run
    expect(runs()).toBe(before);
    // The skip carries a reason, naming the chore the operator should look at.
    expect(tick.waiting).toEqual([{ story: s.id, why: expect.stringContaining("waiting on its refresh") }]);
    expect(tick.waiting[0]?.why).toContain(`#${chore?.id}`);
    expect(tick.waiting[0]?.why).toContain("running");
    // The chore is still owed: skipping the story must not read as "the world moved".
    expect(choreFor(db, "refresh", "story", s.id)?.state).toBe("running");
    expect(tick.chores).toContain(chore?.id);
  });

  it("skips it while the chore is only planned or ready, too", async () => {
    const s = conflicted("not started yet");
    await runner().tick();
    const chore = choreFor(db, "refresh", "story", s.id);
    expect(chore?.state).toBe("planned");

    for (const state of ["planned", "ready"]) {
      setChoreState(chore?.id ?? 0, state);
      const tick = await runner().tick();
      expect(tick.waiting.map((w) => w.story)).toEqual([s.id]);
      expect(tick.waiting[0]?.why).toContain(state);
      // and `behind` keeps saying what it always said: nothing under this story was judged
      expect(tick.behind).toEqual([{ story: s.id, why: tick.waiting[0]?.why }]);
      expect(stateOf(s.test)).toBe("ready");
      expect(choreFor(db, "refresh", "story", s.id)?.state).toBe(state);
    }
  });
});

describe("the story is judged once the chore settles", () => {
  it("proves the test in the repaired tree, and says nothing about waiting", async () => {
    const s = conflicted("repaired at 21:17");
    await runner().tick();
    const chore = choreFor(db, "refresh", "story", s.id);
    setChoreState(chore?.id ?? 0, "running");
    expect((await runner().tick()).waiting.map((w) => w.story)).toEqual([s.id]);

    // The repair lands, exactly as it did on 15 Sep: the branch gains the base, and the
    // chore is discharged.
    // In the story tree itself, which is where the chore's worker would have been.
    const tree = join(repo, ".wecode/worktrees", `story-${s.slug}`);
    git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "merge", "-q", "-m", "refresh", "-X", "ours", "main");
    setChoreState(chore?.id ?? 0, "done");

    const tick = await runner().tick();

    expect(tick.waiting).toEqual([]);
    expect(tick.behind).toEqual([]);
    expect(tick.scripts.passed).toContain(s.test);
    expect(stateOf(s.test)).toBe("passed");
  });

  it("judges a story with no open refresh exactly as before", async () => {
    // The other direction, kept: the tick refreshes the tree itself and the verdict stands.
    const s = story("the clean one", `pwd >> ${ran}; test -f mine.ts && test -f services.ts`);
    branchWith(s.slug, "mine.ts", "mine\n");
    baseGains("services.ts", "the box\n");

    const tick = await runner().tick();

    expect(tick.waiting).toEqual([]);
    expect(tick.scripts.passed).toContain(s.test);
    expect(stateOf(s.test)).toBe("passed");
    expect(choreFor(db, "refresh", "story", s.id)).toBeNull();
  });
});
