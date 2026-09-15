import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** `raiseStoryChores` used to be told which stories were behind by `proveStories`. That pass
 *  only looks at an `in_progress` story with a ready or failed *script* acceptance test, so
 *  every other kind of story — no script test yet, on hold, already delivered — was invisible
 *  to it, and a branch plainly missing the base had nothing raised about it. The condition is
 *  the branch against the base, and this reads it there. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

beforeEach(() => {
  repo = tmp("wecode-refresh-unjudged-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

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

const setStoryState = (id: number, state: string): void => {
  db.prepare("UPDATE story SET state = ? WHERE id = ?").run(state, id);
};

const setChoreState = (id: number, state: string): void => {
  db.prepare("UPDATE chore SET state = ? WHERE id = ?").run(state, id);
};

/** A story the proving pass will never look at: no script acceptance test under it at all.
 *  `state` is written straight on, the way every other runner test does it. */
function unjudgedStory(title: string, state: string): { id: number; slug: string } {
  const id = make.story(epic, title);
  setStoryState(id, state);
  return { id, slug: slugOf(id) };
}

/** Cut `story/<slug>` where main is now and commit `line` to `file` on it. */
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

/** Merge the base into the story branch, as a worker taking the chore would. */
function branchTakesBase(slug: string): void {
  const tree = join(repo, `.take-${slug}`);
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "merge", "-q", "--no-ff", "-m", "refresh", "main");
  git(repo, "worktree", "remove", "--force", tree);
}

describe("staleness is read off the branch, not off the proving pass", () => {
  it("raises refresh for a story the proving pass never looks at", async () => {
    // No acceptance test, so `proveStories` reports nothing about it at all. The branch is
    // still a story behind the base, and that is the whole condition.
    const s = unjudgedStory("no script test under it", "in_progress");
    branchWith(s.slug, "mine.ts", "mine\n");
    baseGains("services.ts", "the box\n");

    const tick = await runner().tick();

    expect(tick.behind).toEqual([]);
    const refresh = choreFor(db, "refresh", "story", s.id);
    expect(refresh).not.toBeNull();
    expect(refresh?.check).toBe("the base is an ancestor of the branch");
    expect(tick.chores).toContain(refresh?.id);
  });

  it("raises nothing for a story nobody is proving in", async () => {
    // `refresh` is about the tree being judged in right now. A story on hold is not one, and
    // a delivered story's branch being behind is `merge`'s business, not this rule's.
    for (const state of ["on_hold", "delivered"]) {
      const s = unjudgedStory(`parked while ${state}`, state);
      branchWith(s.slug, `${state}.ts`, "mine\n");
      baseGains(`base-${state}.ts`, "the box\n");

      await runner().tick();

      expect(choreFor(db, "refresh", "story", s.id)).toBeNull();
    }
  });

  it("closes it when the branch takes the base, with nobody having judged the story", async () => {
    const s = unjudgedStory("repaired by hand", "in_progress");
    branchWith(s.slug, "mine.ts", "mine\n");
    baseGains("services.ts", "the box\n");
    await runner().tick();
    const refresh = choreFor(db, "refresh", "story", s.id);
    expect(refresh).not.toBeNull();

    branchTakesBase(s.slug);
    const tick = await runner().tick();

    expect(choreFor(db, "refresh", "story", s.id)?.state).toBe("done");
    expect(tick.chores).not.toContain(refresh?.id);
  });

  it("leaves a running chore alone even once the branch is up to date", async () => {
    // The worker is in the tree; the verdict on its attempt is the chore's own check to give.
    const s = unjudgedStory("a worker is on it", "in_progress");
    branchWith(s.slug, "mine.ts", "mine\n");
    baseGains("services.ts", "the box\n");
    await runner().tick();
    const refresh = choreFor(db, "refresh", "story", s.id);
    setChoreState(refresh?.id ?? 0, "running");

    branchTakesBase(s.slug);
    await runner().tick();

    expect(choreFor(db, "refresh", "story", s.id)?.state).toBe("running");
  });

  it("raises nothing for a story with no branch, or one that has the base already", async () => {
    const none = unjudgedStory("nobody has started it", "in_progress");
    const fresh = unjudgedStory("cut a moment ago", "in_progress");
    branchWith(fresh.slug, "mine.ts", "mine\n");

    await runner().tick();

    expect(choreFor(db, "refresh", "story", none.id)).toBeNull();
    expect(choreFor(db, "refresh", "story", fresh.id)).toBeNull();
  });

  it("keeps the chore raised while the proving pass is skipping the story for it", async () => {
    // The old rule needed a `waiting` list so that a skipped story did not read as "the tree
    // took the base". The branch answers that itself now: it has not, so the chore stands.
    const s = unjudgedStory("skipped because of this very chore", "in_progress");
    branchWith(s.slug, "mine.ts", "mine\n");
    baseGains("services.ts", "the box\n");
    await runner().tick();
    const refresh = choreFor(db, "refresh", "story", s.id);
    setChoreState(refresh?.id ?? 0, "ready");

    const tick = await runner().tick();

    expect(choreFor(db, "refresh", "story", s.id)?.state).toBe("ready");
    expect(tick.chores).toContain(refresh?.id);
  });
});
