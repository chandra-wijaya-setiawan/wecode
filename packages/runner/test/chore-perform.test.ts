import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { board, choreFor, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";

/** docs/design/18. A merge chore, performed: a system worker in a tree at the story branch,
 *  and a check the runner proves itself rather than taking the agent's word for. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const tryGit = (cwd: string, ...args: string[]): boolean => {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

/** What the worker did, and what it was told. The brief and the scope are the two halves of
 *  the dispatch, so the test reads both off the work it was handed. */
class SystemAgent implements WorkerAdapter {
  readonly kind = "agent";
  readonly handed: Work[] = [];
  constructor(private readonly act: (w: Work) => void) {}
  async start(w: Work): Promise<Observation> {
    this.handed.push(w);
    this.act(w);
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
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    adapters: { agent },
    integrationBranch: "main",
  });

/** The runner is level-triggered: raising the chore, dispatching it and proving it each
 *  happen on a tick of their own. Nothing here waits on an event. */
async function ticks(r: Runner, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await r.tick();
}

const stateOf = (story: number): string | undefined => choreFor(db, "merge", "story", story)?.state;

const containsBase = (): boolean => tryGit(repo, "merge-base", "--is-ancestor", "main", "story/password-reset");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-chore-perform-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  // The role is the project's config, not this file's: docs/design/18 gives `system` the
  // whole repository because a conflict does not respect scopes.
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
  project = make.project(ws, "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
  make.worker("system-1", "system", "agent");
});

/** A story, delivered, on a branch behind the base and conflicting with it. */
function deliveredStoryBehindTheBase(): { id: number; slug: string; base: string } {
  const id = make.story(epic, "password reset");
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), "the story's line\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "the story");
  git(repo, "worktree", "remove", "--force", tree);

  writeFileSync(join(repo, "README.md"), "the base's line\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug, base: git(repo, "rev-parse", "main") };
}

/** An agent that does the work: merges the base in, resolves the conflict, commits. */
const mergesTheBase = (w: Work): void => {
  tryGit(w.worktree, "-c", "user.name=a", "-c", "user.email=a@localhost", "merge", "--no-ff", "-q", "main");
  writeFileSync(join(w.worktree, "README.md"), "the base's line\nthe story's line\n");
  git(w.worktree, "add", "-A");
  git(w.worktree, "-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", "merge main");
};

describe("a merge chore, performed", () => {
  it("reaches done only once the branch contains the base", async () => {
    const story = deliveredStoryBehindTheBase();
    const agent = new SystemAgent(mergesTheBase);
    const r = runner(agent);

    // Raised and handed out on the first tick; the attempt has not run yet, so the merge is
    // not there and the chore is in hand rather than done.
    const first = await r.tick();
    expect(first.performed.dispatched).toEqual([choreFor(db, "merge", "story", story.id)?.id]);
    expect(stateOf(story.id)).toBe("running");
    expect(containsBase()).toBe(false);

    await ticks(r, 2);
    expect(containsBase()).toBe(true);
    expect(stateOf(story.id)).toBe("done");
  });

  it("hands the worker a tree at the story branch, a `**` scope and a brief that says what the check is", async () => {
    const story = deliveredStoryBehindTheBase();
    const agent = new SystemAgent(mergesTheBase);
    await ticks(runner(agent), 4);

    expect(agent.handed).toHaveLength(1);
    const work = agent.handed[0] as Work;
    expect(work.objective_type).toBe("chore");
    expect(work.objective_id).toBe(choreFor(db, "merge", "story", story.id)?.id);
    // A conflict is wherever the conflict is, so the scope names no files.
    expect(work.scope.write).toEqual(["**"]);
    expect(git(work.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`story/${story.slug}`);
    expect(work.instruction).toContain(`story/${story.slug}`);
    expect(work.instruction).toContain("main merges cleanly into story/password-reset");
    expect(work.instruction).toContain("the suite still passes");

    const assignment = db
      .prepare("SELECT objective_type, w.role AS role FROM assignment a JOIN worker w ON w.id = a.worker_id")
      .get() as { objective_type: string; role: string };
    expect(assignment).toEqual({ objective_type: "chore", role: "system" });
  });

  it("is proved, not trusted: an agent that says it merged and did not fails the chore", async () => {
    const story = deliveredStoryBehindTheBase();
    const agent = new SystemAgent(() => {});
    await ticks(runner(agent), 4);

    expect(containsBase()).toBe(false);
    expect(stateOf(story.id)).toBe("failed");
    // The story stays visible as unmergeable, with the reason the check was not proved.
    const shown = board(db).chores;
    expect(shown).toHaveLength(1);
    expect(shown[0]?.state).toBe("failed");
  });

  it("fails the chore when the merge was made and the suite is red", async () => {
    const story = deliveredStoryBehindTheBase();
    const req = make.requirement(story.id, "it still works");
    const criteria = make.criteria(req, "the suite is green");
    make.acceptanceTest(criteria, "the suite", "script", "exit 1");

    const agent = new SystemAgent(mergesTheBase);
    await ticks(runner(agent), 4);

    expect(containsBase()).toBe(true);
    expect(stateOf(story.id)).toBe("failed");
  });

  it("writes nothing on the base branch and lands nothing", async () => {
    const story = deliveredStoryBehindTheBase();
    await ticks(runner(new SystemAgent(mergesTheBase)), 4);

    expect(stateOf(story.id)).toBe("done");
    // The base is where it was: the merge went into the story branch, and landing is the
    // operator's verb.
    expect(git(repo, "rev-parse", "main")).toBe(story.base);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("the base's line\n");
    expect(tryGit(repo, "merge-base", "--is-ancestor", `story/${story.slug}`, "main")).toBe(false);
  });
});
