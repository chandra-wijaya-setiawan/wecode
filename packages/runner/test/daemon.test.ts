import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const runner = (): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    worktreeRoot: join(repo, ".wecode/worktrees"),
    adapters: { agent: new Writer() },
    integrationBranch: "main",
  });

describe("a tick, end to end", () => {
  it("cuts a tree, runs the work, commits it, and lets the tree go", async () => {
    const r = await runner().tick();

    expect(r.allocated.created).not.toBeNull();
    expect(r.committed).toHaveLength(1);

    const a = db.prepare("SELECT worktree, commit_sha, phase FROM assignment WHERE id = ?").get(r.allocated.created) as {
      worktree: string;
      commit_sha: string;
      phase: string;
    };
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

    const r = new Runner(db, {
      budget: DEFAULT_BUDGET,
      repoRoot: repo,
      worktreeRoot: join(repo, ".wecode/worktrees"),
      adapters: { agent: idle },
      integrationBranch: "main",
    });

    // the attempt ends cleanly and proves nothing, so the task is tried again
    await r.tick();
    const after = db.prepare("SELECT state, attempts FROM task WHERE id = ?").get(task) as {
      state: string;
      attempts: number;
    };
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

describe("the allocator's choice is the one that gets a tree", () => {
  it("starts the task fresh_first chose, rather than deadlocking on the lowest id", async () => {
    // The 14 Sep instance: a free worker, two ready tasks, and a retry with the lower id.
    db.prepare("UPDATE task SET attempts = 1 WHERE id = ?").run(task);
    const fresh = secondTask("other.ts");
    expect(task).toBeLessThan(fresh);

    const r = await runner().tick();

    expect(r.allocated.created).not.toBeNull();
    const started = db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(r.allocated.created) as {
      objective_id: number;
    };
    expect(started.objective_id).toBe(fresh);
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
    const started = db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(r.allocated.created) as {
      objective_id: number;
    };
    expect(started.objective_id).toBe(task);
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

    const r = new Runner(db, {
      budget: DEFAULT_BUDGET,
      repoRoot: repo,
      worktreeRoot: join(repo, ".wecode/worktrees"),
      adapters: { agent: busy },
      integrationBranch: "main",
    });

    await r.tick(); // starts one of them, and it stays running
    await r.tick(); // the other now collides with the scope it holds

    const queued = board(db).queued;
    expect(queued.some((row) => row.detail.includes("overlaps"))).toBe(true);
  });
});

/** The red-at-base phase is the first of the tick's phases to move out of `daemon.ts` into a
 *  module of its own. What the phase *does* is already pinned by `red-at-base.test.ts`, which
 *  ran unchanged through this move; what is pinned here is that the move happened, that it
 *  took the whole phase and no more of it, and that nothing else went with it. */
describe("the red-at-base phase is a module of its own", () => {
  const src = (module: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/${module}`, import.meta.url)), "utf8");

  /** The source with its prose taken out. `daemon.ts` talks about `proveRedAtBase` and about
   *  the merge-base in comments, so every assertion below is made against the code. */
  const code = (module: string): string =>
    src(module).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("exports one function, and it is the phase", () => {
    const exported = [...code("tick/red-at-base.ts").matchAll(/^export (?:async )?function (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(["proveRedAtBase"]);
  });

  it("took the two helpers whole, and left neither behind", () => {
    const moved = code("tick/red-at-base.ts");
    expect(moved).toMatch(/function mergeBase\(/);
    expect(moved).toMatch(/function runAtBase\(/);
    expect(moved).toContain(`exec("git", ["merge-base", a, b]`);
    expect(moved).toContain(`exec("git", ["checkout", "--detach", "-q", at.base]`);
    expect(moved).toContain(`exec("git", ["reset", "--hard", "-q", at.base]`);

    const left = code("daemon.ts");
    expect(left).not.toMatch(/\bmergeBase\b/);
    expect(left).not.toMatch(/\brunAtBase\b/);
    expect(left).not.toContain("--detach");
    expect(left).not.toContain(`"reset"`);
    // `isAncestor` asks `merge-base --is-ancestor` for a different phase and stays put: the
    // verb is shared, the helper is not.
    expect(left.match(/"merge-base"/g)).toHaveLength(1);
    expect(left).toContain(`["merge-base", "--is-ancestor", base, branch]`);
  });

  it("is called from the daemon where the daemon called it", () => {
    const left = code("daemon.ts");
    expect(left).toContain(`import { proveRedAtBase, type RedAtBase } from "./tick/red-at-base.js"`);
    // The one call site in `tick()` is untouched, and the one wrapper is what it now reaches.
    expect(left.match(/this\.proveRedAtBase\(\)/g)).toHaveLength(1);
    expect(left.match(/\breturn proveRedAtBase\(\{/g)).toHaveLength(1);
    expect(left).toMatch(/const redAtBase = await this\.proveRedAtBase\(\);/);
  });

  /** The reads the phase shares with the rest of the runner stay the runner's: they are
   *  handed in, not copied. A second copy of `storyOfCriteria` in the new module would be
   *  the defect this asserts against. */
  it("borrows the runner's ledger reads rather than copying them", () => {
    const moved = code("tick/red-at-base.ts");
    for (const shared of ["storyOfCriteria", "projectOf", "ranAtBase", "recordBaseRun", "treesFor", "worktreeRoot"]) {
      expect(moved, `${shared} is declared again in the new module`).not.toMatch(
        new RegExp(`(?:function|const)\\s+${shared}\\b`),
      );
      expect(moved, `${shared} is not handed in`).toContain(`host.${shared}`);
    }
    // One definition of the columns, not two: the table descriptors are imported back.
    expect(moved).toMatch(/import \{ tbl.*\} from "\.\.\/daemon\.js"/);
    expect(moved).not.toContain("table<");
  });

  it("moves no other phase", () => {
    const left = code("daemon.ts");
    for (const phase of [
      "landDeliveredStories",
      "allocateOne",
      "settleEnded",
      "landDoneTasks",
      "storyChoresPass",
      "enforceRetryLimit",
      "ranAtBase",
      "recordBaseRun",
    ]) {
      expect(left, `${phase} left daemon.ts`).toMatch(new RegExp(`private (?:async )?${phase}\\(`));
    }
    // The one function, and the two types that say what it answers and what it needs.
    expect([...code("tick/red-at-base.ts").matchAll(/^export /gm)]).toHaveLength(3);
  });

  it("still reports the phase's answer on a tick", async () => {
    const r = new Runner(db, {
      budget: DEFAULT_BUDGET,
      repoRoot: repo,
      worktreeRoot: join(repo, ".wecode/worktrees"),
      adapters: { agent: new Writer() },
      integrationBranch: "main",
    });
    const tick = await r.tick();
    // The fixture's acceptance test fails at the seed commit, which is the whole point of
    // the phase: it is proven red there, by the module the daemon now delegates to.
    expect(tick.redAtBase).toEqual({ proven: [1], unproven: [] });
  });
});

/** The story-proving phase is the second of the tick's phases to leave `daemon.ts`. What the
 *  phase *does* is already pinned by `refresh-without-judging.test.ts` and the acceptance
 *  verdicts the end-to-end ticks above read, all of which ran unchanged through this move;
 *  what is pinned here is that the move happened, that it took the phase whole — the pass and
 *  the two helpers only it used — and that nothing else went with it. */
describe("the story-proving phase is a module of its own", () => {
  const src = (module: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/${module}`, import.meta.url)), "utf8");

  /** The source with its prose taken out. Both files talk about `proveStories` and about the
   *  refresh in comments, so every assertion below is made against the code. */
  const code = (module: string): string =>
    src(module).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("exports one function, and it is the phase", () => {
    const exported = [...code("tick/prove-stories.ts").matchAll(/^export (?:async )?function (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(["proveStories"]);
    // The one function, and the two types that say what it answers and what it needs.
    expect([...code("tick/prove-stories.ts").matchAll(/^export /gm)]).toHaveLength(3);
  });

  it("took the two helpers whole, and left neither behind", () => {
    const moved = code("tick/prove-stories.ts");
    expect(moved).toMatch(/function refreshStoryTree\(/);
    expect(moved).toMatch(/function midMerge\(/);
    expect(moved).toContain(`"merge", "--no-ff", "-q"`);
    expect(moved).toContain(`exec("git", ["merge", "--abort"]`);
    expect(moved).toContain(`"MERGE_HEAD"`);
    // The refresh's own constant came with it; nothing else reads it.
    expect(moved).toContain("const REFRESH_OPEN");

    const left = code("daemon.ts");
    for (const gone of ["refreshStoryTree", "midMerge", "MERGE_HEAD", "REFRESH_OPEN", "--no-ff", "--abort"]) {
      expect(left, `${gone} stayed in daemon.ts`).not.toContain(gone);
    }
  });

  it("is called from the daemon where the daemon called it", () => {
    const left = code("daemon.ts");
    expect(left).toContain(`import { proveStories, type Proven } from "./tick/prove-stories.js"`);
    // The one call site in `tick()` is untouched in its place, and the one wrapper is what
    // it now reaches.
    expect(left.match(/\breturn proveStories\(\{/g)).toHaveLength(1);
    expect(left).toMatch(/const acceptance = await this\.storyProvingPass\(\);/);
    expect(left.match(/this\.storyProvingPass\(\)/g)).toHaveLength(1);
    // And the phases either side of it in `tick()` did not move with it.
    expect(left).toMatch(/const landings = await this\.landDoneTasks\(\);/);
    expect(left).toMatch(/await this\.storyChoresPass\(acceptance\.behind\)/);
  });

  /** The reads the phase shares with the rest of the runner stay the runner's: they are
   *  handed in, not copied. A second copy of `contains` in the new module would be the
   *  defect this asserts against. */
  it("borrows the runner's ledger, trees and graph reads rather than copying them", () => {
    const moved = code("tick/prove-stories.ts");
    for (const shared of ["storyOfCriteria", "projectOf", "treesFor", "worktreeRoot", "hasCommit", "contains", "runAcceptanceTests"]) {
      expect(moved, `${shared} is declared again in the new module`).not.toMatch(
        new RegExp(`(?:function|const)\\s+${shared}\\b`),
      );
      expect(moved, `${shared} is not handed in`).toContain(`host.${shared}`);
    }
    // One definition of the columns and of the shapes the tick reports, not two.
    expect(moved).toMatch(/import \{ reasonOf, tbl.*\} from "\.\.\/daemon\.js"/);
    expect(moved).not.toContain("table<");
    expect(moved).not.toMatch(/interface (?:Behind|Waiting)\b/);
  });

  it("still reports the phase's answer on a tick", async () => {
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
    // The same tick lands the task and then proves the story, in that order.
    const tick = await runner().tick();

    expect(tick.waiting).toEqual([]);
    expect(tick.behind).toEqual([]);
    expect(tick.scripts.passed).toContain(acceptanceTest);
  });
});

/** The story-chores phase is the third of the tick's phases to leave `daemon.ts`. What the
 *  phase *does* is already pinned by `refresh-without-judging.test.ts` and
 *  `chore-refusal-owner.test.ts`, both of which ran unchanged through this move; what is
 *  pinned here is that the move happened, that it took the phase whole — the pass, the
 *  `refresh` rule and the behind-ness read only it used — and that nothing else went with it. */
describe("the story-chores phase is a module of its own", () => {
  const src = (module: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/${module}`, import.meta.url)), "utf8");

  /** The source with its prose taken out. Both files talk about `refresh` and about
   *  `followRefresh` in comments, so every assertion below is made against the code. */
  const code = (module: string): string =>
    src(module).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("exports one function, and it is the phase", () => {
    const exported = [...code("tick/story-chores.ts").matchAll(/^export (?:async )?function (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(["raiseStoryChores"]);
    // The one function, and the one type that says what it needs. What it answers is a
    // list of chore ids, which needs no shape of its own.
    expect([...code("tick/story-chores.ts").matchAll(/^export /gm)]).toHaveLength(2);
  });

  it("took the two helpers whole, and left neither behind", () => {
    const moved = code("tick/story-chores.ts");
    expect(moved).toMatch(/function followRefresh\(/);
    expect(moved).toMatch(/function isBehind\(/);
    // The rules those helpers carry came with them, not just their names.
    expect(moved).toContain(`"the base is an ancestor of the branch"`);
    expect(moved).toContain(`"the branch merges cleanly"`);
    expect(moved).toContain("is up to date with");

    const left = code("daemon.ts");
    for (const gone of ["followRefresh", "isBehind", "the base is an ancestor", "the branch merges cleanly"]) {
      expect(left, `${gone} stayed in daemon.ts`).not.toContain(gone);
    }
  });

  it("is called from the daemon where the daemon called it", () => {
    const left = code("daemon.ts");
    expect(left).toContain(`import { raiseStoryChores } from "./tick/story-chores.js"`);
    // The one call site in `tick()` is untouched in its place, and the one wrapper is what
    // it now reaches.
    expect(left.match(/\breturn raiseStoryChores\(/g)).toHaveLength(1);
    expect(left).toMatch(/const chores = await this\.storyChoresPass\(acceptance\.behind\);/);
    expect(left.match(/this\.storyChoresPass\(/g)).toHaveLength(1);
    // And the phases either side of it in `tick()` did not move with it.
    expect(left).toMatch(/const acceptance = await this\.storyProvingPass\(\);/);
    expect(left).toMatch(/const performed = await this\.performChores\(paused\);/);
  });

  /** The reads the phase shares with the rest of the runner stay the runner's: they are
   *  handed in, not copied. A second copy of `mergesCleanly` — which shells out to a trial
   *  merge in a scratch tree — in the new module would be the defect this asserts against. */
  it("borrows the runner's ledger, trees and graph reads rather than copying them", () => {
    const moved = code("tick/story-chores.ts");
    for (const shared of ["projectOf", "treesFor", "hasCommit", "contains", "mergesCleanly", "orphanedBy"]) {
      expect(moved, `${shared} is declared again in the new module`).not.toMatch(
        new RegExp(`(?:function|const)\\s+${shared}\\b`),
      );
      expect(moved, `${shared} is not handed in`).toContain(`host.${shared}`);
    }
    // One definition of the columns and of the shape the proving pass reports, not two.
    expect(moved).toMatch(/import \{ tbl.*\} from "\.\.\/daemon\.js"/);
    expect(moved).not.toContain("table<");
    expect(moved).not.toMatch(/interface Behind\b/);
  });

  it("moves no other phase", () => {
    const left = code("daemon.ts");
    for (const phase of [
      "landDeliveredStories",
      "allocateOne",
      "settleEnded",
      "landDoneTasks",
      "performChores",
      "enforceRetryLimit",
      "mergesCleanly",
      "orphanedBy",
    ]) {
      expect(left, `${phase} left daemon.ts`).toMatch(new RegExp(`private (?:async )?${phase}\\(`));
    }
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
   *  refresh the proving pass attempts conflicts and this phase is owed the repair. */
  const baseMovesAgainstTheBranch = (): void => {
    writeFileSync(join(repo, "mail.ts"), "export const send = () => 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a different mail");
  };

  it("still raises the phase's chore on a tick, with the proving pass's sentence on it", async () => {
    // The first tick lands `mail.ts` on the story branch. Then the base takes a different
    // `mail.ts`, so the story's tree is behind a base it cannot take: the proving pass
    // reports it `behind` with the conflict, and this phase is what puts that on the board.
    secondCheckThatFails();
    await runner().tick();
    baseMovesAgainstTheBranch();

    const tick = await runner().tick();

    const chore = db
      .prepare(`SELECT id, kind, state, "check" FROM chore WHERE target_type = 'story' AND target_id = ?`)
      .get(storyId) as { id: number; kind: string; state: string; check: string };
    expect(chore.kind).toBe("refresh");
    expect(chore.check).toBe("the base is an ancestor of the branch");
    // The tick reports it as owed, which is the pass's return value reaching the report
    // through the daemon's delegation and nothing else.
    expect(tick.chores).toContain(chore.id);
    // And the pass was handed the proving pass's `behind`, which is the argument the
    // daemon's one call site passes and the only thing the two phases share.
    expect(tick.behind).toContainEqual({ story: storyId, why: expect.stringContaining("will not take it") });
  });

  it("closes the chore it raised once the branch takes the base", async () => {
    secondCheckThatFails();
    await runner().tick();
    baseMovesAgainstTheBranch();
    await runner().tick();
    const chore = db.prepare("SELECT id FROM chore WHERE target_id = ? AND kind = 'refresh'").get(storyId) as {
      id: number;
    };

    // The repair is made, by hand, in the story's own tree — the way a chore's worker would
    // make it: the conflict resolved, and the base an ancestor of the branch afterwards.
    const tree = join(repo, ".wecode/worktrees/story-password-reset");
    git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "merge", "-q", "-m", "take main", "-X", "ours", "main");

    await runner().tick();

    const after = db.prepare("SELECT state FROM chore WHERE id = ?").get(chore.id) as { state: string };
    expect(after.state).toBe("done");
  });
});
