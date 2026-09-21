import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { board, Engine, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { run as cli } from "../../cli/src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Does the work and reports failure: the shape of the three tasks that sat at 3 of 3.
 *
 *  It writes before it fails. An attempt that commits nothing has its retry refunded, so a
 *  worker that touches the tree is the only one whose failures ever reach the limit. */
class Loser implements WorkerAdapter {
  readonly kind = "agent";
  async start(w: Work): Promise<Observation> {
    writeFileSync(join(w.worktree, "mail.ts"), `half a mailer, attempt ${w.id}\n`);
    return { phase: "failed", session: "s1", spent: { tokens: 5, seconds: 1 }, commit: null, reason: "no mail" };
  }
  async poll(w: Work): Promise<Observation> {
    return { phase: "failed", session: w.session ?? "", spent: { tokens: 0, seconds: 0 }, reason: "no mail" };
  }
  async answer(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async kill(): Promise<void> {}
}

let repo: string;
let db: DatabaseSync;
let task: number;
let story: number;
let wasDb: string | undefined;

beforeEach(() => {
  repo = tmp("wecode-exhausted-");
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
  story = make.story(e, "password reset");
  const req = make.requirement(story, "one change per link");
  const c = make.criteria(req, "emailed in 60s");
  const at = make.acceptanceTest(c, "mail arrives", "script", "test -f mail.ts");
  task = make.task(at, "send the mail", { role: "engineer", scope: { write: ["mail.ts"], tools: [] } });
  const tt = make.taskTest(task, "mailer called", "script", "false");
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

  // The operator command talks to whichever workspace it is pointed at.
  wasDb = process.env["WECODE_DB"];
  process.env["WECODE_DB"] = join(repo, "wecode.db");
});

afterEach(() => {
  if (wasDb === undefined) delete process.env["WECODE_DB"];
  else process.env["WECODE_DB"] = wasDb;
});

const runner = (): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    adapters: { agent: new Loser() },
    integrationBranch: "main",
  });

const stateOf = (id: number): string =>
  (db.prepare("SELECT state FROM task WHERE id = ?").get(id) as { state: string }).state;

const attemptsOf = (id: number): number =>
  (db.prepare("SELECT attempts FROM task WHERE id = ?").get(id) as { attempts: number }).attempts;

/** Puts the task where the three of them were: every attempt used, and stopped. */
const exhaust = (): void => {
  db.prepare("UPDATE task SET attempts = max_retry WHERE id = ?").run(task);
  expect(new Engine(db).apply("task", task, "give_up", "runner").ok).toBe(true);
};

describe("a task that has used every attempt", () => {
  it("is reported as drift, naming the story that is still waiting on it", async () => {
    exhaust();

    const r = await runner().tick();

    expect(r.drift.map((d) => d.task)).toEqual([task]);
    const [only] = r.drift;
    expect(only?.story).toBe("password-reset");
    expect(only?.why).toContain("3 of 3 attempts used");
    expect(only?.why).toContain("password-reset");
    expect(only?.why).toContain("wecode task retry");
  });

  it("is named on the tick that exhausts it, not a tick later", async () => {
    // One attempt short of the limit, so the tick itself is what uses the last one.
    db.prepare("UPDATE task SET max_retry = 1 WHERE id = ?").run(task);

    const r = await runner().tick();

    expect(attemptsOf(task)).toBe(1);
    expect(r.exhausted).toContain(task);
    expect(stateOf(task)).toBe("failed");
    expect(r.drift.map((d) => d.task)).toEqual([task]);
  });

  it("is not drift once its story is closed: nothing is waiting on it", async () => {
    exhaust();
    db.prepare("UPDATE story SET state = 'dropped' WHERE id = ?").run(story);

    expect((await runner().tick()).drift).toEqual([]);
  });

  it("is not drift once it is dropped: abandoning it was a decision", async () => {
    exhaust();
    expect(new Engine(db).apply("task", task, "drop", "operator").ok).toBe(true);

    expect((await runner().tick()).drift).toEqual([]);
  });
});

