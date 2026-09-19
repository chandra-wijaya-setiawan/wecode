import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A `refresh` is narrowed to the files its merge cannot settle by itself, and most refreshes
 *  cannot settle none of them: the base moved somewhere the story did not touch, and git makes
 *  that merge unaided. Those chores were still dispatched under the role's `write: ["**"]`,
 *  because "merge-tree named no paths" and "merge-tree could not be asked" were the same empty
 *  string in the caller — so the widest authority in the workforce was handed out precisely
 *  when there was nothing at all to write.
 *
 *  They are two different answers. A clean merge claims nothing. Only a merge-tree that gave no
 *  answer — a ref that is gone, a git too old for `--write-tree` — falls back to the role. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

class SystemAgent implements WorkerAdapter {
  readonly kind = "agent";
  readonly handed: Work[] = [];
  async start(w: Work): Promise<Observation> {
    this.handed.push(w);
    return { phase: "succeeded", session: "sess-1", spent: { tokens: 10, seconds: 1 }, commit: null };
  }
  async poll(w: Work): Promise<Observation> {
    return { phase: "succeeded", session: w.session ?? "sess-1", spent: { tokens: 0, seconds: 0 }, commit: null };
  }
  async resume(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async answer(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async kill(): Promise<void> {}
}

const runner = (agent: SystemAgent): Runner =>
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: { agent }, integrationBranch: "main" });

beforeEach(() => {
  repo = tmp("wecode-clean-refresh-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  writeFileSync(join(repo, "docs.md"), "the docs\n");
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
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  const project = make.project(ws, "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
  make.worker("system-1", "system", "agent");
});

const slugOf = (id: number): string =>
  (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;

/** A story in flight whose branch is behind a base that moved somewhere else: the story wrote
 *  `README.md`, the base wrote `docs.md`, and nothing needs settling by hand. */
function aStoryBehindABaseItDoesNotConflictWith(): { id: number; slug: string } {
  const id = make.story(epic, "password reset");
  db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(id);
  const slug = slugOf(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), "the story's line\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", "the story");
  git(repo, "worktree", "remove", "--force", tree);

  writeFileSync(join(repo, "docs.md"), "the docs, revised\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug };
}

/** The one work item the dispatch handed the system worker. Level-triggered: raising a chore
 *  and handing it out are separate ticks, so this runs until it has one. */
async function dispatched(): Promise<Work> {
  const agent = new SystemAgent();
  const r = runner(agent);
  for (let i = 0; i < 4 && agent.handed.length === 0; i++) await r.tick();
  expect(agent.handed).toHaveLength(1);
  return agent.handed[0] as Work;
}

describe("a clean refresh claims nothing", () => {
  it("claims no file at all when the merge conflicts on none", async () => {
    const story = aStoryBehindABaseItDoesNotConflictWith();
    const work = await dispatched();

    expect(work.objective_id).toBe(choreFor(db, "refresh", "story", story.id)?.id);
    expect(work.scope.write).toEqual([]);
  });

  it("does not hand out `**` for the merge git makes by itself", async () => {
    aStoryBehindABaseItDoesNotConflictWith();
    const work = await dispatched();

    expect(work.scope.write).not.toContain("**");
    // The file the base moved merges without a worker, so the chore has no business in it.
    expect(work.scope.write).not.toContain("docs.md");
  });

  it("leaves the rest of the role's scope alone: this narrows writes, nothing else", async () => {
    aStoryBehindABaseItDoesNotConflictWith();
    const work = await dispatched();

    expect(work.scope.tools).toEqual(["bash", "read", "edit", "write"]);
  });

  it("records the empty claim on the assignment, not just in the brief", async () => {
    aStoryBehindABaseItDoesNotConflictWith();
    await dispatched();

    const row = db.prepare("SELECT scope FROM assignment").get() as { scope: string };
    expect((JSON.parse(row.scope) as { write: string[] }).write).toEqual([]);
  });

  it("still claims the conflicting file when there is one", async () => {
    // The narrowing that already existed is the other half of the same answer, and it is
    // asked here so that "no conflict" cannot be made to mean "no answer" again.
    const id = make.story(epic, "session expiry");
    db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(id);
    const slug = slugOf(id);
    const tree = join(repo, `.tree-${slug}`);
    git(repo, "branch", `story/${slug}`, "main");
    git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
    writeFileSync(join(tree, "README.md"), "the story's line\n");
    git(tree, "add", "-A");
    git(tree, "-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", "the story");
    git(repo, "worktree", "remove", "--force", tree);
    writeFileSync(join(repo, "README.md"), "the base's line\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "the base moved");

    const work = await dispatched();
    expect(work.scope.write).toEqual(["README.md"]);
  });

  it("falls back to the role when a `merge` chore is the one being dispatched", async () => {
    // Nothing here can name a merge's conflicts — that merge is the branch into the base, in
    // a tree this one is not — so the ceiling stays the answer for it. A delivered story is
    // what owes a merge, and only a conflicting one owes it at all.
    const id = make.story(epic, "session expiry");
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);
    const slug = slugOf(id);
    const tree = join(repo, `.tree-${slug}`);
    git(repo, "branch", `story/${slug}`, "main");
    git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
    writeFileSync(join(tree, "README.md"), "the story's line\n");
    git(tree, "add", "-A");
    git(tree, "-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", "the story");
    git(repo, "worktree", "remove", "--force", tree);
    writeFileSync(join(repo, "README.md"), "the base's line\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "the base moved");

    const work = await dispatched();
    expect(work.objective_id).toBe(choreFor(db, "merge", "story", id)?.id);
    expect(work.scope.write).toEqual(["**"]);
  });
});
