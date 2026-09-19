import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** `system` is declared `write: ["**"]` in config/roles.yaml, and every chore was dispatched
 *  under it verbatim: the one role in the workforce that may write anywhere was handed out
 *  whenever a story branch fell behind, which is most ticks.
 *
 *  For a `refresh` that authority is not needed. The chore's work is a base-into-branch
 *  merge, and which files that merge cannot settle by itself is knowable before a worker is
 *  hired — `git merge-tree` replays it against the object store and names them. So a refresh
 *  is dispatched with a scope that says what it writes.
 *
 *  A `merge` chore is the other direction — the branch into the base, in a tree that is not
 *  the base's — so nothing here can name its conflicts, and it keeps `**`. Narrowing only
 *  ever narrows: the role's scope stays the ceiling and stays the fallback. */

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
  repo = tmp("wecode-chore-claims-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  writeFileSync(join(repo, "CHANGELOG.md"), "nothing yet\n");
  writeFileSync(join(repo, "docs.md"), "the docs\n");
  mkdirSync(join(repo, "config"), { recursive: true });
  // The role is the project's config, not this file's, and it is the widest one there is:
  // whatever the dispatch hands the worker, it got there by narrowing this.
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

interface Story {
  readonly id: number;
  readonly slug: string;
}

/** A story on a branch that is behind the base and conflicts with it. `conflicting` are the
 *  files both sides rewrote; the base also moves `docs.md`, which merges by itself and is
 *  the file the scope must *not* name. `state` decides which chore the tick raises —
 *  `in_progress` owes a `refresh`, `delivered` owes a `merge`. */
function storyBehindTheBase(state: "in_progress" | "delivered", conflicting: readonly string[]): Story {
  const id = make.story(epic, "password reset");
  db.prepare("UPDATE story SET state = ? WHERE id = ?").run(state, id);
  const slug = slugOf(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  for (const file of conflicting) writeFileSync(join(tree, file), "the story's line\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", "the story");
  git(repo, "worktree", "remove", "--force", tree);

  for (const file of conflicting) writeFileSync(join(repo, file), "the base's line\n");
  writeFileSync(join(repo, "docs.md"), "the docs, revised\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug };
}

/** The one work item the dispatch handed the system worker. The runner is level-triggered —
 *  raising a chore and handing it out are separate ticks — so this runs until it has one. */
async function dispatched(): Promise<Work> {
  const agent = new SystemAgent();
  const r = runner(agent);
  for (let i = 0; i < 4 && agent.handed.length === 0; i++) await r.tick();
  expect(agent.handed).toHaveLength(1);
  return agent.handed[0] as Work;
}

describe("a chore claims only what it writes", () => {
  it("gives a refresh a scope that names the conflicting file instead of `**`", async () => {
    const story = storyBehindTheBase("in_progress", ["README.md"]);
    const work = await dispatched();

    expect(work.objective_id).toBe(choreFor(db, "refresh", "story", story.id)?.id);
    expect(work.scope.write).toEqual(["README.md"]);
  });

  it("names every conflicting file, and nothing the base moved cleanly", async () => {
    storyBehindTheBase("in_progress", ["README.md", "CHANGELOG.md"]);
    const work = await dispatched();

    expect([...work.scope.write].sort()).toEqual(["CHANGELOG.md", "README.md"]);
    // docs.md moved on the base too, but the merge settles it without a worker, so the
    // chore has no business writing it.
    expect(work.scope.write).not.toContain("docs.md");
  });

  it("narrows the writes and leaves the rest of the role's scope alone", async () => {
    storyBehindTheBase("in_progress", ["README.md"]);
    const work = await dispatched();

    // The tools are the role's — this is a narrowing of what may be written, not a second
    // definition of what a system worker is.
    expect(work.scope.tools).toEqual(["bash", "read", "edit", "write"]);
  });

  it("records the narrowed scope on the assignment, not just in the brief", async () => {
    storyBehindTheBase("in_progress", ["README.md"]);
    await dispatched();

    const row = db.prepare("SELECT scope FROM assignment").get() as { scope: string };
    expect((JSON.parse(row.scope) as { write: string[] }).write).toEqual(["README.md"]);
  });

  it("still gives a merge chore the whole repository: nothing here can name its conflicts", async () => {
    const story = storyBehindTheBase("delivered", ["README.md"]);
    const work = await dispatched();

    expect(work.objective_id).toBe(choreFor(db, "merge", "story", story.id)?.id);
    expect(work.scope.write).toEqual(["**"]);
  });
});