describe("the runner never retries by itself", () => {
  it("leaves an exhausted task failed, tick after tick, with its attempts untouched", async () => {
    exhaust();
    const attempts = attemptsOf(task);

    for (let i = 0; i < 3; i += 1) {
      const r = await runner().tick();
      // Reported every time — level-triggered, so a drift nobody has dealt with keeps saying so.
      expect(r.drift.map((d) => d.task)).toEqual([task]);
      // and never started: no attempt, no reset counter, no state back to ready
      expect(r.allocated.created).toBeNull();
      expect(stateOf(task)).toBe("failed");
      expect(attemptsOf(task)).toBe(attempts);
    }

    const verbs = (
      db.prepare("SELECT verb FROM ledger WHERE entity = 'task' AND entity_id = ?").all(task) as unknown as {
        verb: string;
      }[]
    ).map((l) => l.verb);
    expect(verbs).not.toContain("retry");
  });
});

describe("wecode task retry", () => {
  it("resets attempts to zero and returns the task to ready", () => {
    exhaust();

    expect(cli(["task", "retry", String(task), "--reason", "the flaky mail stub is fixed"])).toBe(0);

    expect(stateOf(task)).toBe("ready");
    expect(attemptsOf(task)).toBe(0);
  });

  it("is allocated again on the next tick, because zero attempts is under the limit", async () => {
    exhaust();
    cli(["task", "retry", String(task), "--reason", "the flaky mail stub is fixed"]);

    const r = await runner().tick();

    expect(r.allocated.created).not.toBeNull();
    expect(r.drift).toEqual([]);
  });

  it("refuses without a reason, and leaves the task where it was", () => {
    exhaust();

    expect(cli(["task", "retry", String(task)])).not.toBe(0);
    expect(stateOf(task)).toBe("failed");
    expect(attemptsOf(task)).toBe(3);
  });

  it("keeps the reason on the record, against the transition it explains", () => {
    exhaust();
    cli(["task", "retry", String(task), "--reason", "the flaky mail stub is fixed"]);

    const line = db
      .prepare("SELECT actor FROM ledger WHERE entity = 'task' AND entity_id = ? AND verb = 'retry'")
      .get(task) as { actor: string } | undefined;
    expect(line?.actor).toContain("the flaky mail stub is fixed");
  });

  it("refuses a task that is not failed, rather than resetting its attempts", () => {
    // ready, mid-flight: retry is not the verb for it.
    expect(cli(["task", "retry", String(task), "--reason", "impatience"])).not.toBe(0);
    expect(stateOf(task)).toBe("ready");
  });
});

describe("the board", () => {
  it("tells a dropped task from one that ran out of attempts", () => {
    exhaust();
    const make = new Maker(db);
    const engine = new Engine(db);
    const at = (db.prepare("SELECT id FROM acceptance_test LIMIT 1").get() as { id: number }).id;
    const abandoned = make.task(at, "send the letter", { role: "engineer", scope: { write: [], tools: [] } });
    engine.apply("task", abandoned, "drop", "operator");

    const b = board(db);
    const detail = (rows: readonly { id: number; detail: string }[], id: number): string =>
      rows.find((r) => r.id === id)?.detail ?? "";

    // Two boxes, not one reason: failed is what ran out of attempts, dropped is what a
    // person put down, and neither carries a row belonging to the other.
    expect(b.failed.map((r) => r.id)).toEqual([task]);
    expect(detail(b.failed, task)).toContain("out of attempts");
    expect(detail(b.failed, task)).toContain("3 of 3");
    expect(b.dropped.map((r) => r.id)).toEqual([abandoned]);
    expect(detail(b.dropped, abandoned)).toBe("dropped by decision");
    expect(detail(b.dropped, abandoned)).not.toContain("attempts");
  });
});
