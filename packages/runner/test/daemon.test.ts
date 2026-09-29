import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, ensureChore, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Writes a file in the worktree it was given, then reports success — a worker that does
 *  the smallest real thing. */
class Writer implements WorkerAdapter {
  readonly kind = "agent";
  constructor(private readonly file = "mail.ts") {}
  async start(w: Work): Promise<Observation> {
    writeFileSync(join(w.worktree, this.file), "export const send = () => {};\n");
    return { phase: "succeeded", session: "s1", spent: { tokens: 5, seconds: 1 }, commit: null };
  }
  async poll(w: Work): Promise<Observation> {
    return { phase: "running", session: w.session ?? "", spent: { tokens: 0, seconds: 0 } };
  }
  async answer(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async kill(): Promise<void> {}
}

let repo: string;
let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let task: number;
let project: number;
let storyId: number;
let acceptanceTest: number;

beforeEach(() => {
  repo = tmp("wecode-daemon-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);

  const ws = make.workspace("acme", repo);
  const p = make.project(ws, "storefront", repo);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "recovery");
  const s = make.story(e, "password reset");
  const req = make.requirement(s, "one change per link");
  const c = make.criteria(req, "emailed in 60s");
  const at = make.acceptanceTest(c, "mail arrives", "script", "test -f mail.ts");
  task = make.task(at, "send the mail", { role: "engineer", scope: { write: ["mail.ts"], tools: [] } });
  [project, storyId, acceptanceTest] = [p, s, at];
  const tt = make.taskTest(task, "mailer called", "script", "true");
  make.worker("claude-1", "engineer", "agent");

  for (const [entity, id] of [["project", p], ["release", rel], ["epic", e], ["story", s], ["requirement", req], ["acceptance_criteria", c]] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
});

/** The runner under test, driving whichever worker the test wants — `Writer` by default. */
const runner = (agent: WorkerAdapter = new Writer()): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    worktreeRoot: join(repo, ".wecode/worktrees"),
    adapters: { agent },
    integrationBranch: "main",
  });

/** One row, typed at the call site — a `get` and its cast, which this file does a dozen times. */
const row = <T>(sql: string, ...params: (number | string)[]): T => db.prepare(sql).get(...params) as T;

describe("a tick, end to end", () => {
  it("cuts a tree, runs the work, commits it, and lets the tree go", async () => {
    const r = await runner().tick();

    expect(r.allocated.created).not.toBeNull();
    // The settling phase's own answer, reaching the report through the daemon's delegation:
    // the assignment it committed, and the task test it judged in the tree before it went.
    expect(r.committed).toEqual([r.allocated.created]);
    expect(r.scripts.passed.length).toBeGreaterThan(0);

    const a = row<{ worktree: string; commit_sha: string; phase: string }>(
      "SELECT worktree, commit_sha, phase FROM assignment WHERE id = ?",
      r.allocated.created as number,
    );
    expect(a.phase).toBe("succeeded");
    expect(a.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(a.worktree)).toBe(false);
    expect(git(repo, "ls-tree", "--name-only", "task/send-the-mail")).toContain("mail.ts");
  });

  it("lands the task on its story branch once its tests pass", async () => {
    // The tick that proves the task also lands it: settleEnded runs the task_tests before
    // landDoneTasks reads the record.
    const first = await runner().tick();

    expect((db.prepare("SELECT state FROM task WHERE id = ?").get(task) as { state: string }).state).toBe("done");
    expect(first.merged).toContain(task);
    expect(git(repo, "ls-tree", "--name-only", "story/password-reset")).toContain("mail.ts");
  });

  it("never moves the integration checkout off its branch, and never leaves it stale", async () => {
    await runner().tick();
    await runner().tick();

    // The checkout is never taken off the base — the work happens in trees of wecode's own.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // And having landed onto that base, it is brought forward rather than left showing the
    // pre-land files with the landed path staged as a deletion.
    expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain("mail.ts");
    expect(existsSync(join(repo, "mail.ts"))).toBe(true);
    expect(git(repo, "status", "--porcelain", "-uno")).toBe("");
  });
});

