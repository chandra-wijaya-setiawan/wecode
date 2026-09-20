import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { answerApproval, Maker, open, raiseApproval, waitingApprovals } from "@wecode/core";
import { Foreman, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** An approval is an assignment, and the foreman's tick walks every open assignment.
 *
 *  What makes an approval different is that nobody runs it: its worker is a person, so
 *  there is no adapter to start it, poll it or kill it. The foreman used to read that
 *  missing adapter as a broken row and fail the assignment, which meant a question raised
 *  for a person was gone before the person saw it — the tick that found it ended it.
 *
 *  These hold the other behaviour: a person's assignment is left exactly as it was found,
 *  and a row that really has no adapter — an agent of a kind the runner was not given —
 *  still fails, because that one is a broken row. */

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
  async resume(w: Work): Promise<Observation> {
    this.seen.push(`resume:${w.id}`);
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
let person: number;

const rowOf = (id: number): { phase: string; reason: string | null; updated_at: string } =>
  db.prepare("SELECT phase, reason, updated_at FROM assignment WHERE id = ?").get(id) as {
    phase: string;
    reason: string | null;
    updated_at: string;
  };

beforeEach(() => {
  db = open(join(tmp("wecode-approval-tick-"), "wecode.db"));
  make = new Maker(db);
  const project = make.project(make.workspace("acme", "/acme"), "s", "/r");
  const at = make.acceptanceTest(
    make.criteria(make.requirement(make.story(make.epic(make.release(project, "1.0.0"), "e"), "s"), "r"), "c"),
    "proof",
    "script",
    "bash x.sh",
  );
  task = make.task(at, "send the mail", { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  person = make.worker("chandra", "engineer", "human");
});

describe("an approval", () => {
  it("outlives a tick that finds it", async () => {
    const raised = raiseApproval(db, {
      objective_type: "task",
      objective_id: task,
      worker_id: person,
      question: "may I widen the scope?",
      options: ["yes", "no"],
    });
    const before = rowOf(raised.id);

    const report = await new Foreman(db, { agent: new Fake([]) }).tick();

    expect(report.failed).toEqual([]);
    expect(rowOf(raised.id)).toEqual(before);
    expect(waitingApprovals(db).map((a) => a.id)).toEqual([raised.id]);
  });

  it("is still a person's to answer after the foreman has ticked over it", async () => {
    const raised = raiseApproval(db, {
      objective_type: "task",
      objective_id: task,
      worker_id: person,
      question: "may I widen the scope?",
      options: ["yes", "no"],
    });
    const foreman = new Foreman(db, { agent: new Fake([]) });
    await foreman.tick();
    await foreman.tick();

    const answered = answerApproval(db, raised.id, "yes", "chandra");
    expect(answered.answer).toBe("yes");
  });

  it("is not polled, killed or started, because a person is not a session", async () => {
    raiseApproval(db, {
      objective_type: "task",
      objective_id: task,
      worker_id: person,
      question: "may I widen the scope?",
    });
    const fake = new Fake([]);

    // A deadline of zero: were the approval ever treated as a running attempt, it would be
    // overdue the instant it was raised.
    await new Foreman(db, { agent: fake }, 0).tick();

    expect(fake.seen).toEqual([]);
  });

  it("does not shield an agent whose kind the runner was never given", async () => {
    const stranger = make.worker("ghost-1", "engineer", "agent");
    db.prepare("UPDATE worker SET kind = 'wandering' WHERE id = ?").run(stranger);
    const id = make.assignment({
      objective_type: "task",
      objective_id: task,
      worker_id: stranger,
      scope: { write: ["src/**"], tools: ["bash"] },
      budget: { tokens: 100, seconds: 10 },
      worktree: "/tmp/wecode-no-such-worktree",
    });

    const report = await new Foreman(db, { agent: new Fake([]) }).tick();

    expect(report.failed).toEqual([id]);
    expect(rowOf(id).phase).toBe("failed");
    expect(rowOf(id).reason).toBe("other");
  });
});
