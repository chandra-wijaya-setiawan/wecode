/** The runner spent a night handing work to a model it could not reach. Every tick cut a
 *  tree, started a session that died on an api error before it had a session id, spent the
 *  task's retries, and did it again a minute later — a crash loop with the machine holding
 *  the stopwatch and the API holding the bill.
 *
 *  What an api error leaves on the record is an attempt that reached nothing: failed, with
 *  no session id and no commit. Two of those in a row is the model, not the work, so
 *  dispatch stops — and says so, on the board and in the log, rather than going quiet. */
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

const ZERO = { tokens: 0, seconds: 0 };

/** The harness that could not reach the model: it exits before the session exists, so the
 *  attempt ends failed with nothing to name it by. */
class Unreachable implements WorkerAdapter {
  readonly kind = "agent";
  async start(): Promise<Observation> {
    return { phase: "failed", session: null, spent: ZERO, reason: "other" };
  }
  async poll(): Promise<Observation> {
    return { phase: "failed", session: null, spent: ZERO, reason: "other" };
  }
  async answer(): Promise<Observation> {
    return this.poll();
  }
  async kill(): Promise<void> {}
}

/** A session that got through. It writes nothing, so the attempt is still empty — what is
 *  different is the session id, which is the model having answered at all. */
class Reached implements WorkerAdapter {
  readonly kind = "agent";
  async start(): Promise<Observation> {
    return { phase: "succeeded", session: "s1", spent: { tokens: 1, seconds: 0 }, commit: null };
  }
  async poll(w: Work): Promise<Observation> {
    return { phase: "succeeded", session: w.session ?? "s1", spent: ZERO, commit: null };
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
  repo = tmp("wecode-unreachable-");
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

const attempts = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM assignment").get() as { n: number }).n;

/** Put every attempt an hour in the past, which is how the pause's wait is passed without
 *  a test that waits. The column is the one the pause reads. */
const age = (): void => {
  const then = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE assignment SET updated_at = ?").run(then);
};

const refusal = (): string =>
  (db.prepare("SELECT why FROM refusal WHERE task_id = ?").get(task) as { why: string } | undefined)?.why ?? "";

describe("a model that cannot be reached", () => {
  it("pauses dispatch after two attempts that reached it not at all", async () => {
    const r = runner(new Unreachable());
    await r.tick();
    await r.tick();
    expect(attempts(), "two attempts were made before the pause").toBe(2);

    const third = await r.tick();

    expect(third.paused).not.toBeNull();
    expect(third.allocated.created).toBeNull();
    expect(attempts(), "a paused tick starts nothing").toBe(2);
  });

  it("says so, naming the two attempts it read", async () => {
    const r = runner(new Unreachable());
    await r.tick();
    await r.tick();

    const third = await r.tick();

    expect(third.paused).toContain("dispatch is paused");
    expect(third.paused).toContain("without reaching the model");
    expect(third.paused).toMatch(/#\d+ and #\d+/);
  });

  it("says so on the board, where the task is waiting", async () => {
    const r = runner(new Unreachable());
    await r.tick();
    await r.tick();
    const third = await r.tick();

    expect(refusal()).toBe(third.paused);
  });

  it("is not paused by one such attempt alone", async () => {
    const r = runner(new Unreachable());

    const first = await r.tick();

    expect(first.paused).toBeNull();
    expect(first.allocated.created).not.toBeNull();
  });

  it("lets one attempt through again once the pause has had its wait", async () => {
    const broken = runner(new Unreachable());
    await broken.tick();
    await broken.tick();
    expect((await broken.tick()).paused, "paused while the model is unreachable").not.toBeNull();

    age();
    const back = await runner(new Reached()).tick();

    expect(back.paused, "a pause nothing could lift would be a wedge").toBeNull();
    expect(back.allocated.created).not.toBeNull();
  });

  it("is not paused once an attempt has reached the model", async () => {
    await runner(new Unreachable()).tick();
    await runner(new Unreachable()).tick();
    age();
    await runner(new Reached()).tick();

    const next = await runner(new Unreachable()).tick();

    expect(next.paused, "the run of unreached attempts was broken").toBeNull();
  });
});
