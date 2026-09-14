import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyChore, board, choreFor, ensureChore, Maker, open, SCHEMA_VERSION } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-chore-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  // A workspace that existed before chores did, then upgraded — which is every workspace
  // anyone is actually working in. A database created from nothing runs every migration
  // whatever it is numbered, so it would pass with the chore table unreachable in the
  // field; this one only has a chore table if the upgrade puts one there.
  const path = join(repo, "wecode.db");
  open(path, { to: SCHEMA_VERSION - 1 }).close();
  db = open(path);
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  project = make.project(ws, "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

const runner = (): Runner =>
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: {}, integrationBranch: "main" });

/** A story, delivered, with a branch of its own. `delivered` is written straight onto the
 *  record: how a story gets there is the cascade's business and every other test's, and
 *  this one is about what happens once it is. */
function deliveredStory(title: string, line: string): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), line);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);
  return { id, slug };
}

/** The base moves under a delivered story, on the same line. Nothing on either branch is
 *  wrong; they simply cannot both be true, which is the whole condition being tested. */
function moveTheBase(line: string): void {
  writeFileSync(join(repo, "README.md"), line);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
}

describe("a delivered story whose branch will not merge", () => {
  it("gets exactly one merge chore, and not a second one on the next tick", async () => {
    const story = deliveredStory("password reset", "the story's line\n");
    moveTheBase("the base's line\n");

    const first = await runner().tick();
    expect(first.chores).toHaveLength(1);

    const chore = choreFor(db, "merge", "story", story.id);
    expect(chore).toMatchObject({
      kind: "merge",
      project_id: project,
      target_type: "story",
      target_id: story.id,
      check: "the branch merges cleanly",
      state: "planned",
    });

    const second = await runner().tick();
    expect(second.chores).toEqual([chore?.id]);
    expect((db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n).toBe(1);
  });

  it("is on the board, as itself, with its kind and its target", async () => {
    const story = deliveredStory("password reset", "the story's line\n");
    moveTheBase("the base's line\n");
    await runner().tick();

    expect(board(db).chores).toEqual([
      {
        id: choreFor(db, "merge", "story", story.id)?.id,
        what: "merge story password reset",
        state: "planned",
        detail: "the branch merges cleanly",
      },
    ]);
    expect(board(db, project).chores).toHaveLength(1);
  });

  it("needs nobody's approval: wecode already tried the merge and it failed", async () => {
    const story = deliveredStory("password reset", "the story's line\n");
    moveTheBase("the base's line\n");
    await runner().tick();

    const id = choreFor(db, "merge", "story", story.id)?.id as number;
    expect(applyChore(db, id, "start", "runner").ok).toBe(true);
  });

  it("keeps the chore across a tick once a worker has it in hand", async () => {
    const story = deliveredStory("password reset", "the story's line\n");
    moveTheBase("the base's line\n");
    await runner().tick();

    const id = choreFor(db, "merge", "story", story.id)?.id as number;
    applyChore(db, id, "start", "runner");
    applyChore(db, id, "begin", "system-1");

    // The condition is still true — the merge has not been made yet — and re-reading it
    // must not reset the chore a worker is part way through.
    expect((await runner().tick()).chores).toEqual([id]);
    expect(choreFor(db, "merge", "story", story.id)?.state).toBe("running");
  });
});

describe("a delivered story that merges cleanly", () => {
  it("gets no chore: there is nothing owed", async () => {
    deliveredStory("password reset", "the base\nand a line only the story has\n");

    expect((await runner().tick()).chores).toEqual([]);
    expect((db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n).toBe(0);
  });

  it("nor does a story still in flight, however badly it conflicts", async () => {
    const story = deliveredStory("password reset", "the story's line\n");
    moveTheBase("the base's line\n");
    // The conflict is real; the story is not finished. A branch in flight is expected to
    // diverge, and a chore for it would be noise on every board in the workspace.
    db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(story.id);

    expect((await runner().tick()).chores).toEqual([]);
  });

  it("nor a delivered story with no branch at all", async () => {
    const id = make.story(epic, "never started");
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

    expect((await runner().tick()).chores).toEqual([]);
  });
});

describe("a sweep chore", () => {
  it("refuses to start without approval, and the board says so", async () => {
    ensureChore(db, {
      project_id: project,
      kind: "sweep",
      target_type: "project",
      target_id: project,
      check: "the lessons are fewer and still say what the originals said",
    });

    const id = choreFor(db, "sweep", "project", project)?.id as number;
    const refused = applyChore(db, id, "start", "runner");
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.why).toBe("a sweep chore needs approval before it starts");

    // A tick neither starts it nor forgets it.
    await runner().tick();
    expect(board(db).chores).toEqual([
      { id, what: "sweep project storefront", state: "planned", detail: "waiting for approval" },
    ]);
  });
});
