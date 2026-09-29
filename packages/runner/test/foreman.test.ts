import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import {
  ClaudeCodeAdapter,
  Foreman,
  type Observation,
  type WorkerAdapter,
  type Work,
} from "../src/index.js";
import { choreBrief, NO_TESTS, type BriefContext } from "../src/foreman/prompt.js";
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
    this.work.push(w);
    return this.next();
  }
  async resume(w: Work): Promise<Observation> {
    this.seen.push(`resume:${w.id}:${w.session ?? ""}`);
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

const assign = (worktree = "/tmp/wecode-no-such-worktree"): number => assignFor(task, worktree);

const assignFor = (objective: number, worktree = "/tmp/wecode-no-such-worktree"): number =>
  make.assignment({
    objective_type: "task",
    objective_id: objective,
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

  // The baseline gained a line when the lesson story landed: every attempt is asked for one,
  // first or not. What this test is still about is the absence of a history section — a first
  // attempt is told nothing about a past it does not have.
  it("is exactly today's prompt on a first attempt", () => {
    expect(promptOf(work(null))).toBe(
      [
        "send the mail",
        "",
        "You may change only: src/**.",
        "Write the tests that prove this work, and run them.",
        "If you need a decision from a person, say so and stop rather than guessing.",
        "If you learned something a future attempt on this repository should know, end your " +
          "final message with a single line beginning LESSON:",
      ].join("\n"),
    );
    expect(promptOf(work(null))).not.toContain("## What happened before");
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

/** The dispatch prompt is its own module.
 *
 *  What a worker reads changes for reasons that have nothing to do with sessions,
 *  worktrees or phases, so the words live in `foreman/prompt.ts` and the foreman only
 *  looks the chore up. These hold the module to what the foreman used to say, and hold
 *  the foreman to no longer saying it. */
describe("the dispatch prompt", () => {
  const context = (over: Partial<BriefContext> = {}): BriefContext => ({
    kind: "merge",
    check: "story/password-reset merges cleanly",
    target_type: "story",
    target: "password-reset",
    branch: "story/password-reset",
    base: "master",
    ...over,
  });

  it("is reachable without the foreman, so the words can be changed on their own", () => {
    expect(typeof choreBrief).toBe("function");
    expect(choreBrief(context())).toContain("This is a merge chore for story/password-reset.");
  });

  it("says each kind's own reason, because a merge and a refresh run the same commands", () => {
    expect(choreBrief(context({ kind: "merge" }))).toContain("was delivered and will not merge into master");
    expect(choreBrief(context({ kind: "refresh" }))).toContain("is still in flight and has fallen behind master");
    expect(choreBrief(context({ kind: "sweep" }))).toContain("This is a sweep chore for story password-reset.");
  });

  it("carries the check the record stores, so the worker is judged by what it was told", () => {
    expect(choreBrief(context({ check: "no branch is behind" }))).toContain('The record carries it as "no branch is behind".');
  });

  it("gives a kind with no brief of its own a usable one rather than nothing", () => {
    expect(choreBrief(context({ kind: "tidy", check: "the tree is clean" })).split("\n")[0]).toBe(
      "tidy story password-reset. The check: the tree is clean.",
    );
  });

  it("ends every kind on the line that countermands 'write the tests that prove your work'", () => {
    for (const kind of ["merge", "refresh", "sweep", "tidy"]) {
      const said = choreBrief(context({ kind })).split("\n");
      expect(said[said.length - 1], kind).toBe(NO_TESTS);
    }
    expect(NO_TESTS).toContain("Write no new tests");
  });

  it("is no longer written in foreman.ts, which is what the move means", () => {
    const foreman = readFileSync(fileURLToPath(new URL("../src/foreman.ts", import.meta.url)), "utf8");
    expect(foreman).not.toContain("This is a merge chore for");
    expect(foreman).not.toContain("Write no new tests");
    expect(foreman).toContain('from "./foreman/prompt.js"');
  });
});
