import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CHORE_KIND_DEFS,
  Engine,
  Maker,
  currentLoad,
  freeWorkers,
  nextUp,
  open,
  readyCandidates,
  type Scope,
} from "../src/index.js";
import { tmp } from "./tmpdir.js";
import { join } from "node:path";

const source = readFileSync(fileURLToPath(new URL("../src/order.ts", import.meta.url)), "utf8");

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;
let worker: number;

/** A ready task, with its own acceptance_test so two tasks never share one. */
function readyTask(title: string, write: readonly string[], role = "engineer"): number {
  const scope: Scope = { write: [...write], tools: [] };
  const at = make.acceptanceTest(criteria, `${title} proof`, "script", "bash x.sh");
  const t = make.task(at, title, { scope, role });
  make.taskTest(t, `${title} unit`, "script", "vitest run");
  const tests = db.prepare("SELECT id FROM task_test WHERE parent_id = ?").all(t) as unknown as { id: number }[];
  for (const tt of tests) engine.apply("task_test", tt.id, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", t, "start", "chief");
  return t;
}

const assign = (objective_type: "task" | "chore", objective_id: number, write: readonly string[], w = worker): number =>
  make.assignment({
    objective_type,
    objective_id,
    worker_id: w,
    scope: { write: [...write], tools: [] },
    budget: { tokens: 1, seconds: 1 },
    worktree: "/tmp/wt",
  });

const phase = (id: number, p: string): void => {
  db.prepare("UPDATE assignment SET phase = ? WHERE id = ?").run(p, id);
};

beforeEach(() => {
  db = open(join(tmp(), "wecode.db"));
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

describe("the order module, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in the module", () => {
    expect(source).not.toMatch(/\bprepare\s*\(/);
    expect(source.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT)\b/g)).toBeNull();
  });

  it("speaks to the database only through the dialect", () => {
    // `DatabaseSync` is still the currency every caller passes, but it arrives as a type and
    // is handed on; nothing in here calls a method on it.
    expect(source).toContain('import { queries, table } from "./db.js"');
    expect(source).not.toMatch(/\bdb\.(prepare|exec|get|all|run)\b/);
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migration cannot drift apart without a test saying
   *  so — and the list lives in one place, the module, not in a copy here. */
  it("asks only for columns the migrations actually built", () => {
    const declared = [...source.matchAll(/table<[^>]*>\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map((m) => ({
      name: m[1],
      columns: [...m[2].matchAll(/"(\w+)"/g)].map((c) => c[1]),
    }));

    expect(declared.map((d) => d.name).sort()).toEqual(["assignment", "chore", "task", "worker"]);
    for (const d of declared) {
      const actual = (db.prepare(`PRAGMA table_info(${d.name})`).all() as { name: string }[]).map((c) => c.name);
      expect(d.columns.length).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });
});

describe("ready candidates, through the layer", () => {
  it("reads a ready task whole, with its scope and budget parsed", () => {
    const t = readyTask("send the mail", ["src/mail/**"]);

    expect(readyCandidates(db)).toEqual([
      {
        id: t,
        title: "send the mail",
        role: "engineer",
        scope: { write: ["src/mail/**"], tools: [] },
        budget: expect.objectContaining({ tokens: expect.any(Number) }),
        attempts: 0,
      },
    ]);
  });

  it("leaves out a task that is not ready", () => {
    const ready = readyTask("ready", ["src/a/**"]);
    const planned = make.task(make.acceptanceTest(criteria, "p proof", "script", "bash x.sh"), "planned", {
      scope: { write: ["src/b/**"], tools: [] },
      role: "engineer",
    });

    expect(readyCandidates(db).map((c) => c.id)).toEqual([ready]);
    expect(readyCandidates(db).map((c) => c.id)).not.toContain(planned);
  });

  it("leaves out a ready task an open assignment is already attempting", () => {
    const held = readyTask("held", ["src/a/**"]);
    const spare = readyTask("spare", ["src/b/**"]);
    assign("task", held, ["src/a/**"]);

    expect(readyCandidates(db).map((c) => c.id)).toEqual([spare]);
  });

  it("offers it again once the assignment has ended", () => {
    const t = readyTask("retried", ["src/a/**"]);
    const a = assign("task", t, ["src/a/**"]);
    expect(readyCandidates(db)).toEqual([]);

    phase(a, "failed");
    expect(readyCandidates(db).map((c) => c.id)).toEqual([t]);
  });

  it("counts a waiting assignment as still attempting, and a done one as not", () => {
    const t = readyTask("one", ["src/a/**"]);
    const a = assign("task", t, ["src/a/**"]);
    for (const p of ["pending", "running", "waiting"]) {
      phase(a, p);
      expect(readyCandidates(db), p).toEqual([]);
    }
    for (const p of ["done", "failed", "abandoned"]) {
      phase(a, p);
      expect(readyCandidates(db).map((c) => c.id), p).toEqual([t]);
    }
  });

  it("is not held back by an assignment on a chore that happens to share the task's id", () => {
    const t = readyTask("one", ["src/a/**"]);
    assign("chore", t, ["src/a/**"]);

    expect(readyCandidates(db).map((c) => c.id)).toEqual([t]);
  });

  it("comes back in id order however the rows arrive", () => {
    const a = readyTask("a", ["src/a/**"]);
    const b = readyTask("b", ["src/b/**"]);
    const c = readyTask("c", ["src/c/**"]);
    // touching a row does not move it: the order is applied, not inherited from the table
    db.prepare("UPDATE task SET title = title WHERE id = ?").run(a);

    expect(readyCandidates(db).map((x) => x.id)).toEqual([a, b, c].sort((x, y) => x - y));
  });
});

describe("the current load, through the layer", () => {
  it("is empty when nothing is open", () => {
    readyTask("one", ["src/a/**"]);

    expect(currentLoad(db, {})).toEqual({
      held: [],
      openPerRole: {},
      capPerRole: {},
      freePerRole: { engineer: 1 },
    });
  });

  it("holds every write glob of every open assignment, and none of a closed one", () => {
    const one = readyTask("one", ["src/a/**"]);
    const two = readyTask("two", ["src/b/**", "docs/**"]);
    assign("task", one, ["src/a/**"]);
    const closed = assign("task", two, ["src/b/**", "docs/**"]);

    expect(currentLoad(db, {}).held).toEqual(["src/a/**", "src/b/**", "docs/**"]);
    phase(closed, "done");
    expect(currentLoad(db, {}).held).toEqual(["src/a/**"]);
  });

  it("counts an open task assignment against the task's own role", () => {
    const eng = readyTask("eng", ["src/a/**"], "engineer");
    const rev = readyTask("rev", ["src/b/**"], "reviewer");
    assign("task", eng, ["src/a/**"]);
    assign("task", rev, ["src/b/**"]);
    assign("task", eng, ["src/a/**"]);

    expect(currentLoad(db, {}).openPerRole).toEqual({ engineer: 2, reviewer: 1 });
  });

  it("counts an open chore against the role its kind names, folded onto the same tally", () => {
    const eng = readyTask("eng", ["src/a/**"], "engineer");
    assign("task", eng, ["src/a/**"]);
    const kind = Object.keys(CHORE_KIND_DEFS)[0] as keyof typeof CHORE_KIND_DEFS;
    const role = CHORE_KIND_DEFS[kind].role;
    db.prepare(
      `INSERT INTO chore (slug,kind,project_id,target_type,target_id,"check",state,created_at,updated_at)
       VALUES ('c1',?,(SELECT id FROM project LIMIT 1),'story',1,'x','open','t','t')`,
    ).run(kind);
    const chore = (db.prepare("SELECT id FROM chore").get() as { id: number }).id;
    assign("chore", chore, ["src/c/**"]);

    const expected: Record<string, number> = { engineer: 1 };
    expected[role] = (expected[role] ?? 0) + 1;
    expect(currentLoad(db, {}).openPerRole).toEqual(expected);
  });

  it("ignores an open assignment whose objective row is gone, as the join it replaced did", () => {
    assign("task", 9999, ["src/a/**"]);
    assign("chore", 9999, ["src/b/**"]);

    const load = currentLoad(db, {});
    expect(load.openPerRole).toEqual({});
    // the scope is still held, though: the assignment is open whatever it points at
    expect(load.held).toEqual(["src/a/**", "src/b/**"]);
  });

  it("hands the caller's caps straight back, having no opinion of its own", () => {
    expect(currentLoad(db, { engineer: 2 }).capPerRole).toEqual({ engineer: 2 });
  });
});

describe("free workers, through the layer", () => {
  it("counts every worker with nothing open, per role", () => {
    make.worker("claude-2", "engineer", "agent");
    make.worker("rev-1", "reviewer", "agent");

    expect(freeWorkers(db)).toEqual({ engineer: 2, reviewer: 1 });
  });

  it("stops counting one the moment it holds an open assignment, and counts it again after", () => {
    const busy = make.worker("claude-2", "engineer", "agent");
    const t = readyTask("one", ["src/a/**"]);
    const a = assign("task", t, ["src/a/**"], busy);

    expect(freeWorkers(db)).toEqual({ engineer: 1 });
    phase(a, "done");
    expect(freeWorkers(db)).toEqual({ engineer: 2 });
  });

  it("omits a role with nobody free, rather than reporting it as zero", () => {
    const t = readyTask("one", ["src/a/**"]);
    assign("task", t, ["src/a/**"]);

    expect(freeWorkers(db)).toEqual({});
    expect("engineer" in freeWorkers(db)).toBe(false);
  });
});

describe("what is next, over the ported queries", () => {
  it("still answers from the record, in the order it would try them", () => {
    const retried = readyTask("retried", ["src/a/**"]);
    db.prepare("UPDATE task SET attempts = 2 WHERE id = ?").run(retried);
    const fresh = readyTask("fresh", ["src/b/**"]);

    const r = nextUp(db, { max_open_per_role: {}, order: { fresh_first: true } });
    expect(r.ordered.map((c) => c.id)).toEqual([fresh, retried]);
    expect(r.refused).toEqual([]);
  });

  it("still refuses a collision and a role at its cap, in the same words", () => {
    const held = readyTask("held", ["src/**"]);
    const blocked = readyTask("blocked", ["src/mail/**"]);
    assign("task", held, ["src/**"]);

    expect(nextUp(db, { max_open_per_role: {}, order: { fresh_first: true } }).refused).toEqual([
      { id: blocked, why: "its write scope overlaps an assignment already open" },
    ]);
    expect(nextUp(db, { max_open_per_role: { engineer: 1 }, order: { fresh_first: true } }).refused).toEqual([
      { id: blocked, why: "role engineer is at 1" },
    ]);
  });
});
