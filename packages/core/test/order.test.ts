import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Engine,
  Maker,
  collides,
  eligible,
  nextUp,
  open,
  ordered,
  readyCandidates,
  type Candidate,
  type Load,
  type Scope,
} from "../src/index.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let worker: number;
let criteria: number;

const nothingOpen: Load = { held: [], openPerRole: {}, capPerRole: {} };

/** A candidate that never touches the database, for the pure ordering. */
const cand = (id: number, attempts: number, role = "engineer"): Candidate => ({
  id,
  title: `t${id}`,
  role,
  scope: { write: [`src/${id}/**`], tools: [] },
  budget: { tokens: 1, seconds: 1 },
  attempts,
});

/** A ready task, with its own acceptance_test so two tasks never share one. */
function readyTask(title: string, scope: Scope, role = "engineer"): number {
  const at = make.acceptanceTest(criteria, `${title} proof`, "script", "bash x.sh");
  const t = make.task(at, title, { scope, role });
  make.taskTest(t, `${title} unit`, "script", "vitest run");
  const tests = db.prepare("SELECT id FROM task_test WHERE parent_id = ?").all(t) as unknown as { id: number }[];
  for (const tt of tests) engine.apply("task_test", tt.id, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", t, "start", "chief");
  return t;
}

beforeEach(() => {
  db = open(join(mkdtempSync(join(tmpdir(), "wecode-order-")), "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", "/acme");
  const p = make.project(ws, "s", "/r");
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  const s = make.story(e, "s");
  const req = make.requirement(s, "r");
  criteria = make.criteria(req, "c");
  worker = make.worker("claude-1", "engineer", "agent");
});

describe("the order", () => {
  it("puts a first attempt ahead of a retry, then breaks the tie by id", () => {
    const cs = [cand(3, 0), cand(1, 2), cand(2, 0)];
    expect(ordered(cs, { fresh_first: true }).map((c) => c.id)).toEqual([2, 3, 1]);
  });

  it("is stable: the same record yields the same order however it arrives", () => {
    const cs = [cand(4, 1), cand(2, 0), cand(9, 1), cand(7, 0)];
    const once = ordered(cs, { fresh_first: true }).map((c) => c.id);
    const again = ordered([...cs].reverse(), { fresh_first: true }).map((c) => c.id);
    expect(once).toEqual([2, 7, 4, 9]);
    expect(again).toEqual(once);
    expect(ordered(once.map((id) => cs.find((c) => c.id === id)!), { fresh_first: true }).map((c) => c.id)).toEqual(once);
  });

  it("falls back to id alone when fresh_first is off", () => {
    const cs = [cand(3, 0), cand(1, 2)];
    expect(ordered(cs, { fresh_first: false }).map((c) => c.id)).toEqual([1, 3]);
  });

  it("does not disturb what it was given", () => {
    const cs = [cand(3, 0), cand(1, 2)];
    ordered(cs, { fresh_first: true });
    expect(cs.map((c) => c.id)).toEqual([3, 1]);
  });
});

describe("eligibility", () => {
  it("excludes a candidate whose write scope collides, and says so", () => {
    const cs = [cand(1, 0), cand(2, 0)];
    const r = eligible(cs, { ...nothingOpen, held: ["src/1/**"] });
    expect(r.eligible.map((c) => c.id)).toEqual([2]);
    expect(r.refused).toEqual([{ id: 1, why: "its write scope overlaps an assignment already open" }]);
  });

  it("excludes a role that is at its cap, and says which", () => {
    const cs = [cand(1, 0, "engineer"), cand(2, 0, "reviewer")];
    const r = eligible(cs, { held: [], openPerRole: { engineer: 1 }, capPerRole: { engineer: 1 } });
    expect(r.eligible.map((c) => c.id)).toEqual([2]);
    expect(r.refused).toEqual([{ id: 1, why: "role engineer is at 1" }]);
  });

  it("keeps a role under its cap", () => {
    const r = eligible([cand(1, 0)], { held: [], openPerRole: { engineer: 1 }, capPerRole: { engineer: 2 } });
    expect(r.eligible.map((c) => c.id)).toEqual([1]);
    expect(r.refused).toEqual([]);
  });

  it("blames the cap before the collision, so one candidate yields one reason", () => {
    const r = eligible([cand(1, 0)], { held: ["src/1/**"], openPerRole: { engineer: 1 }, capPerRole: { engineer: 1 } });
    expect(r.refused).toEqual([{ id: 1, why: "role engineer is at 1" }]);
  });

  it("sees an overlap when either reaches into the other", () => {
    expect(collides(["src/**"], ["src/mail/**"])).toBe(true);
    expect(collides(["src/mail/**"], ["src/ui/**"])).toBe(false);
  });
});

describe("what is next", () => {
  it("answers from the record, so a view need not import the runner", () => {
    const retried = readyTask("retried", { write: ["src/a/**"], tools: [] });
    db.prepare("UPDATE task SET attempts = 2 WHERE id = ?").run(retried);
    const fresh = readyTask("fresh", { write: ["src/b/**"], tools: [] });

    const r = nextUp(db, { max_open_per_role: {}, order: { fresh_first: true } });
    expect(r.ordered.map((c) => c.id)).toEqual([fresh, retried]);
    expect(retried).toBeLessThan(fresh);
    expect(r.refused).toEqual([]);
  });

  it("leaves out what an open assignment collides with", () => {
    const held = readyTask("held", { write: ["src/**"], tools: [] });
    const blocked = readyTask("blocked", { write: ["src/mail/**"], tools: [] });
    make.assignment({
      objective_type: "task",
      objective_id: held,
      worker_id: worker,
      scope: { write: ["src/**"], tools: [] },
      budget: { tokens: 1, seconds: 1 },
      worktree: "/tmp/wt",
    });

    // the held task is no longer a candidate at all; the one it collides with is refused
    expect(readyCandidates(db).map((c) => c.id)).toEqual([blocked]);
    const r = nextUp(db, { max_open_per_role: {}, order: { fresh_first: true } });
    expect(r.ordered).toEqual([]);
    expect(r.refused).toEqual([{ id: blocked, why: "its write scope overlaps an assignment already open" }]);
  });

  it("leaves out a role already at its cap", () => {
    const held = readyTask("held", { write: ["src/a/**"], tools: [] });
    const waiting = readyTask("waiting", { write: ["src/b/**"], tools: [] });
    make.assignment({
      objective_type: "task",
      objective_id: held,
      worker_id: worker,
      scope: { write: ["src/a/**"], tools: [] },
      budget: { tokens: 1, seconds: 1 },
      worktree: "/tmp/wt",
    });

    const r = nextUp(db, { max_open_per_role: { engineer: 1 }, order: { fresh_first: true } });
    expect(r.ordered).toEqual([]);
    expect(r.refused).toEqual([{ id: waiting, why: "role engineer is at 1" }]);
  });
});
