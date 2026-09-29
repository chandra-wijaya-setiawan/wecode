import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type Observation, type WorkerAdapter, type Work, type Tick } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A task branch that will not merge into its story branch.
 *
 *  It used to be a silence: `landDoneTasks` caught the failure, recorded nothing, and the
 *  tick reported a task that simply had not merged — indistinguishable from one whose tests
 *  were still running. Nothing was recorded, so the next tick cut the story tree, ran the
 *  merge, hit the same conflict and swallowed it again, forever, at the cost of a worktree
 *  and a merge per tick.
 *
 *  So the conflict is named in the tick, with what git said; and it is remembered by the
 *  pair of tips it happened between, because two branches that have not moved conflict the
 *  same way. The merge is tried again when one of them moves, and not before. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A worker whose attempt outlives the tick it started on. It is the ordinary shape of the
 *  conflict: the task branch is cut when the attempt begins, the story branch moves under it
 *  while the attempt runs — a sibling landing, a refresh taking the base — and the merge that
 *  follows is between two branches that have both moved. */
class Slow implements WorkerAdapter {
  readonly kind = "agent";
  async start(): Promise<Observation> {
    return { phase: "running", session: "s1", spent: { tokens: 1, seconds: 1 } };
  }
  async poll(w: Work): Promise<Observation> {
    writeFileSync(join(w.worktree, "mail.ts"), "export const send = () => 'ours';\n");
    return { phase: "succeeded", session: "s1", spent: { tokens: 5, seconds: 1 }, commit: null };
  }
  async answer(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async kill(): Promise<void> {}
}

const STORY = "story/password-reset";
const TASK_BRANCH = "task/send-the-mail";

let repo: string;
let db: DatabaseSync;
let task: number;
let runner: Runner;
let storyTree: string;

beforeEach(() => {
  repo = tmp("wecode-conflict-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  const make = new Maker(db);
  const engine = new Engine(db);

  const ws = make.workspace("acme", repo);
  const p = make.project(ws, "storefront", repo);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "recovery");
  const s = make.story(e, "password reset");
  const req = make.requirement(s, "one change per link");
  const c = make.criteria(req, "emailed in 60s");
  const at = make.acceptanceTest(c, "mail arrives", "script", "test -f mail.ts");
  task = make.task(at, "send the mail", { role: "engineer", scope: { write: ["mail.ts"], tools: [] } });
  const tt = make.taskTest(task, "mailer called", "script", "true");
  make.worker("claude-1", "engineer", "agent");

  for (const [entity, id] of [["project", p], ["release", rel], ["epic", e], ["story", s], ["requirement", req], ["acceptance_criteria", c]] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");

  storyTree = join(repo, ".wecode/worktrees", "story-password-reset");
  git(repo, "worktree", "add", "-q", "-b", STORY, storyTree, "main");

  runner = new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    worktreeRoot: join(repo, ".wecode/worktrees"),
    adapters: { agent: new Slow() },
    integrationBranch: "main",
  });
});

/** Whether a merge was attempted at all: a merge cuts the story tree back, so a tree taken
 *  away and still gone is a merge that never ran. */
const dropStoryTree = (): void => git(repo, "worktree", "remove", "--force", storyTree);

/** The two ticks the conflict takes: the first cuts the task branch and starts the attempt,
 *  and between them the story branch gains its own version of the file the attempt is
 *  writing. The second tick is the one whose merge has two sides to it. */
const conflictedTick = async (): Promise<Tick> => {
  await runner.tick();
  writeFileSync(join(storyTree, "mail.ts"), "export const send = () => 'theirs';\n");
  git(storyTree, "add", "-A");
  git(storyTree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "theirs");
  return await runner.tick();
};

describe("a task merge that conflicts", () => {
  it("is named in the tick, with the branch it is on and what git said", async () => {
    const tick = await conflictedTick();

    expect(tick.merged).toEqual([]);
    expect(tick.conflicts).toHaveLength(1);
    const [conflict] = tick.conflicts;
    expect(conflict?.task).toBe(task);
    expect(conflict?.branch).toBe(TASK_BRANCH);
    expect(conflict?.story).toBe(STORY);
    expect(conflict?.why).not.toBe("");
    expect(conflict?.tips).toBe(`${git(repo, "rev-parse", TASK_BRANCH)}|${git(repo, "rev-parse", STORY)}`);
  });

  it("is not landed, and leaves the story branch where it was", async () => {
    await runner.tick();
    writeFileSync(join(storyTree, "mail.ts"), "export const send = () => 'theirs';\n");
    git(storyTree, "add", "-A");
    git(storyTree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "theirs");
    const before = git(repo, "rev-parse", STORY);

    await runner.tick();

    expect(git(repo, "rev-parse", STORY)).toBe(before);
    expect(db.prepare("SELECT count(*) AS n FROM landed_branch").get()).toEqual({ n: 0 });
  });
});

describe("the same pair of tips", () => {
  it("is not merged a second time, tick after tick", async () => {
    await conflictedTick();
    dropStoryTree();

    const second = await runner.tick();
    const third = await runner.tick();

    // No tree was cut, so no merge was run — twice over.
    expect(existsSync(storyTree)).toBe(false);
    expect(second.merged).toEqual([]);
    expect(third.merged).toEqual([]);
  });

  it("is still reported while it is still true, rather than named once and forgotten", async () => {
    const first = await conflictedTick();
    const second = await runner.tick();

    expect(second.conflicts).toEqual(first.conflicts);
  });

  it("is a daemon's own memory, so a runner that has just started looks for itself", async () => {
    await conflictedTick();
    dropStoryTree();

    const fresh = new Runner(db, {
      budget: DEFAULT_BUDGET,
      repoRoot: repo,
      worktreeRoot: join(repo, ".wecode/worktrees"),
      adapters: { agent: new Slow() },
      integrationBranch: "main",
    });
    const tick = await fresh.tick();

    expect(existsSync(storyTree)).toBe(true);
    expect(tick.conflicts).toHaveLength(1);
  });
});

describe("a tip that moves", () => {
  it("is merged again, and lands when the conflict is gone", async () => {
    const first = await conflictedTick();
    expect(first.conflicts).toHaveLength(1);

    // The story branch gives up its side of the conflict: a person, or a `merge` chore.
    git(storyTree, "reset", "--hard", "-q", "main");
    git(storyTree, "update-ref", `refs/heads/${STORY}`, "HEAD");

    const second = await runner.tick();

    expect(second.conflicts).toEqual([]);
    expect(second.merged).toEqual([task]);
    expect(git(repo, "ls-tree", "--name-only", STORY)).toContain("mail.ts");
  });
});
