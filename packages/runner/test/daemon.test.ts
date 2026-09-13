import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type Observation, type WorkerAdapter, type Work } from "../src/index.js";

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

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-daemon-"));
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
  const rel = make.release(p, "1.0");
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
    await runner().tick();
    const second = await runner().tick();

    expect((db.prepare("SELECT state FROM task WHERE id = ?").get(task) as { state: string }).state).toBe("done");
    expect(second.merged).toContain(task);
    expect(git(repo, "ls-tree", "--name-only", "story/password-reset")).toContain("mail.ts");
  });

  it("never touches the integration checkout", async () => {
    await runner().tick();
    await runner().tick();
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(existsSync(join(repo, "mail.ts"))).toBe(false);
  });
});

describe("a task that keeps failing stops", () => {
  it("gives up once its attempts are spent, rather than being retried forever", async () => {
    /** A worker that writes nothing, so the task_test never passes. */
    const idle: WorkerAdapter = {
      kind: "agent",
      start: async () => ({ phase: "succeeded", session: "s", spent: { tokens: 1, seconds: 0 }, commit: null }),
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
