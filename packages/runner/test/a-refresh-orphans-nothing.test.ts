import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { board, choreFor, choreRefusal, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A refresh is asked for one thing — put the base into the story branch — and it is judged
 *  by one question, "is the base an ancestor of the branch". `git reset --hard main` answers
 *  that question perfectly while doing the opposite of the work: the attempts the story was
 *  carrying stop being reachable from its branch, the chore goes `done`, and the only sign
 *  anything happened is that the work is gone.
 *
 *  So the check has a second half. The commits wecode itself merged into the branch —
 *  `landed_branch`, one row per task, holding the task-branch tip `landDoneTasks` merged —
 *  must still be reachable from it. */

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
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: { agent }, integrationBranch: "main" });

async function ticks(r: Runner, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await r.tick();
}

beforeEach(() => {
  repo = tmp("wecode-refresh-orphans-");
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

const slugOf = (table: "story" | "task", id: number): string =>
  (db.prepare(`SELECT slug FROM ${table} WHERE id = ?`).get(id) as { slug: string }).slug;

interface Story {
  readonly id: number;
  readonly slug: string;
  readonly task: number;
  /** The attempt's commit: the tip of the task branch wecode merged into the story. */
  readonly attempt: string;
}

/** An in-progress story whose one task has been attempted, committed and merged onto the
 *  story branch by the runner — and whose branch then conflicts with the base, so the tick
 *  cannot refresh the tree itself and has to raise the chore. */
function storyCarryingAnAttempt(): Story {
  const id = make.story(epic, "password reset");
  const req = make.requirement(id, "it behaves");
  const c = make.criteria(req, "proven by a script");
  const test = make.acceptanceTest(c, "the suite is green", "script", "test -f mine.ts");
  const task = make.task(test, "do the work", { role: "engineer", scope: { write: ["mine.ts"], tools: [] } });
  db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(id);
  db.prepare("UPDATE requirement SET state = 'in_progress' WHERE id = ?").run(req);
  db.prepare("UPDATE acceptance_criteria SET state = 'in_progress' WHERE id = ?").run(c);
  db.prepare("UPDATE acceptance_test SET state = 'ready' WHERE id = ?").run(test);
  db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(task);

  const slug = slugOf("story", id);
  const taskSlug = slugOf("task", task);
  git(repo, "branch", `story/${slug}`, "main");

  // The attempt, in a tree of its own, committed onto its task branch exactly as
  // `settleEnded` leaves it. It touches README.md too, which is what will conflict.
  git(repo, "branch", `task/${taskSlug}`, "main");
  const tree = join(repo, `.attempt-${taskSlug}`);
  git(repo, "worktree", "add", "-q", tree, `task/${taskSlug}`);
  writeFileSync(join(tree, "mine.ts"), "the work\n");
  writeFileSync(join(tree, "README.md"), "the story's idea\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=a", "-c", "user.email=a@localhost", "commit", "-q", "-m", `${taskSlug}: attempt`);
  const attempt = git(tree, "rev-parse", "HEAD");
  git(repo, "worktree", "remove", "--force", tree);

  // The record of that attempt: a finished assignment carrying its commit, which is what
  // `landDoneTasks` reads before merging the branch into the story.
  const assignment = make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: make.worker("engineer-1", "engineer", "agent"),
    scope: { write: ["mine.ts"], tools: [] },
    budget: { tokens: 1000, seconds: 60 },
    worktree: "",
  });
  db.prepare("UPDATE assignment SET phase = 'succeeded', commit_sha = ? WHERE id = ?").run(attempt, assignment);

  // The base moves under it, onto the same line.
  writeFileSync(join(repo, "README.md"), "the base's idea\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug, task, attempt };
}

/** Reachable from the story branch? The one question the whole rule is about. */
const stillReaches = (s: Story): boolean =>
  tryGit(repo, "merge-base", "--is-ancestor", s.attempt, `story/${s.slug}`);

const containsBase = (s: Story): boolean =>
  tryGit(repo, "merge-base", "--is-ancestor", "main", `story/${s.slug}`);

const refresh = (s: Story): { id: number; state: string } | null => {
  const found = choreFor(db, "refresh", "story", s.id);
  return found === null ? null : { id: found.id, state: found.state };
};

/** The shortcut: throw the branch away and put the base there instead. The check the chore
 *  is judged by passes; the story's work is gone. */
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

describe("a refresh that would leave an attempt's commit unreachable", () => {
  it("is set up with the attempt merged onto the story branch and a refresh owed", async () => {
    const s = storyCarryingAnAttempt();
    const first = await runner(new SystemAgent(() => {})).tick();

    // landDoneTasks put the attempt on the story branch and recorded the tip it merged.
    expect(first.merged).toEqual([s.task]);
    expect(stillReaches(s)).toBe(true);
    const landed = db.prepare("SELECT sha FROM landed_branch WHERE task_id = ?").get(s.task) as { sha: string };
    expect(landed.sha).toBe(s.attempt);
    // and the branch conflicts with the base, so the repair is a chore rather than inline.
    expect(containsBase(s)).toBe(false);
    expect(refresh(s)?.state).toBe("running");
  });

  it("is refused: the chore fails, and the reason names the attempt it dropped", async () => {
    const s = storyCarryingAnAttempt();
    await ticks(runner(new SystemAgent(resetsOntoTheBase)), 2);

    // The shortcut did make the check's own question true.
    expect(containsBase(s)).toBe(true);
    // It is still refused, because it got there by dropping the attempt.
    expect(stillReaches(s)).toBe(false);
    expect(refresh(s)?.state).toBe("failed");

    const why = choreRefusal(db, refresh(s)?.id ?? 0)?.why ?? "";
    expect(why).toContain(`task ${s.task}`);
    expect(why).toContain(s.attempt.slice(0, 12));
    // The verdict is about the orphaned work, not about the suite the reset also broke.
    expect(why).not.toContain("the suite is red");
  });

  it("stays refused: the next tick does not close it as 'up to date with main'", async () => {
    const s = storyCarryingAnAttempt();
    const r = runner(new SystemAgent(resetsOntoTheBase));
    await ticks(r, 2);
    expect(refresh(s)?.state).toBe("failed");

    // A reset branch contains the base by construction, so the level-triggered close would
    // read the shortcut as the world having moved and wipe the verdict off the board.
    const tick = await r.tick();

    expect(refresh(s)?.state).toBe("failed");
    expect(tick.chores).toContain(refresh(s)?.id);
    expect(choreRefusal(db, refresh(s)?.id ?? 0)?.why ?? "").toContain(`task ${s.task}`);
    const shown = board(db).chores;
    expect(shown.map((c) => c.state)).toEqual(["failed"]);
  });

  it("passes the refresh that did the work, which is the whole point of refusing the other", async () => {
    const s = storyCarryingAnAttempt();
    await ticks(runner(new SystemAgent(mergesTheBase)), 2);

    expect(containsBase(s)).toBe(true);
    expect(stillReaches(s)).toBe(true);
    expect(refresh(s)?.state).toBe("done");
  });

  it("closes a settled refresh once the branch is honestly up to date", async () => {
    const s = storyCarryingAnAttempt();
    const r = runner(new SystemAgent(mergesTheBase));
    await ticks(r, 3);

    // The other half of the rule is untouched: nothing orphaned, nothing owed.
    expect(refresh(s)?.state).toBe("done");
    expect(stillReaches(s)).toBe(true);
    expect((await r.tick()).chores).not.toContain(refresh(s)?.id);
  });
});
