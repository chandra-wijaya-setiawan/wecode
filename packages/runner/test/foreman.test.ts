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
  /** Every brief it was handed, so a test can read what the foreman put in one. */
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
    this.work.push(w);
    return this.next();
  }
  async answer(w: Work, a: string): Promise<Observation> {
    this.seen.push(`answer:${w.id}:${a}`);
    this.work.push(w);
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
let workspace: number;
let project: number;

/** A whole tree down to one task, so a test can prove a lesson stays in its own project. */
const treeUnder = (p: number): number => {
  const at = make.acceptanceTest(
    make.criteria(make.requirement(make.story(make.epic(make.release(p, "1.0.0"), "e"), "s"), "r"), "c"),
    "proof",
    "script",
    "bash x.sh",
  );
  // A task slug is unique across the workspace, so the project it is under has to be in it.
  return make.task(at, `send the mail ${p}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
};

const assign = (): number => assignFor(task);

const assignFor = (objective: number): number =>
  make.assignment({
    objective_type: "task",
    objective_id: objective,
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
  workspace = make.workspace("acme", "/acme");
  project = make.project(workspace, "s", "/r");
  task = treeUnder(project);
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

describe("a lesson", () => {
  const lessons = (p: number): string[] =>
    (
      db
        .prepare("SELECT text FROM lesson WHERE project_id = ? ORDER BY id")
        .all(p) as unknown as { text: string }[]
    ).map((r) => r.text);

  /** Runs one whole attempt that ends with the given observation. */
  const attempt = async (seen: Observation, id = assign()): Promise<Fake> => {
    const fake = new Fake([seen]);
    await new Foreman(db, { agent: fake }).tick();
    return fake;
  };

  it("is recorded against the assignment's project when an attempt succeeds", async () => {
    const id = assign();
    await attempt(
      { phase: "succeeded", session: "s", spent: spent(), commit: "abc", lesson: "pnpm -r build first" },
      id,
    );
    expect(lessons(project)).toEqual(["pnpm -r build first"]);
    const row = db.prepare("SELECT assignment_id FROM lesson").get() as { assignment_id: number };
    expect(row.assignment_id).toBe(id); // traceable to the attempt that learned it
  });

  it("is recorded when the attempt failed, because that is the half worth keeping", async () => {
    await attempt({ phase: "failed", session: "s", spent: spent(), reason: "other", lesson: "the lockfile is frozen" });
    expect(lessons(project)).toEqual(["the lockfile is frozen"]);
  });

  it("is not recorded when the attempt offered none", async () => {
    await attempt({ phase: "succeeded", session: "s", spent: spent(), commit: "abc" });
    expect(lessons(project)).toEqual([]);
  });

  it("is reached by every kind of objective, not only a task", async () => {
    const at = db.prepare("SELECT acceptance_test_id AS id FROM task WHERE id = ?").get(task) as { id: number };
    const id = make.assignment({
      objective_type: "acceptance_test",
      objective_id: at.id,
      worker_id: worker,
      scope: { write: ["src/**"], tools: ["bash"] },
      budget: { tokens: 100, seconds: 10 },
      worktree: "/tmp/wt",
    });
    await attempt({ phase: "succeeded", session: "s", spent: spent(), commit: null, lesson: "tests need a build" }, id);
    expect(lessons(project)).toEqual(["tests need a build"]);
  });
});

describe("the lessons in a brief", () => {
  const learn = async (text: string): Promise<void> => {
    assign();
    const fake = new Fake([{ phase: "succeeded", session: "s", spent: spent(), commit: null, lesson: text }]);
    await new Foreman(db, { agent: fake }).tick();
  };

  it("are absent for a project that has none", async () => {
    const fake = new Fake([{ phase: "running", session: "s", spent: spent() }]);
    assign();
    await new Foreman(db, { agent: fake }).tick();
    expect(fake.work[0]?.lessons).toBeUndefined();
  });

  it("are the ten newest, newest first", async () => {
    for (let n = 1; n <= 12; n += 1) await learn(`lesson ${n}`);

    const fake = new Fake([{ phase: "running", session: "s", spent: spent() }]);
    assign();
    await new Foreman(db, { agent: fake }).tick();
    expect(fake.work[0]?.lessons).toEqual([
      "lesson 12",
      "lesson 11",
      "lesson 10",
      "lesson 9",
      "lesson 8",
      "lesson 7",
      "lesson 6",
      "lesson 5",
      "lesson 4",
      "lesson 3",
    ]);
  });

  it("do not cross from another project", async () => {
    await learn("only acme knows this");

    const other = make.project(workspace, "other", "/other");
    const id = assignFor(treeUnder(other));
    const fake = new Fake([{ phase: "running", session: "s", spent: spent() }]);
    await new Foreman(db, { agent: fake }).tick();

    const brief = fake.work.find((w) => w.id === id);
    expect(brief?.lessons).toBeUndefined();
  });
});
