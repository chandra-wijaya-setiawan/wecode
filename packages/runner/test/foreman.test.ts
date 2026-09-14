import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import {
  ClaudeCodeAdapter,
  Foreman,
  type Observation,
  type WorkerAdapter,
  type Work,
} from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** An adapter that reports whatever the test queued, so the foreman can be exercised
 *  without a harness. */
class Fake implements WorkerAdapter {
  readonly kind = "agent";
  readonly seen: string[] = [];
  /** Every Work handed over, so a test can read what the foreman built. */
  readonly work: Work[] = [];
  constructor(private readonly script: Observation[]) {}
  private next(): Observation {
    return this.script.shift() ?? { phase: "failed", session: null, spent: spent(), reason: "other" };
  }
  async start(w: Work): Promise<Observation> {
    this.seen.push(`start:${w.id}`);
    this.work.push(w);
    return this.next();
  }
  async poll(w: Work): Promise<Observation> {
    this.seen.push(`poll:${w.id}`);
    return this.next();
  }
  async resume(w: Work): Promise<Observation> {
    this.seen.push(`resume:${w.id}:${w.session ?? ""}`);
    return this.next();
  }
  async answer(w: Work, a: string): Promise<Observation> {
    this.seen.push(`answer:${w.id}:${a}`);
    return this.next();
  }
  async kill(w: Work): Promise<void> {
    this.seen.push(`kill:${w.id}`);
  }
}

const spent = () => ({ tokens: 10, seconds: 1 });

let db: DatabaseSync;
let make: Maker;
let task: number;
let worker: number;

const assign = (worktree = "/tmp/wecode-no-such-worktree"): number =>
  make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree,
  });

/** A worktree that is really on disk, so `resume` is reachable. */
const worktreeDir = (): string => tmp("wecode-wt-");

const phaseOf = (id: number): string =>
  (db.prepare("SELECT phase FROM assignment WHERE id = ?").get(id) as { phase: string }).phase;

