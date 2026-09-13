import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { Foreman, type Observation, type WorkerAdapter, type Work } from "../src/index.js";

/** An adapter that reports whatever the test queued, so the foreman can be exercised
 *  without a harness. */
class Fake implements WorkerAdapter {
  readonly kind = "agent";
  readonly seen: string[] = [];
  constructor(private readonly script: Observation[]) {}
  private next(): Observation {
    return this.script.shift() ?? { phase: "failed", session: null, spent: spent(), reason: "other" };
  }
  async start(w: Work): Promise<Observation> {
    this.seen.push(`start:${w.id}`);
    return this.next();
  }
  async poll(w: Work): Promise<Observation> {
    this.seen.push(`poll:${w.id}`);
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

const assign = (): number =>
  make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree: "/tmp/wt",
  });

const phaseOf = (id: number): string =>
  (db.prepare("SELECT phase FROM assignment WHERE id = ?").get(id) as { phase: string }).phase;

beforeEach(() => {
  db = open(join(mkdtempSync(join(tmpdir(), "wecode-foreman-")), "wecode.db"));
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

describe("a session that keeps running", () => {
  it("does not hold the tick: a second assignment starts on the next one", async () => {
    /** Starts, reports running, and never finishes — a real agent mid-task. */
    const busy: WorkerAdapter = {
      kind: "agent",
      start: async () => ({ phase: "running", session: "s", spent: spent() }),
      poll: async () => ({ phase: "running", session: "s", spent: spent() }),
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
