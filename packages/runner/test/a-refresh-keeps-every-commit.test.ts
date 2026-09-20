import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, choreRefusal, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** `a-refresh-orphans-nothing` defends the commits wecode itself merged in: `landed_branch`,
 *  one row per landed task. That is not everything the branch holds. A worker settling a
 *  conflict commits on the story branch; so does a refresh's own merge; and a story whose
 *  tasks have landed nothing at all has no `landed_branch` row to defend. `git reset --hard
 *  main` threw all of those away while passing the chore's own check.
 *
 *  So the rule is about every commit the branch already held, and the record of what it held
 *  is the branch's own reflog: a story branch only ever moves forward, so a commit it once
 *  stood at and can no longer reach was dropped. */

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
let epic: number;

class SystemAgent implements WorkerAdapter {
  readonly kind = "agent";
  constructor(private readonly act: (w: Work) => void) {}
  async start(w: Work): Promise<Observation> {
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
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: { agent }, integrationBranch: "main" });

async function ticks(r: Runner, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await r.tick();
}

beforeEach(() => {
  repo = tmp("wecode-refresh-keeps-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
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

interface Story {
  readonly id: number;
  readonly slug: string;
  /** The commit made on the story branch itself — no task landed it, so `landed_branch`
   *  has never heard of it. */
  readonly held: string;
}

/** An in-progress story whose branch carries a commit of its own and is behind a base that
 *  conflicts with it, so the tick cannot refresh the tree itself and raises the chore. */
function storyHoldingItsOwnCommit(): Story {
  const id = make.story(epic, "password reset");
  const req = make.requirement(id, "it behaves");
  const c = make.criteria(req, "proven by a script");
  const test = make.acceptanceTest(c, "the suite is green", "script", "true");
  db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(id);
  db.prepare("UPDATE requirement SET state = 'in_progress' WHERE id = ?").run(req);
  db.prepare("UPDATE acceptance_criteria SET state = 'in_progress' WHERE id = ?").run(c);
  db.prepare("UPDATE acceptance_test SET state = 'ready' WHERE id = ?").run(test);

  const slug = slugOf(id);
  git(repo, "branch", `story/${slug}`, "main");

  // The commit the branch already holds, made in a tree of its own and pushed onto the
  // branch exactly as a worker's settled conflict reaches it.
  const tree = join(repo, `.story-${slug}-seed`);
  git(repo, "worktree", "add", "-q", "--detach", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), "the story's idea\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", "the story's own work");
  const held = git(tree, "rev-parse", "HEAD");
  git(repo, "update-ref", `refs/heads/story/${slug}`, held);
  git(repo, "worktree", "remove", "--force", tree);

  // The base moves under it, onto the same line, so the inline merge cannot settle it.
  writeFileSync(join(repo, "README.md"), "the base's idea\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug, held };
}

const stillReaches = (s: Story): boolean =>
  tryGit(repo, "merge-base", "--is-ancestor", s.held, `story/${s.slug}`);

const containsBase = (s: Story): boolean =>
  tryGit(repo, "merge-base", "--is-ancestor", "main", `story/${s.slug}`);

const refresh = (s: Story): { id: number; state: string } | null => {
  const found = choreFor(db, "refresh", "story", s.id);
  return found === null ? null : { id: found.id, state: found.state };
};

const whyOf = (s: Story): string => choreRefusal(db, refresh(s)?.id ?? 0)?.why ?? "";

/** The shortcut: throw the branch away and put the base there instead. */
const resetsOntoTheBase = (w: Work): void => {
  git(w.worktree, "reset", "--hard", "-q", "main");
};

/** The work: merge the base in, settle the conflict by hand, keep both. */
const mergesTheBase = (w: Work): void => {
  tryGit(w.worktree, "-c", "user.name=a", "-c", "user.email=a@localhost", "merge", "--no-ff", "-q", "main");
  writeFileSync(join(w.worktree, "README.md"), "the base's idea\nthe story's idea\n");
  git(w.worktree, "add", "-A");
  git(w.worktree, "-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", "merge main");
};

describe("a refresh keeps every commit the branch already held", () => {
  it("is set up with a commit on the branch that no landed task speaks for", async () => {
    const s = storyHoldingItsOwnCommit();
    await runner(new SystemAgent(() => {})).tick();

    expect(stillReaches(s)).toBe(true);
    expect(containsBase(s)).toBe(false);
    // Nothing landed, so the older rule has nothing at all to defend.
    expect(db.prepare("SELECT COUNT(*) AS n FROM landed_branch").get()).toEqual({ n: 0 });
    expect(refresh(s)?.state).toBe("running");
  });

  it("refuses a reset that dropped it, and names the commit", async () => {
    const s = storyHoldingItsOwnCommit();
    await ticks(runner(new SystemAgent(resetsOntoTheBase)), 2);

    // The chore's own question is true: the branch contains the base.
    expect(containsBase(s)).toBe(true);
    // It is refused anyway, because the branch no longer holds what it held.
    expect(stillReaches(s)).toBe(false);
    expect(refresh(s)?.state).toBe("failed");
    expect(whyOf(s)).toContain(s.held.slice(0, 12));
    expect(whyOf(s)).toContain("a refresh adds the base, it does not replace the branch");
  });

  it("stays refused: the next tick does not close it as up to date", async () => {
    const s = storyHoldingItsOwnCommit();
    const r = runner(new SystemAgent(resetsOntoTheBase));
    await ticks(r, 2);

    const tick = await r.tick();

    expect(refresh(s)?.state).toBe("failed");
    expect(tick.chores).toContain(refresh(s)?.id);
    expect(whyOf(s)).toContain(s.held.slice(0, 12));
  });

  it("passes the refresh that kept it", async () => {
    const s = storyHoldingItsOwnCommit();
    await ticks(runner(new SystemAgent(mergesTheBase)), 2);

    expect(containsBase(s)).toBe(true);
    expect(stillReaches(s)).toBe(true);
    expect(refresh(s)?.state).toBe("done");
  });

  it("keeps closing a branch that is honestly up to date", async () => {
    const s = storyHoldingItsOwnCommit();
    const r = runner(new SystemAgent(mergesTheBase));
    await ticks(r, 3);

    expect(refresh(s)?.state).toBe("done");
    expect((await r.tick()).chores).not.toContain(refresh(s)?.id);
  });
});
