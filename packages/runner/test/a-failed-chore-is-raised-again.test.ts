import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";

/** A `refresh` chore is a claim about a branch: the base is not an ancestor of it. Only an
 *  in_progress story raises one, because that is the tree wecode is proving in — but the
 *  claim does not stop being about the branch when the story moves on.
 *
 *  The shape these pin: a chore raised while the story was in_progress, left `failed`, and
 *  the story then put on hold or delivered. Nothing revisited it, so the row went on
 *  refusing a tree that had long since taken the base. The check is re-read every tick
 *  whatever state the story is in; raising still is not. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

const runner = (): Runner => new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, integrationBranch: "main" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-refresh-reread-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  project = make.project(make.workspace("acme", repo), "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

/** A story in flight whose branch was cut before the base moved: the refresh condition. */
function aStoryLeftBehind(title = "password reset"): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  setState(id, "in_progress");

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "story.md"), "the story's line\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);

  writeFileSync(join(repo, "base.md"), "the base moved\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug };
}

/** The branch takes the base — the condition clearing, made the way a worker would make it. */
function theBranchTakesTheBase(slug: string): void {
  const tree = join(repo, `.tree-${slug}-merge`);
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "merge", "-q", "main", "-m", "take the base");
  git(repo, "worktree", "remove", "--force", tree);
}

const setState = (story: number, state: string): void => {
  db.prepare("UPDATE story SET state = ? WHERE id = ?").run(state, story);
};

const refreshOf = (story: number) => choreFor(db, "refresh", "story", story);

/** The chore as it is left by a worker who could not discharge it. */
const markFailed = (chore: number): void => {
  db.prepare("UPDATE chore SET state = 'failed' WHERE id = ?").run(chore);
};

async function aFailedRefreshChore(story: { id: number; slug: string }): Promise<number> {
  await runner().tick();
  const chore = refreshOf(story.id);
  expect(chore).not.toBeNull();
  markFailed(chore!.id);
  return chore!.id;
}

describe("a failed refresh chore", () => {
  it("is closed once its branch takes the base, with the story on hold", async () => {
    const story = aStoryLeftBehind();
    const chore = await aFailedRefreshChore(story);

    setState(story.id, "on_hold");
    theBranchTakesTheBase(story.slug);
    await runner().tick();

    expect(refreshOf(story.id)?.state).toBe("done");
    expect(refreshOf(story.id)?.id).toBe(chore);
  });

  it("is closed once its branch takes the base, with the story delivered", async () => {
    const story = aStoryLeftBehind();
    await aFailedRefreshChore(story);

    setState(story.id, "delivered");
    theBranchTakesTheBase(story.slug);
    await runner().tick();

    expect(refreshOf(story.id)?.state).toBe("done");
  });

  it("is still closed with the story in_progress", async () => {
    const story = aStoryLeftBehind();
    await aFailedRefreshChore(story);

    theBranchTakesTheBase(story.slug);
    await runner().tick();

    expect(refreshOf(story.id)?.state).toBe("done");
  });

  it("stands as it is while the branch is still behind and the story is on hold", async () => {
    // Re-reading the check is not re-raising the chore: nothing is being proved in that
    // tree, so a story that could not raise one cannot have one revived here either.
    const story = aStoryLeftBehind();
    await aFailedRefreshChore(story);

    setState(story.id, "on_hold");
    const result = await runner().tick();

    expect(refreshOf(story.id)?.state).toBe("failed");
    expect(result.chores).not.toContain(refreshOf(story.id)?.id);
  });

  it("is left to the worker that holds it while an attempt is running", async () => {
    const story = aStoryLeftBehind();
    const chore = await aFailedRefreshChore(story);
    db.prepare("UPDATE chore SET state = 'running' WHERE id = ?").run(chore);

    setState(story.id, "on_hold");
    theBranchTakesTheBase(story.slug);
    await runner().tick();

    expect(refreshOf(story.id)?.state).toBe("running");
  });
});

describe("a story that is not in flight", () => {
  it("raises no refresh chore of its own, however far behind its branch is", async () => {
    const story = aStoryLeftBehind();
    setState(story.id, "on_hold");

    await runner().tick();

    expect(refreshOf(story.id)).toBeNull();
  });
});