describe("a task branch lands once", () => {
  it("does not merge a task that is already merged, tick after tick", async () => {
    const first = await runner().tick();
    expect(first.merged).toContain(task);

    const story = "story/password-reset";
    const tip = git(repo, "rev-parse", story);

    const second = await runner().tick();
    const third = await runner().tick();

    expect(second.merged).toEqual([]);
    expect(third.merged).toEqual([]);
    // and the branch stands where the one merge left it
    expect(git(repo, "rev-parse", story)).toBe(tip);
    expect(git(repo, "rev-list", "--count", `--grep=merge task/send-the-mail`, story)).toBe("1");
  });
});

describe("a task that keeps failing stops", () => {
  it("gives up once its attempts are spent, rather than being retried forever", async () => {
    // A worker that writes the wrong thing, rather than nothing: an attempt that commits
    // nothing is refunded its retry, so only a tree with work in it spends one.
    // Fresh content every attempt, so the second attempt commits too rather than being
    // refunded for leaving the branch where it was.
    let n = 0;
    const idle: WorkerAdapter = {
      kind: "agent",
      start: async (w: Work) => {
        writeFileSync(join(w.worktree, "mail.ts"), `export const send = () => ${(n += 1)};\n`);
        return { phase: "succeeded" as const, session: "s", spent: { tokens: 1, seconds: 0 }, commit: null };
      },
      poll: async () => ({ phase: "running", session: "s", spent: { tokens: 0, seconds: 0 } }),
      answer: async () => ({ phase: "running", session: "s", spent: { tokens: 0, seconds: 0 } }),
      kill: async () => {},
    };
    db.prepare("UPDATE task SET max_retry = 2 WHERE id = ?").run(task);
    db.prepare("UPDATE task_test SET artefact = 'test -f never.ts' WHERE parent_id = ?").run(task);

    const r = runner(idle);

    // the attempt ends cleanly and proves nothing, so the task is tried again
    await r.tick();
    const after = row<{ state: string; attempts: number }>("SELECT state, attempts FROM task WHERE id = ?", task);
    expect(after).toEqual({ state: "ready", attempts: 1 });

    const second = await r.tick();
    expect(second.exhausted).toContain(task);
    expect((db.prepare("SELECT state FROM task WHERE id = ?").get(task) as { state: string }).state).toBe("failed");

    const third = await r.tick();
    expect(third.allocated.created).toBeNull();
  });
});

/** A second ready task in the same story, with a scope of its own so it collides with
 *  nothing. Returns its id. */
function secondTask(file: string): number {
  const make2 = new Maker(db);
  const e2 = new Engine(db);
  const c = (db.prepare("SELECT id FROM acceptance_criteria LIMIT 1").get() as { id: number }).id;
  const at = make2.acceptanceTest(c, `${file} arrives`, "script", `test -f ${file}`);
  e2.apply("acceptance_test", at, "deliver", "chief");
  const t = make2.task(at, `write ${file}`, { role: "engineer", scope: { write: [file], tools: [] } });
  const tt = make2.taskTest(t, "unit", "script", "true");
  e2.apply("task_test", tt, "deliver", "chief");
  e2.apply("task", t, "start", "chief");
  return t;
}

const refusalFor = (id: number): string | undefined =>
  (db.prepare("SELECT why FROM refusal WHERE task_id = ?").get(id) as { why: string } | undefined)?.why;

/** The task an assignment was cut for. */
const objectiveOf = (assignment: number | null): number =>
  row<{ objective_id: number }>("SELECT objective_id FROM assignment WHERE id = ?", assignment as number).objective_id;

