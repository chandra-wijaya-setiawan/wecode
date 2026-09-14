import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { board, choreFor, choreRefusal, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";

/** Every condition that makes dispatchChore return null, read back off the record.
 *
 *  The complaint this answers: three merge chores sat in `planned` for half an hour and the
 *  operator could not tell which of six conditions was holding them. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

class SystemAgent implements WorkerAdapter {
  readonly kind = "agent";
  async start(): Promise<Observation> {
    return { phase: "running", session: "sess-1", spent: { tokens: 0, seconds: 0 }, commit: null };
  }
  async poll(w: Work): Promise<Observation> {
    return { phase: "running", session: w.session ?? "sess-1", spent: { tokens: 0, seconds: 0 }, commit: null };
  }
  async resume(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async answer(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async kill(): Promise<void> {}
}

const runner = (budget = DEFAULT_BUDGET): Runner =>
  new Runner(db, { budget, repoRoot: repo, adapters: { agent: new SystemAgent() }, integrationBranch: "main" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-chore-refusal-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  project = make.project(ws, "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

/** The role and a worker to fill it. Both are the record's, and each test that wants one of
 *  them missing simply does not call this half. */
function theSystemRole(): void {
  make.role("system", { write: ["**"], tools: ["bash", "read", "edit", "write"] }, "agent");
}
const aSystemWorker = (): number => make.worker("system-1", "system", "agent");

/** A delivered story with a branch that will not merge: the condition that raises a merge
 *  chore, and the setup every test here starts from. */
function anUnmergeableStory(title = "password reset"): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), "the story's line\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);

  writeFileSync(join(repo, "README.md"), "the base's line\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug };
}

const whyOf = (story: number): string | undefined => {
  const chore = choreFor(db, "merge", "story", story);
  return chore === null ? undefined : (choreRefusal(db, chore.id)?.why ?? undefined);
};

describe("a chore nothing could dispatch", () => {
  it("says there is no worker free for its role", async () => {
    theSystemRole();
    const story = anUnmergeableStory();

    await runner().tick();

    expect(whyOf(story.id)).toBe("no worker free for role system");
  });

  it("says where the missing scope should have come from", async () => {
    // No role row at all: config/roles.yaml was never loaded into this workspace.
    const story = anUnmergeableStory();

    await runner().tick();

    expect(whyOf(story.id)).toBe("no scope for role system in config/roles.yaml");
  });

  it("says the story it targets is gone", async () => {
    theSystemRole();
    const story = anUnmergeableStory();
    await runner().tick();
    const id = choreFor(db, "merge", "story", story.id)?.id as number;

    // The chore outlives the story it was raised for: the target row is dropped, and the
    // chore is left pointing at nothing.
    db.prepare("DELETE FROM story WHERE id = ?").run(story.id);
    await runner().tick();

    expect(choreRefusal(db, id)?.why).toBe("the story it targets is gone");
  });

  it("says how many of the slots are open when the budget is full", async () => {
    theSystemRole();
    aSystemWorker();
    const story = anUnmergeableStory();

    // One slot, and something already in it.
    make.worker("dev-1", "dev", "agent");
    const budget = { ...DEFAULT_BUDGET, max_open: 1 };
    new Maker(db).assignment({
      objective_type: "task",
      objective_id: 1,
      worker_id: aSystemWorker2(),
      scope: { write: ["**"], tools: ["read"] },
      budget: { tokens: 1000, seconds: 60 },
      worktree: repo,
    });

    await runner(budget).tick();

    expect(whyOf(story.id)).toBe("0 of 1 slots are open");
  });

  it("says there is no branch to merge into yet when the tree cannot be had", async () => {
    theSystemRole();
    const story = anUnmergeableStory();
    // No worker yet, so this pass stops before a tree is ever cut.
    await runner().tick();
    const id = choreFor(db, "merge", "story", story.id)?.id as number;

    // Something is in the way of the tree the chore would be given — the branch cannot be
    // laid out anywhere, which is git's half of "there is nothing to merge in yet".
    mkdirSync(join(repo, ".wecode", "worktrees"), { recursive: true });
    writeFileSync(join(repo, ".wecode", "worktrees", `story-${story.slug}`), "not a tree\n");
    aSystemWorker();
    await runner().tick();

    expect(choreRefusal(db, id)?.why).toBe("no branch to merge into yet");
  });

  it("keeps `since` while the reason holds, and counts the passes", async () => {
    theSystemRole();
    const story = anUnmergeableStory();

    await runner().tick();
    const id = choreFor(db, "merge", "story", story.id)?.id as number;
    const first = choreRefusal(db, id);
    await runner().tick();
    const second = choreRefusal(db, id);

    expect(first?.passes).toBe(1);
    expect(second?.passes).toBe(2);
    expect(second?.since).toBe(first?.since);
  });
});

describe("the board", () => {
  it("shows a chore's refusal beside the task ones", async () => {
    theSystemRole();
    const story = anUnmergeableStory();
    await runner().tick();
    const id = choreFor(db, "merge", "story", story.id)?.id as number;

    const row = board(db).stale.find((r) => r.id === id && r.what.startsWith("merge story"));
    expect(row).toBeDefined();
    expect(row?.state).toBe("planned");
    expect(row?.detail).toMatch(/^no worker free for role system · 1 passes · \d+m$/);

    // And under the project it belongs to, rather than only in the whole workspace.
    expect(board(db, project).stale.some((r) => r.id === id)).toBe(true);
  });

  it("says nothing about a chore no pass has refused", async () => {
    theSystemRole();
    aSystemWorker();
    const story = anUnmergeableStory();

    await runner().tick();
    const id = choreFor(db, "merge", "story", story.id)?.id as number;

    expect(choreRefusal(db, id)).toBeNull();
    expect(board(db).stale.some((r) => r.what.startsWith("merge story"))).toBe(false);
  });
});

describe("a chore that gets dispatched", () => {
  it("has the reason it was held cleared", async () => {
    theSystemRole();
    const story = anUnmergeableStory();

    // First pass: nobody to give it to.
    await runner().tick();
    const id = choreFor(db, "merge", "story", story.id)?.id as number;
    expect(choreRefusal(db, id)?.why).toBe("no worker free for role system");

    // A worker arrives, and the chore goes out.
    aSystemWorker();
    await runner().tick();

    expect(choreFor(db, "merge", "story", story.id)?.state).toBe("running");
    expect(choreRefusal(db, id)).toBeNull();
  });
});

/** A second system worker, for the test that needs one holding the only slot. */
function aSystemWorker2(): number {
  return make.worker("system-2", "system", "agent");
}
