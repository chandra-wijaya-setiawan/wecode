import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Who a tick chooses is decided by the history seeded into the database, never by how long
 *  the tick took. Every assertion waits for the tick's own answer, so a busy host is slow
 *  here and nothing more. */
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

/** Succeeds having written the one file the task's scope allows, so every attempt ends on the
 *  tick that started it and the worker is free again for the next one. */
class Writer implements WorkerAdapter {
  readonly kind = "agent";
  async start(w: Work): Promise<Observation> {
    for (const f of w.scope.write) writeFileSync(join(w.worktree, f), "export const send = () => {};\n");
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
let tasks: number[];
let workers: number[];

/** An assignment that has already been and gone, on a worker, at a time. History is what the
 *  allocator now reads, so the tests write it directly rather than replaying ticks for it. */
const ended = (worker: number, at: string, phase = "succeeded"): void => {
  db.prepare(
    `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `past-${worker}-${at}-${phase}`,
    "task",
    tasks[0],
    worker,
    // A scope that overlaps no ready task's, so what a test seeds decides only who is busy.
    JSON.stringify({ write: ["elsewhere.ts"], tools: [] }),
    JSON.stringify({ tokens: 1, seconds: 1 }),
    "/tmp/gone",
    phase,
    JSON.stringify({ tokens: 0, seconds: 0 }),
    at,
    at,
  );
};

/** An assignment nobody has finished with: the worker is in a tree right now. */
const openOn = (worker: number, at: string): void => ended(worker, at, "running");

const runner = (): Runner =>
  new Runner(db, {
    // Slots wide enough that the fleet, not the slot count, is what a refusal is about.
    budget: { ...DEFAULT_BUDGET, max_open: 9 },
    repoRoot: repo,
    worktreeRoot: join(repo, ".wecode/worktrees"),
    adapters: { agent: new Writer() },
    integrationBranch: "main",
  });

/** The worker the next tick chose, or null if it chose nobody. */
const chosen = async (): Promise<number | null> => {
  const r = await runner().tick();
  if (r.allocated.created === null) return null;
  return (db.prepare("SELECT worker_id FROM assignment WHERE id = ?").get(r.allocated.created) as { worker_id: number })
    .worker_id;
};

const why = async (): Promise<string[]> => (await runner().tick()).allocated.refused.map((r) => r.why);

beforeEach(() => {
  repo = tmp("wecode-fleet-");
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

  for (const [entity, id] of [
    ["project", p],
    ["release", rel],
    ["epic", e],
    ["story", s],
    ["requirement", req],
    ["acceptance_criteria", c],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  engine.apply("acceptance_test", at, "deliver", "chief");

  // Three ready tasks and three engineers: enough fleet for a tick to have a choice, and
  // enough work for three ticks running.
  // Non-overlapping write scopes: three tasks that can run in any order, so who is chosen is
  // never decided by a scope clash.
  tasks = ["send the mail", "stamp the mail", "post the mail"].map((slug, i) => {
    const t = make.task(at, slug, { role: "engineer", scope: { write: [`mail-${i}.ts`], tools: [] } });
    engine.apply("task_test", make.taskTest(t, `${slug} called`, "script", "true"), "deliver", "chief");
    engine.apply("task", t, "start", "chief");
    return t;
  });
  workers = ["claude-1", "claude-2", "claude-3"].map((name) => make.worker(name, "engineer", "agent"));
});

describe("a free worker is picked by how long ago it finished", () => {
  it("passes over the lowest id when that worker finished most recently", async () => {
    ended(workers[0], "2026-09-18T12:00:00.000Z");
    ended(workers[1], "2026-09-18T09:00:00.000Z");
    ended(workers[2], "2026-09-18T11:00:00.000Z");

    expect(await chosen()).toBe(workers[1]);
  });

  it("prefers a worker that has never finished anything: it has waited longest of all", async () => {
    ended(workers[0], "2026-09-18T09:00:00.000Z");
    ended(workers[1], "2026-09-18T10:00:00.000Z");

    expect(await chosen()).toBe(workers[2]);
  });

  it("reads a worker's latest ending, not its first", async () => {
    // Worker 1 finished long ago and again just now; worker 2 only once, in between.
    ended(workers[0], "2026-09-17T08:00:00.000Z");
    ended(workers[0], "2026-09-18T12:00:00.000Z");
    ended(workers[1], "2026-09-18T10:00:00.000Z");
    ended(workers[2], "2026-09-18T11:00:00.000Z");

    expect(await chosen()).toBe(workers[1]);
  });

  it("counts a failed attempt as an ending: the worker was used, and is warm", async () => {
    ended(workers[0], "2026-09-18T09:00:00.000Z", "failed");
    ended(workers[1], "2026-09-18T10:00:00.000Z");
    ended(workers[2], "2026-09-18T11:00:00.000Z");

    expect(await chosen()).toBe(workers[0]);
  });

  it("breaks a tie on the lowest id, so a fleet with no history behaves as it always did", async () => {
    expect(await chosen()).toBe(workers[0]);
  });

  it("ties on an identical last ending are broken by id too", async () => {
    ended(workers[1], "2026-09-18T10:00:00.000Z");
    ended(workers[2], "2026-09-18T10:00:00.000Z");
    openOn(workers[0], "2026-09-18T12:00:00.000Z");

    expect(await chosen()).toBe(workers[1]);
  });

  it("never picks a worker with an assignment still open, however long ago it last finished", async () => {
    ended(workers[0], "2026-09-16T00:00:00.000Z");
    openOn(workers[0], "2026-09-18T12:00:00.000Z");
    ended(workers[1], "2026-09-18T11:00:00.000Z");
    ended(workers[2], "2026-09-18T11:30:00.000Z");

    expect(await chosen()).toBe(workers[1]);
  });

  it("says no worker is free when every one of them is in a tree", async () => {
    for (const w of workers) openOn(w, "2026-09-18T12:00:00.000Z");

    expect(await why()).toContain("no worker free for role engineer");
  });

  it("spreads three ticks of work across the three engineers rather than stacking worker 1", async () => {
    const picked = [await chosen(), await chosen(), await chosen()];

    expect(new Set(picked).size).toBe(3);
    expect(picked).toEqual(workers);
  });

  it("spreads them the same way with the host under load, because the order is history, not timing", async () => {
    const picked = await underLoad(async () => [await chosen(), await chosen(), await chosen()]);

    expect(picked).toEqual(workers);
  });
});