describe("the allocator's choice is the one that gets a tree", () => {
  it("starts the task fresh_first chose, rather than deadlocking on the lowest id", async () => {
    // The 14 Sep instance: a free worker, two ready tasks, and a retry with the lower id.
    db.prepare("UPDATE task SET attempts = 1 WHERE id = ?").run(task);
    const fresh = secondTask("other.ts");
    expect(task).toBeLessThan(fresh);

    const r = await runner().tick();

    expect(r.allocated.created).not.toBeNull();
    expect(objectiveOf(r.allocated.created)).toBe(fresh);
    // and nothing on the board claims there was no worker, because there was one
    const reasons = (db.prepare("SELECT why FROM refusal").all() as unknown as { why: string }[]).map((x) => x.why);
    expect(reasons.join()).not.toContain("no worker free");
  });

  it("says why about the task it could not place, and about no other", async () => {
    // One worker, and the fresh task needs a role nobody fills.
    db.prepare("UPDATE task SET attempts = 1 WHERE id = ?").run(task);
    const fresh = secondTask("other.ts");
    db.prepare("UPDATE task SET role = 'designer' WHERE id = ?").run(fresh);

    const r = await runner().tick();

    expect(refusalFor(fresh)).toBe("no worker free for role designer");
    // the engineer was free, so the pass did not stall: the other task ran
    expect(objectiveOf(r.allocated.created)).toBe(task);
    expect(refusalFor(task)).toBeUndefined();
  });

  it("drops a reason that no longer holds rather than leaving it on the board", async () => {
    const other = secondTask("other.ts");
    const { recordRefusal } = await import("@wecode/core");
    recordRefusal(db, "no worker free for role engineer", other);
    // it is no longer ready, so nothing can be refusing it any more
    db.prepare("UPDATE task SET attempts = max_retry WHERE id = ?").run(other);
    expect(new Engine(db).apply("task", other, "give_up", "runner").ok).toBe(true);

    await runner().tick();

    expect(refusalFor(other)).toBeUndefined();
  });
});

describe("a refused task says why on the board", () => {
  it("records the reason while the collision lasts", async () => {
    const { board, Engine: E, Maker: M } = await import("@wecode/core");

    /** Stays running, so its scope stays held. */
    const busy: WorkerAdapter = {
      kind: "agent",
      start: async () => ({ phase: "running", session: "s", spent: { tokens: 0, seconds: 0 } }),
      poll: async () => ({ phase: "running", session: "s", spent: { tokens: 0, seconds: 0 } }),
      answer: async () => ({ phase: "running", session: "s", spent: { tokens: 0, seconds: 0 } }),
      kill: async () => {},
    };

    const make2 = new M(db);
    const e2 = new E(db);
    const at = (db.prepare("SELECT id FROM acceptance_test LIMIT 1").get() as { id: number }).id;
    const other = make2.task(at, "also edit mail", { role: "engineer", scope: { write: ["mail.ts"], tools: [] } });
    const tt = make2.taskTest(other, "unit", "script", "true");
    e2.apply("task_test", tt, "deliver", "chief");
    e2.apply("task", other, "start", "chief");
    make2.worker("claude-2", "engineer", "agent");

    const r = runner(busy);

    await r.tick(); // starts one of them, and it stays running
    await r.tick(); // the other now collides with the scope it holds

    const queued = board(db).queued;
    expect(queued.some((row) => row.detail.includes("overlaps"))).toBe(true);
  });
});

/** Four of the tick's phases live under `src/tick` now, one module each. The shape of that
 *  move — what each module exports, what it took and what it left behind — is pinned in
 *  `tick.test.ts`, which is a read of the source text and needs no repository. What is
 *  pinned here is the half a grep cannot see: that the tick still reaches each phase and
 *  still reports what it answers, proved through the daemon's delegation and nothing else. */
