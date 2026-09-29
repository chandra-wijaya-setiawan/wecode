import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { Foreman, type Observation, type WorkerAdapter } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

class Fake implements WorkerAdapter {
  readonly kind = "agent";
  readonly seen: string[] = [];

  constructor(private readonly script: Observation[]) {}

  private next(): Observation {
    return this.script.shift() ?? { phase: "running", session: "s", spent: { tokens: 0, seconds: 0 } };
  }

  async start(): Promise<Observation> {
    this.seen.push("start");
    return this.next();
  }

  async poll(): Promise<Observation> {
    this.seen.push("poll");
    return this.next();
  }

  async resume(): Promise<Observation> {
    return this.next();
  }

  async answer(): Promise<Observation> {
    return this.next();
  }

  async kill(): Promise<void> {
    this.seen.push("kill");
  }
}

let db: DatabaseSync;
let make: Maker;
let task: number;
let worker: number;

beforeEach(() => {
  db = open(`${tmp("wecode-budget-")}/wecode.db`);
  make = new Maker(db);
  const workspace = make.workspace("acme", "/acme");
  const project = make.project(workspace, "store", "/store");
  const release = make.release(project, "1.0.0");
  const epic = make.epic(release, "work");
  const story = make.story(epic, "budget");
  const requirement = make.requirement(story, "spend");
  const acceptance = make.acceptanceTest(make.criteria(requirement, "done"), "done", "script", "true");
  task = make.task(acceptance, "keep running", { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  worker = make.worker("agent-1", "engineer", "agent");
});

const assign = (): number =>
  make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree: "/tmp/no-such-worktree",
  });

const phase = (id: number): string =>
  (db.prepare("SELECT phase FROM assignment WHERE id = ?").get(id) as { phase: string }).phase;

describe("an assignment enforces its token budget", () => {
  it("kills and fails an attempt whose poll is past the declared budget", async () => {
    const id = assign();
    const fake = new Fake([
      { phase: "running", session: "s", spent: { tokens: 1, seconds: 1 } },
      { phase: "running", session: "s", spent: { tokens: 101, seconds: 1 } },
    ]);

    await new Foreman(db, { agent: fake }, 3600).tick();
    const report = await new Foreman(db, { agent: fake }, 3600).tick();

    expect(report.failed).toEqual([id]);
    expect(fake.seen).toEqual(["start", "poll", "kill"]);
    expect(phase(id)).toBe("failed");
    expect(db.prepare("SELECT reason, spent FROM assignment WHERE id = ?").get(id)).toEqual({
      reason: "budget_exceeded",
      spent: JSON.stringify({ tokens: 101, seconds: 1 }),
    });
    expect((db.prepare("SELECT text FROM lesson WHERE assignment_id = ?").get(id) as { text: string }).text).toBe(
      "Stopped after spending its budget: 101 tokens of 100 allowed.",
    );
    expect((db.prepare("SELECT attempts FROM task WHERE id = ?").get(task) as { attempts: number }).attempts).toBe(1);
  });

  it("leaves an attempt alone while its poll is inside the declared budget", async () => {
    const id = assign();
    const fake = new Fake([
      { phase: "running", session: "s", spent: { tokens: 1, seconds: 1 } },
      { phase: "running", session: "s", spent: { tokens: 99, seconds: 1 } },
    ]);

    await new Foreman(db, { agent: fake }, 3600).tick();
    await new Foreman(db, { agent: fake }, 3600).tick();

    expect(fake.seen).toEqual(["start", "poll"]);
    expect(phase(id)).toBe("running");
  });
});
