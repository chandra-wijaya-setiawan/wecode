import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The refund is per branch tip, not per attempt.
 *
 *  A refund exists so a harness that died before the agent started does not spend a retry.
 *  That is one bad start, and the tip is what tells the two apart: the tip moves when an
 *  attempt commits, so a second empty attempt at the same tip is the same nothing happening
 *  twice. Refund it too and the task never exhausts — it just loops, and nobody is told. */

/** A tick spawns git and writes sqlite: how long that takes is the host's business, not the
 *  refund rule's. Every assertion below is about the attempt count a tick leaves behind, so
 *  the test waits for the tick rather than for a clock. */
vi.setConfig({ testTimeout: 0, hookTimeout: 0 });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Runs `body` with the host deliberately busy, so a verdict reached here is the verdict the
 *  test means rather than one that only holds on an idle machine. */
async function underLoad<T>(body: () => Promise<T> | T): Promise<T> {
  const spin = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ["-e", "for (;;) Math.sqrt(Math.random());"], { stdio: "ignore" }),
  );
  try {
    return await body();
  } finally {
    for (const p of spin) p.kill("SIGKILL");
  }
}

/** An agent that exits cleanly and writes nothing, so its tree has no commit in it. */
class Idle implements WorkerAdapter {
  readonly kind = "agent";
  async start(): Promise<Observation> {
    return { phase: "succeeded", session: "s1", spent: { tokens: 1, seconds: 0 }, commit: null };
  }
  async poll(w: Work): Promise<Observation> {
    return { phase: "succeeded", session: w.session ?? "s1", spent: { tokens: 0, seconds: 0 }, commit: null };
  }
  async answer(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async kill(): Promise<void> {}
}

/** An agent that writes a file its scope allows — enough to move the branch tip, not enough
 *  to pass the task test, so the task is dispatched again. */
class Worker extends Idle {
  constructor(private readonly file: string) {
    super();
  }
  override async start(w: Work): Promise<Observation> {
    writeFileSync(join(w.worktree, this.file), `${this.file}\n`);
    return { phase: "succeeded", session: "s1", spent: { tokens: 1, seconds: 0 }, commit: null };
  }
}

let repo: string;
let db: DatabaseSync;
let task: number;

beforeEach(() => {
  repo = tmp("wecode-refund-once-");
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
  const story = make.story(e, "password reset");
  const req = make.requirement(story, "one change per link");
  const c = make.criteria(req, "emailed in 60s");
  const at = make.acceptanceTest(c, "mail arrives", "script", "test -f mail.ts");
  task = make.task(at, "send the mail", { role: "engineer", scope: { write: ["mail.ts", "a.ts", "b.ts"], tools: [] } });
  const tt = make.taskTest(task, "mailer called", "script", "test -f mail.ts");
  make.worker("claude-1", "engineer", "agent");

  for (const [entity, id] of [
    ["project", p],
    ["release", rel],
    ["epic", e],
    ["story", story],
    ["requirement", req],
    ["acceptance_criteria", c],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  db.prepare("UPDATE task SET max_retry = 9 WHERE id = ?").run(task);
});

const runner = (adapter: WorkerAdapter): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    worktreeRoot: join(repo, ".wecode/worktrees"),
    adapters: { agent: adapter },
    integrationBranch: "main",
  });

const attemptsOf = (id: number): number =>
  (db.prepare("SELECT attempts FROM task WHERE id = ?").get(id) as { attempts: number }).attempts;

describe("an empty attempt at a branch tip", () => {
  it("is refunded the first time, because the harness gets one bad start", async () => {
    await runner(new Idle()).tick();

    expect(attemptsOf(task)).toBe(0);
  });

  it("is counted the second time, because nothing moved between them", async () => {
    await runner(new Idle()).tick();
    await runner(new Idle()).tick();

    expect(attemptsOf(task)).toBe(1);
  });

  it("is counted every time after that, so the task exhausts rather than loops", async () => {
    for (let i = 0; i < 5; i += 1) await runner(new Idle()).tick();

    expect(attemptsOf(task)).toBe(4);
  });

  it("reaches the retry limit, which is what puts the task in front of the operator", async () => {
    db.prepare("UPDATE task SET max_retry = 2 WHERE id = ?").run(task);

    const seen: number[] = [];
    for (let i = 0; i < 4; i += 1) seen.push(...(await runner(new Idle()).tick()).exhausted);

    expect(seen).toContain(task);
  });
});

describe("a tip that moved", () => {
  it("buys the next empty attempt a refund of its own", async () => {
    await runner(new Worker("a.ts")).tick();
    expect(attemptsOf(task)).toBe(1);

    await runner(new Idle()).tick();

    expect(attemptsOf(task)).toBe(1);
  });

  it("buys it only one, so the attempt after that is counted", async () => {
    await runner(new Worker("a.ts")).tick();
    await runner(new Idle()).tick();

    await runner(new Idle()).tick();

    expect(attemptsOf(task)).toBe(2);
  });

  it("moves again on the next commit, and the refund comes back with it", async () => {
    await runner(new Worker("a.ts")).tick();
    await runner(new Idle()).tick();
    await runner(new Idle()).tick();

    await runner(new Worker("b.ts")).tick();
    await runner(new Idle()).tick();

    expect(attemptsOf(task)).toBe(3);
  });

  it("counts the same attempts with the host under load, because a tick is awaited, not timed", async () => {
    await underLoad(async () => {
      await runner(new Worker("a.ts")).tick();
      await runner(new Idle()).tick();
      await runner(new Idle()).tick();
    });

    expect(attemptsOf(task)).toBe(2);
  });
});