describe("each phase's answer still reaches the tick", () => {
  it("reports the red-at-base phase's answer", async () => {
    // The fixture's acceptance test fails at the seed commit, which is the whole point of
    // the phase: it is proven red there, by the module the daemon now delegates to.
    expect((await runner().tick()).redAtBase).toEqual({ proven: [1], unproven: [] });
  });

  it("leaves a story the proving phase will not judge unjudged, and says what it waits on", async () => {
    // A story whose refresh is still owed is not judged, and says which repair it waits on.
    // That is the moved pass's first rule, reached only through the daemon's delegation.
    const chore = ensureChore(db, {
      project_id: project,
      kind: "refresh",
      target_type: "story",
      target_id: storyId,
      check: "the tree contains the base",
    });

    const tick = await runner().tick();

    const why = `waiting on its refresh: chore #${chore.id} is ${chore.state}`;
    expect(tick.waiting).toEqual([{ story: storyId, why }]);
    expect(tick.behind).toContainEqual({ story: storyId, why });
    // Nothing was judged under it. Read off the row rather than off `tick.scripts`, which
    // is the settle pass's task_test verdicts and this pass's in one list.
    const row = db.prepare("SELECT state FROM acceptance_test WHERE id = ?").get(acceptanceTest) as { state: string };
    expect(row.state).toBe("ready");
  });

  it("judges the story's acceptance tests in the story tree when nothing is owed", async () => {
    // No refresh chore, so the pass reaches the examiner: the task lands `mail.ts` on the
    // story branch and the story's `test -f mail.ts` passes in the tree the pass refreshed.
    const tick = await runner().tick();

    expect(tick.waiting).toEqual([]);
    expect(tick.behind).toEqual([]);
    expect(tick.scripts.passed).toContain(acceptanceTest);
  });

  /** `refresh` is an in_progress story's chore alone, and the fixture's one acceptance test
   *  passes on the first tick, which delivers the story. A second acceptance test that never
   *  passes keeps it in flight, which is the state the rule is about: the tree wecode is
   *  judging in right now. */
  const secondCheckThatFails = (): void => {
    const criteria = (
      db.prepare("SELECT parent_id FROM acceptance_test WHERE id = ?").get(acceptanceTest) as { parent_id: number }
    ).parent_id;
    const at = make.acceptanceTest(criteria, "and a receipt is filed", "script", "test -f receipt.ts");
    engine.apply("acceptance_test", at, "deliver", "chief");
  };

  /** Puts the story's branch behind a base it cannot take: both sides add `mail.ts`, so the
   *  refresh the proving pass attempts conflicts and the chores phase is owed the repair. */
  const baseMovesAgainstTheBranch = (): void => {
    writeFileSync(join(repo, "mail.ts"), "export const send = () => 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a different mail");
  };

  it("raises the story-chores phase's chore with the proving pass's sentence, and closes it", async () => {
    // The first tick lands `mail.ts` on the story branch. Then the base takes a different
    // `mail.ts`, so the story's tree is behind a base it cannot take: the proving pass
    // reports it `behind` with the conflict, and this phase is what puts that on the board.
    secondCheckThatFails();
    await runner().tick();
    baseMovesAgainstTheBranch();

    const tick = await runner().tick();

    const chore = row<{ id: number; kind: string; check: string }>(
      `SELECT id, kind, "check" FROM chore WHERE target_type = 'story' AND target_id = ?`,
      storyId,
    );
    expect(chore.kind).toBe("refresh");
    expect(chore.check).toBe("the base is an ancestor of the branch");
    // The tick reports it as owed, which is the pass's return value reaching the report
    // through the daemon's delegation and nothing else.
    expect(tick.chores).toContain(chore.id);
    // And the pass was handed the proving pass's `behind`, which is the argument the
    // daemon's one call site passes and the only thing the two phases share.
    expect(tick.behind).toContainEqual({ story: storyId, why: expect.stringContaining("will not take it") });

    // And it closes once the repair is made. By hand, in the story's own tree, the way a
    // chore's worker would: the conflict resolved, and the base an ancestor afterwards.
    const tree = join(repo, ".wecode/worktrees/story-password-reset");
    git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "merge", "-q", "-m", "take main", "-X", "ours", "main");

    await runner().tick();

    expect(row<{ state: string }>("SELECT state FROM chore WHERE id = ?", chore.id).state).toBe("done");
  });

  /** The refund is the half of the settling phase no other test here reaches: a worker that
   *  writes nothing commits nothing, and the retry the foreman counted comes back. */
  it("refunds the attempt an empty run used", async () => {
    const idle: WorkerAdapter = {
      kind: "agent",
      start: async () => ({ phase: "succeeded", session: "s1", spent: { tokens: 1, seconds: 1 }, commit: null }),
      poll: async () => ({ phase: "running", session: "s1", spent: { tokens: 0, seconds: 0 } }),
      answer: async () => ({ phase: "running", session: "s1", spent: { tokens: 0, seconds: 0 } }),
      kill: async () => {},
    };
    const tick = await runner(idle).tick();

    expect(tick.committed).toEqual([]);
    expect(row<{ attempts: number }>("SELECT attempts FROM task WHERE id = ?", task).attempts).toBe(0);
  });
});
