import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** An agent that exits cleanly and writes nothing: the harness that died before it started,
 *  and the session that read the brief and gave up. Its tree has no commit in it. */
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

/** An agent that does the work: it writes the file its scope allows, so the attempt has a
 *  commit on the branch and the retry it spent stays spent. */
class Worker implements WorkerAdapter {
  readonly kind = "agent";
  constructor(private readonly file: string) {}
  async start(w: Work): Promise<Observation> {
    writeFileSync(join(w.worktree, this.file), "work\n");
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

let repo: string;
let db: DatabaseSync;
let task: number;

beforeEach(() => {
  repo = tmp("wecode-refund-");
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
  task = make.task(at, "send the mail", { role: "engineer", scope: { write: ["mail.ts"], tools: [] } });
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

describe("an attempt that committed nothing", () => {
  it("costs the task no retry at all", async () => {
    await runner(new Idle()).tick();

    expect(attemptsOf(task)).toBe(0);
  });

  it("is refunded every tick, so an untouched task never exhausts itself", async () => {
    db.prepare("UPDATE task SET max_retry = 2 WHERE id = ?").run(task);
    const r = runner(new Idle());

    for (let i = 0; i < 4; i += 1) {
      const tick = await r.tick();
      expect(tick.exhausted).not.toContain(task);
    }

    expect(attemptsOf(task)).toBe(0);
  });

  it("never refunds below zero", async () => {
    await runner(new Idle()).tick();
    await runner(new Idle()).tick();

    expect(attemptsOf(task)).toBe(0);
  });
});

describe("an attempt that committed", () => {
  it("spends the retry the foreman counted", async () => {
    await runner(new Worker("mail.ts")).tick();

    expect(attemptsOf(task)).toBe(1);
  });

  it("leaves the count where it is on the ticks after it", async () => {
    await runner(new Worker("mail.ts")).tick();
    const after = attemptsOf(task);

    await runner(new Worker("mail.ts")).tick();

    expect(attemptsOf(task)).toBe(after);
  });
});
