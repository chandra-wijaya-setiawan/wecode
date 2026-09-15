import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, choreRefusal, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Tick, Work, WorkerAdapter } from "../src/index.js";

/** Every planned chore is tried on every tick, and the reason the tick could not hand it
 *  out is the reason that tick read — not the one a tick before it read. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
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

const runner = (max_open = 1): Runner =>
  new Runner(db, {
    budget: { ...DEFAULT_BUDGET, max_open },
    repoRoot: repo,
    adapters: { agent: new SystemAgent() },
    integrationBranch: "main",
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-chore-retried-"));
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

  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(
    join(repo, "config", "roles.yaml"),
    [
      "invariants:",
      "  never_touch: []",
      "  never_run: []",
      "roles:",
      "  system:",
      "    worker_kind: agent",
      "    scope:",
      '      write: ["**"]',
      '      tools: ["bash", "read", "edit", "write"]',
      "",
    ].join("\n"),
  );
});

/** A delivered story whose branch will not merge into the base: the condition that raises
 *  a merge chore. */
function anUnmergeableStory(title: string): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), `${title} on the branch\n`);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);

  writeFileSync(join(repo, "README.md"), `the base moved past ${title}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `the base moved past ${title}`);
  return { id, slug };
}

const choreOf = (story: number): number => choreFor(db, "merge", "story", story)?.id as number;

/** The session on the chore ends, and the next tick judges it. The adapter here never
 *  finishes on its own, so the phase is moved the way a real one would move it. */
const endTheAttempt = async (): Promise<Tick> => {
  db.prepare("UPDATE assignment SET phase = 'succeeded' WHERE objective_type = 'chore' AND phase IN ('pending','running')").run();
  return await runner().tick();
};

describe("what a tick does with the chores it cannot hand out", () => {
  it("records a reason against the chore the slots were already full for", async () => {
    const first = anUnmergeableStory("password reset");
    const second = anUnmergeableStory("session expiry");
    make.worker("system-1", "system", "agent");
    make.worker("system-2", "system", "agent");

    await runner().tick();
    const a = choreOf(first.id);
    const b = choreOf(second.id);
    await runner().tick();

    // One slot, two chores: one is attempted and the other must say what held it.
    const refusals = [choreRefusal(db, a)?.why, choreRefusal(db, b)?.why];
    expect(refusals.filter((w) => w !== undefined)).toHaveLength(1);
    expect(refusals.find((w) => w !== undefined)).toContain("slots are open");
  });

  it("refreshes the reason when a later tick is held by something else", async () => {
    const story = anUnmergeableStory("password reset");
    await runner().tick();
    const id = choreOf(story.id);

    // First tick: nobody to take it.
    await runner().tick();
    expect(choreRefusal(db, id)?.why).toContain("no worker free");
    const passes = choreRefusal(db, id)?.passes;

    // Second: a worker arrives, and the tree path is occupied by a plain file instead.
    make.worker("system-1", "system", "agent");
    mkdirSync(join(repo, ".wecode", "worktrees"), { recursive: true });
    writeFileSync(join(repo, ".wecode", "worktrees", `story-${story.slug}`), "not a tree\n");
    await runner().tick();

    const why = choreRefusal(db, id)?.why;
    expect(why).toBeDefined();
    expect(why).not.toContain("no worker free");
    expect(why).toContain(`story-${story.slug}`);
    expect(choreRefusal(db, id)?.passes).toBe(1);
    expect(passes).toBeGreaterThanOrEqual(1);

    // Third: the path is cleared, so the chore is tried again and goes out.
    rmSync(join(repo, ".wecode", "worktrees", `story-${story.slug}`));
    await runner().tick();
    expect(choreRefusal(db, id)).toBeNull();
  });

  it("keeps the verdict of an attempt that did not prove the check", async () => {
    const story = anUnmergeableStory("password reset");
    make.worker("system-1", "system", "agent");
    await runner().tick();
    const id = choreOf(story.id);

    // Handed out, and the session ends without the merge having been made.
    await runner().tick();
    expect(choreFor(db, "merge", "story", story.id)?.state).toBe("running");
    const pass = await endTheAttempt();

    expect(pass.performed.failed).toEqual([
      { id, why: `main is not an ancestor of story/${story.slug}: the merge was not made` },
    ]);
    // The same sentence on the chore itself, so the board can say why it is failed.
    expect(choreRefusal(db, id)?.why).toBe(pass.performed.failed[0]?.why);
  });

  it("leaves the last verdict standing on a chore that has used its attempts", async () => {
    const story = anUnmergeableStory("password reset");
    make.worker("system-1", "system", "agent");
    await runner().tick();
    const id = choreOf(story.id);

    // Every attempt the kind allows, each one ending without the merge: dispatch, end,
    // reraise on the tick after. Three `begin` rows is the ceiling for a merge chore.
    for (let i = 0; i < 3; i++) {
      await runner().tick();
      await endTheAttempt();
    }
    expect(choreFor(db, "merge", "story", story.id)?.state).toBe("failed");

    // Nothing raises it again, so nothing else will ever write a reason for it. Two more
    // ticks, and the verdict it stopped on is still the reason on the record.
    await runner().tick();
    await runner().tick();
    expect(choreFor(db, "merge", "story", story.id)?.state).toBe("failed");
    expect(choreRefusal(db, id)?.why).toBe(`main is not an ancestor of story/${story.slug}: the merge was not made`);
  });
});