beforeEach(() => {
  db = open(join(tmp("wecode-foreman-"), "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", "/acme");
  const p = make.project(ws, "s", "/r");
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  const s = make.story(e, "s");
  const req = make.requirement(s, "r");
  const c = make.criteria(req, "c");
  const at = make.acceptanceTest(c, "proof", "script", "bash x.sh");
  task = make.task(at, "send the mail", { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  worker = make.worker("claude-1", "engineer", "agent");
});

describe("the foreman", () => {
  it("starts a pending assignment and records the session", () => {
    const id = assign();
    const fake = new Fake([{ phase: "running", session: "sess-1", spent: spent() }]);
    return new Foreman(db, { agent: fake }).tick().then((r) => {
      expect(r.started).toEqual([id]);
      expect(phaseOf(id)).toBe("running");
      const row = db.prepare("SELECT session, spent FROM assignment WHERE id = ?").get(id) as {
        session: string;
        spent: string;
      };
      expect(row.session).toBe("sess-1");
      expect(JSON.parse(row.spent)).toEqual(spent());
    });
  });

  it("carries a question to waiting, and does not poll while nobody has answered", async () => {
    const id = assign();
    const fake = new Fake([
      { phase: "running", session: "s", spent: spent() },
      {
        phase: "waiting",
        session: "s",
        spent: spent(),
        kind: "approval",
        question: "may I force push?",
        options: [],
      },
    ]);
    const foreman = new Foreman(db, { agent: fake });
    await foreman.tick();
    await foreman.tick();
    expect(phaseOf(id)).toBe("waiting");

    fake.seen.length = 0;
    await foreman.tick();
    expect(fake.seen).toEqual([]);
  });

  it("resumes once an answer is on the record", async () => {
    const id = assign();
    const fake = new Fake([
      { phase: "running", session: "s", spent: spent() },
      { phase: "waiting", session: "s", spent: spent(), kind: "input", question: "which port?", options: [] },
      { phase: "succeeded", session: "s", spent: spent(), commit: "abc123" },
    ]);
    const foreman = new Foreman(db, { agent: fake });
    await foreman.tick();
    await foreman.tick();
    db.prepare("UPDATE assignment SET answer = ?, answered_by = ? WHERE id = ?").run("8080", "operator", id);
    await foreman.tick();
    expect(phaseOf(id)).toBe("succeeded");
    expect(fake.seen.some((s) => s.startsWith("answer:"))).toBe(true);
  });

  it("counts a failed attempt against the task, and does not fail the task itself", async () => {
    const id = assign();
    const fake = new Fake([{ phase: "failed", session: null, spent: spent(), reason: "out_of_scope" }]);
    await new Foreman(db, { agent: fake }).tick();

    expect(phaseOf(id)).toBe("failed");
    const t = db.prepare("SELECT attempts, state FROM task WHERE id = ?").get(task) as {
      attempts: number;
      state: string;
    };
    expect(t.attempts).toBe(1);
    expect(t.state).toBe("planned");
  });

  it("treats an adapter that throws as lost rather than letting the tick die", async () => {
    const id = assign();
    const broken: WorkerAdapter = {
      kind: "agent",
      start: () => Promise.reject(new Error("no such binary")),
      poll: () => Promise.reject(new Error("no")),
      resume: () => Promise.reject(new Error("no")),
      answer: () => Promise.reject(new Error("no")),
      kill: () => Promise.resolve(),
    };
    const r = await new Foreman(db, { agent: broken }).tick();
    expect(r.failed).toEqual([id]);
    const row = db.prepare("SELECT reason FROM assignment WHERE id = ?").get(id) as { reason: string };
    expect(row.reason).toBe("lost");
  });

  it("kills an attempt that outran its deadline", async () => {
    const id = assign();
    const fake = new Fake([{ phase: "running", session: "s", spent: spent() }]);
    const foreman = new Foreman(db, { agent: fake }, 0);
    await foreman.tick();
    await foreman.tick();
    expect(phaseOf(id)).toBe("failed");
    const row = db.prepare("SELECT reason FROM assignment WHERE id = ?").get(id) as { reason: string };
    expect(row.reason).toBe("timeout");
    expect(fake.seen).toContain(`kill:${id}`);
  });
});

describe("a session that finishes in one call", () => {
  it("is recorded as having run, not left pending", async () => {
    const id = assign();
    const fake = new Fake([{ phase: "succeeded", session: "s", spent: spent(), commit: "abc" }]);
    await new Foreman(db, { agent: fake }).tick();
    expect(phaseOf(id)).toBe("succeeded");
    const row = db.prepare("SELECT session, commit_sha FROM assignment WHERE id = ?").get(id) as {
      session: string;
      commit_sha: string;
    };
    expect(row.session).toBe("s");
    expect(row.commit_sha).toBe("abc");
    const n = db.prepare("SELECT count(*) AS n FROM ledger WHERE entity = 'assignment'").get() as { n: number };
    expect(n.n).toBe(2); // start, then finish — the attempt is on the record as having run
  });

  it("asks in the same call it started in", async () => {
    const id = assign();
    const fake = new Fake([
      { phase: "waiting", session: "s", spent: spent(), kind: "approval", question: "ok?", options: [] },
    ]);
    await new Foreman(db, { agent: fake }).tick();
    expect(phaseOf(id)).toBe("waiting");
  });
});

describe("what carries between attempts", () => {
  /** Put the task where a retry would find it: n attempts made, and the last assignment
   *  ended with a reason and a commit that is on the branch. */
  const afterAnAttempt = (attempts: number, reason: string, sha: string | null): number => {
    const prev = assign();
    db.prepare("UPDATE assignment SET phase = 'failed', reason = ?, commit_sha = ? WHERE id = ?").run(
      reason,
      sha,
      prev,
    );
    db.prepare("UPDATE task SET attempts = ? WHERE id = ?").run(attempts, task);
    return prev;
  };

  const failing = (statement: string, output: string | null): number => {
    const id = make.taskTest(task, statement, "script", "bash t.sh");
    db.prepare("UPDATE task_test SET state = 'failed', last_output = ? WHERE id = ?").run(output, id);
    return id;
  };

  const startAndTakeWork = async (): Promise<Work> => {
    const fake = new Fake([{ phase: "running", session: "s", spent: spent() }]);
    await new Foreman(db, { agent: fake }).tick();
    return fake.work[fake.work.length - 1] as Work;
  };

  it("gives a first attempt no history at all", async () => {
    assign();
    const work = await startAndTakeWork();
    expect(work.history).toBeNull();
  });

  it("tells a retry how many attempts were made, and how the last one ended", async () => {
    afterAnAttempt(1, "out_of_scope", "deadbee");
    assign();
    const work = await startAndTakeWork();
    expect(work.history?.attempts).toBe(1);
    expect(work.history?.reason).toBe("out_of_scope");
    expect(work.history?.commit).toBe("deadbee");
  });

  it("reads the previous assignment, not this one", async () => {
    afterAnAttempt(2, "timeout", "cafe01");
    const id = assign();
    const work = await startAndTakeWork();
    expect(work.id).toBe(id);
    expect(work.history?.commit).toBe("cafe01");
    expect(work.history?.attempts).toBe(2);
  });

  it("carries the last non-empty line of each failed task_test", async () => {
    afterAnAttempt(1, "other", "abc123");
    failing("the mail is sent", "running...\nExpected 1 mail, got 0\n\n");
    failing("the mail is addressed", "AssertionError: no recipient\n");
    make.taskTest(task, "the mail is signed", "script", "bash t.sh"); // planned, not failed
    assign();
    const work = await startAndTakeWork();
    expect(work.history?.failures).toEqual([
      { statement: "the mail is sent", line: "Expected 1 mail, got 0" },
      { statement: "the mail is addressed", line: "AssertionError: no recipient" },
    ]);
  });

  it("still names a failing test that said nothing", async () => {
    afterAnAttempt(1, "other", null);
    failing("the mail is sent", null);
    assign();
    const work = await startAndTakeWork();
    expect(work.history?.failures).toEqual([{ statement: "the mail is sent", line: "" }]);
    expect(work.history?.commit).toBeNull();
  });

  it("gives no history to an assignment that is not on a task", async () => {
    db.prepare("UPDATE task SET attempts = 3 WHERE id = ?").run(task);
    const id = make.assignment({
      objective_type: "task_test",
      objective_id: failing("the mail is sent", "boom"),
      worker_id: worker,
      scope: { write: ["src/**"], tools: ["bash"] },
      budget: { tokens: 100, seconds: 10 },
      worktree: "/tmp/wt",
    });
    const work = await startAndTakeWork();
    expect(work.id).toBe(id);
    expect(work.history).toBeNull();
  });
});

describe("the prompt a retry is given", () => {
  const promptOf = (work: Work): string =>
    (new ClaudeCodeAdapter() as unknown as { prompt(w: Work): string }).prompt(work);

  const work = (history: Work["history"]): Work => ({
    id: 1,
    objective_type: "task",
    objective_id: task,
    instruction: "send the mail",
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree: "/tmp/wt",
    session: null,
    history,
  });

  it("is exactly today's prompt on a first attempt", () => {
    expect(promptOf(work(null))).toBe(
      [
        "send the mail",
        "",
        "You may change only: src/**.",
        "Write the tests that prove this work, and run them.",
        "If you need a decision from a person, say so and stop rather than guessing.",
      ].join("\n"),
    );
  });

  it("names the commit already on the branch", () => {
    const out = promptOf(
      work({ attempts: 1, reason: "out_of_scope", commit: "deadbee", failures: [] }),
    );
    expect(out).toContain("## What happened before");
    expect(out).toContain("attempt 2");
    expect(out).toContain("deadbee");
    expect(out).toContain("git show deadbee");
    expect(out).toContain("out_of_scope");
  });

  it("lists what is still failing, and says so when nothing was committed", () => {
    const out = promptOf(
      work({
        attempts: 2,
        reason: "timeout",
        commit: null,
        failures: [{ statement: "the mail is sent", line: "Expected 1 mail, got 0" }],
      }),
    );
    expect(out).toContain("2 have already been made");
    expect(out).toContain("left no commit");
    expect(out).toContain("- the mail is sent — Expected 1 mail, got 0");
  });

  it("keeps the original instruction and scope first", () => {
    const out = promptOf(work({ attempts: 1, reason: null, commit: "abc", failures: [] }));
    expect(out.startsWith("send the mail\n\nYou may change only: src/**.")).toBe(true);
    expect(out).not.toContain("It ended:");
  });
});

/** 14 Sep: a restart left two assignments open. The deadline was judged before the poll, so
 *  both were called timeouts and begun again from nothing — though both rows held a session
 *  id and both worktrees were still there. */
describe("an assignment the adapter has never heard of", () => {
  it("is lost rather than timed out, whatever the deadline says", async () => {
    const id = assign(worktreeDir());
    const fake = new Fake([
      { phase: "running", session: "sess-1", spent: spent() },
      { phase: "failed", session: "sess-1", spent: spent(), reason: "lost" },
      { phase: "running", session: "sess-1", spent: spent() },
    ]);
    // Zero deadline: every open row is overdue, which is exactly the restart's shape.
    const foreman = new Foreman(db, { agent: fake }, 0);
    await foreman.tick();
    await foreman.tick();

    expect(fake.seen).toContain(`resume:${id}:sess-1`);
    expect(fake.seen).not.toContain(`kill:${id}`);
    expect(phaseOf(id)).toBe("running");
    const row = db.prepare("SELECT reason FROM assignment WHERE id = ?").get(id) as { reason: string | null };
    expect(row.reason).toBeNull();
  });

  it("is resumed, not restarted: no second attempt is counted", async () => {
    assign(worktreeDir());
    const fake = new Fake([
      { phase: "running", session: "sess-1", spent: spent() },
      { phase: "failed", session: "sess-1", spent: spent(), reason: "lost" },
      { phase: "succeeded", session: "sess-1", spent: spent(), commit: "abc" },
    ]);
    const foreman = new Foreman(db, { agent: fake });
    await foreman.tick();
    await foreman.tick();

    expect(fake.seen.filter((s) => s.startsWith("start:"))).toHaveLength(1);
    const t = db.prepare("SELECT attempts FROM task WHERE id = ?").get(task) as { attempts: number };
    expect(t.attempts).toBe(1);
  });

  it("fails when the harness cannot reattach and says so", async () => {
    const id = assign(worktreeDir());
    const fake = new Fake([
      { phase: "running", session: "sess-1", spent: spent() },
      { phase: "failed", session: "sess-1", spent: spent(), reason: "lost" },
      // A harness with no --resume: asked anyway, it answers lost.
      { phase: "failed", session: "sess-1", spent: spent(), reason: "lost" },
    ]);
    const foreman = new Foreman(db, { agent: fake });
    await foreman.tick();
    const r = await foreman.tick();

    expect(fake.seen).toContain(`resume:${id}:sess-1`);
    expect(r.failed).toEqual([id]);
    expect(phaseOf(id)).toBe("failed");
    const row = db.prepare("SELECT reason FROM assignment WHERE id = ?").get(id) as { reason: string };
    expect(row.reason).toBe("lost");
  });

  it("is not offered for resume once its worktree has gone", async () => {
    const wt = worktreeDir();
    const id = assign(wt);
    const fake = new Fake([
      { phase: "running", session: "sess-1", spent: spent() },
      { phase: "failed", session: "sess-1", spent: spent(), reason: "lost" },
    ]);
    const foreman = new Foreman(db, { agent: fake });
    await foreman.tick();
    rmSync(wt, { recursive: true, force: true });
    await foreman.tick();

    expect(fake.seen.some((s) => s.startsWith("resume:"))).toBe(false);
    expect(phaseOf(id)).toBe("failed");
    const row = db.prepare("SELECT reason FROM assignment WHERE id = ?").get(id) as { reason: string };
    expect(row.reason).toBe("lost");
  });

  it("is not offered for resume when no session was ever recorded", async () => {
    const id = assign(worktreeDir());
    const fake = new Fake([
      { phase: "running", session: "", spent: spent() },
      { phase: "failed", session: null, spent: spent(), reason: "lost" },
    ]);
    const foreman = new Foreman(db, { agent: fake });
    await foreman.tick();
    await foreman.tick();

    expect(fake.seen.some((s) => s.startsWith("resume:"))).toBe(false);
    expect(phaseOf(id)).toBe("failed");
  });
});

describe("a session that keeps running", () => {
  it("does not hold the tick: a second assignment starts on the next one", async () => {
    /** Starts, reports running, and never finishes — a real agent mid-task. */
    const busy: WorkerAdapter = {
      kind: "agent",
      start: async () => ({ phase: "running", session: "s", spent: spent() }),
      poll: async () => ({ phase: "running", session: "s", spent: spent() }),
      resume: async () => ({ phase: "running", session: "s", spent: spent() }),
      answer: async () => ({ phase: "running", session: "s", spent: spent() }),
      kill: async () => {},
    };
    const a = assign();
    const b = assign();
    const foreman = new Foreman(db, { agent: busy });

    const first = await foreman.tick();
    expect(first.started.sort()).toEqual([a, b].sort());
    expect(phaseOf(a)).toBe("running");
    expect(phaseOf(b)).toBe("running");
  });
});
