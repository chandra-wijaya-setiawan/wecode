/** The foreman, ported onto core's typed query layer.
 *
 *  Two halves. The first is the port itself, asserted as an absence: not one prepared
 *  statement and not one line of SQL text left in the module, because a single query the
 *  compiler does not check is enough to lose the whole guarantee.
 *
 *  The second is the behaviour the SQL used to carry. Three things it did are not things
 *  the dialect can spell — a seven-way join up to the project, an ordering, and an
 *  increment that reads the column it writes — so each is exercised against a fixture that
 *  can tell the port from a plausible rewrite of it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { addLesson, ensureChore, Maker, open } from "@wecode/core";
import { Foreman, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

const source = readFileSync(fileURLToPath(new URL("../src/foreman.ts", import.meta.url)), "utf8");

/** The module with its comments taken out. Every assertion about SQL left in the source is
 *  made against this: the port replaced SQL with prose *about* SQL, and a comment saying
 *  the dialect spells no ordering must not read as an ORDER BY. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Keeps what it was handed and reports what the test queued. */
class Fake implements WorkerAdapter {
  readonly kind = "agent";
  readonly work: Work[] = [];
  constructor(private readonly script: Observation[] = []) {}
  private next(): Observation {
    return this.script.shift() ?? { phase: "succeeded", session: "s", spent: spent(), commit: null };
  }
  async start(w: Work): Promise<Observation> {
    this.work.push(w);
    return this.next();
  }
  async poll(w: Work): Promise<Observation> {
    this.work.push(w);
    return this.next();
  }
  async resume(w: Work): Promise<Observation> {
    this.work.push(w);
    return this.next();
  }
  async answer(w: Work): Promise<Observation> {
    this.work.push(w);
    return this.next();
  }
  async kill(): Promise<void> {}
}

const spent = (): { tokens: number; seconds: number } => ({ tokens: 10, seconds: 1 });

let db: DatabaseSync;
let make: Maker;
let workspace: number;
let project: number;
let story: number;
let acceptance: number;
let task: number;
let taskTest: number;
let worker: number;

beforeEach(() => {
  db = open(join(tmp("wecode-typed-foreman-"), "wecode.db"));
  make = new Maker(db);
  workspace = make.workspace("acme", "/acme");
  project = make.project(workspace, "storefront", "/r");
  // A spare epic and a spare requirement, so that no id in the chain coincides with any
  // other: the walk up to the project is a lookup per link, and with the ids aligned a
  // lookup keyed on the wrong link still gives the right answer.
  const release = make.release(project, "1.0.0");
  make.epic(release, "spare");
  const epic = make.epic(release, "recovery");
  story = make.story(epic, "password reset");
  make.requirement(story, "spare requirement");
  const requirement = make.requirement(story, "one change per link");
  acceptance = make.acceptanceTest(make.criteria(requirement, "emailed in 60s"), "mail arrives", "script", "true");
  task = make.task(acceptance, "send the mail", { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  taskTest = make.taskTest(task, "the mailer is called", "script", "true");
  worker = make.worker("claude-1", "engineer", "agent");
});

const assign = (objective_type: "task" | "acceptance_test" | "task_test" | "chore", objective_id: number): number =>
  make.assignment({
    objective_type: objective_type as "task",
    objective_id,
    worker_id: worker,
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree: "/tmp/wecode-no-such-worktree",
  });

/** One pass per queued observation: a tick takes exactly one reading of each open
 *  assignment, so a two-step story needs two of them. */
const tick = async (fake: Fake, passes = 1): Promise<Fake> => {
  const foreman = new Foreman(db, { agent: fake }, 3600, { repoRoot: "/r", integrationBranch: "main" });
  for (let n = 0; n < passes; n += 1) await foreman.tick();
  return fake;
};

const running = (): Observation => ({ phase: "running", session: "s", spent: spent() });

describe("the foreman, ported onto the typed layer", () => {
  /** The point of the port. One prepared statement left behind is a query the compiler does
   *  not check, so this is spelled as "none" against the source rather than as a test of
   *  the queries that were ported. */
  it("leaves no prepared statement in the module", () => {
    expect(code).not.toMatch(/\bprepare\s*\(/);
  });

  /** Not even to create a table. The foreman used to declare `lesson` for itself beside the
   *  record; the table is core's, by migration, and its own reader and writer are core's
   *  too — so the module now touches the handle only by handing it to something else. */
  it("never reaches the database handle directly, for a query or for anything else", () => {
    expect(code.match(/\bdb\.(prepare|exec|get|all|run)\b/g)).toBeNull();
  });

  it("has no SQL text left in it", () => {
    expect(
      code.match(
        /\b(SELECT|INSERT INTO|DELETE FROM|UPDATE [a-z_]+ SET|FROM [a-z_]+|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT|DISTINCT|COALESCE|CREATE TABLE)\b/g,
      ),
    ).toBeNull();
  });

  it("speaks to the database through the dialect", () => {
    expect(code).toContain('from "@wecode/core/dist/db.js"');
    expect(code).toMatch(/queries\(this\.db\)/);
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migrations cannot drift apart without a test saying
   *  so — and the list lives in the module, not in a second copy here. */
  it("asks only for columns the schema actually has", () => {
    const declared = [...source.matchAll(/table<[^>]*>\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map((m) => ({
      name: m[1] as string,
      columns: [...(m[2] as string).matchAll(/"(\w+)"/g)].map((c) => c[1] as string),
    }));

    expect(declared.map((d) => d.name).sort()).toEqual([
      "acceptance_criteria",
      "acceptance_test",
      "assignment",
      "chore",
      "epic",
      "project",
      "release",
      "requirement",
      "story",
      "task",
      "task_test",
      "worker",
    ]);
    for (const d of declared) {
      const actual = (db.prepare(`PRAGMA table_info(${d.name})`).all() as unknown as { name: string }[]).map(
        (c) => c.name,
      );
      expect(actual.length, d.name).toBeGreaterThan(0);
      expect(d.columns.length, d.name).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });

  /** The table the foreman used to create for itself is the record's, and nothing in the
   *  module makes it any more: a fresh database has it because the migration does. */
  it("finds the lesson table already there, with core's nullable attribution column", () => {
    const cols = db.prepare("PRAGMA table_info(lesson)").all() as unknown as { name: string; notnull: number }[];
    expect(cols.map((c) => c.name).sort()).toEqual(["assignment_id", "created_at", "id", "project_id", "text"]);
    // The foreman's old copy declared this NOT NULL; core's does not, and core's is the one
    // that stands — a lesson an operator wrote by hand has no attempt behind it.
    expect(cols.find((c) => c.name === "assignment_id")?.notnull).toBe(0);
  });
});

describe("the walk up to a project, which was a seven-way join", () => {
  const brief = async (type: "task" | "acceptance_test" | "task_test", id: number): Promise<Work> => {
    assign(type, id);
    const fake = await tick(new Fake([running()]));
    return fake.work[0] as Work;
  };

  it("reaches the project from a task, a test and a task_test alike", async () => {
    addLesson(db, project, "pnpm -r build first");

    for (const [type, id] of [
      ["task", task],
      ["acceptance_test", acceptance],
      ["task_test", taskTest],
    ] as const) {
      const fake = new Fake([running()]);
      assign(type, id);
      await tick(fake);
      const work = fake.work.find((w) => w.objective_type === type) as Work;
      expect(work.lessons, type).toEqual(["pnpm -r build first"]);
      db.prepare("UPDATE assignment SET phase = 'succeeded'").run();
    }
  });

  it("carries no lessons from a sibling project", async () => {
    const other = make.project(workspace, "billing", "/other");
    addLesson(db, other, "only billing knows this");

    const work = await brief("task", task);

    expect(work.lessons).toBeUndefined();
  });

  /** A chore names its project outright and hangs off no test, so the walk has nowhere to
   *  start. It is not an error: the brief simply carries no lessons. */
  it("says a chore has no project to walk up to, and records no lesson against one", async () => {
    const chore = ensureChore(db, {
      kind: "merge",
      project_id: project,
      target_type: "story",
      target_id: story,
      check: "main merges cleanly",
    });
    assign("chore", chore.id);

    const fake = await tick(
      new Fake([{ phase: "succeeded", session: "s", spent: spent(), commit: null, lesson: "conflicts in one file" }]),
    );

    expect((fake.work[0] as Work).lessons).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM lesson").get()).toEqual({ n: 0 });
  });

  it("writes a lesson against the project the walk found, attributed to the attempt", async () => {
    const id = assign("task", task);

    await tick(new Fake([{ phase: "succeeded", session: "s", spent: spent(), commit: null, lesson: "the lockfile is frozen" }]));

    expect(db.prepare("SELECT project_id, assignment_id, text FROM lesson").all()).toEqual([
      { project_id: project, assignment_id: id, text: "the lockfile is frozen" },
    ]);
  });
});

describe("a chore's brief, which was two joins and a coalesce", () => {
  const briefFor = async (target_type: "story" | "project", target_id: number): Promise<string> => {
    const chore = ensureChore(db, {
      kind: "merge",
      project_id: project,
      target_type,
      target_id,
      check: "the check, as the record stores it",
    });
    assign("chore", chore.id);
    const fake = await tick(new Fake([running()]));
    return (fake.work[0] as Work).instruction;
  };

  it("names the story when the target is one", async () => {
    expect(await briefFor("story", story)).toContain("This is a merge chore for story/password-reset.");
  });

  /** The outer join's null side. The story lookup is not made at all when the target is not
   *  a story, and the project's name is what the brief falls back to — asserted with a
   *  story whose id is the project's, so a lookup that ignored `target_type` would find one
   *  and name the wrong thing. */
  it("falls back to the project's name when the target is not a story", async () => {
    const twin = db.prepare("SELECT id, slug FROM story WHERE id = ?").get(project) as
      | { id: number; slug: string }
      | undefined;
    expect(twin, "the fixture needs a story sharing the project's id").toBeDefined();

    const text = await briefFor("project", project);

    expect(text).toContain("chore for story/storefront.");
    expect(text).not.toContain(twin?.slug);
  });

  /** The project side was an inner join, so a chore with no project yields no brief at all
   *  rather than a brief with a hole in it. */
  it("says nothing for a chore whose project is gone", async () => {
    const chore = ensureChore(db, {
      kind: "sweep",
      project_id: project,
      target_type: "story",
      target_id: story,
      check: "the record matches the world",
    });
    assign("chore", chore.id);
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("UPDATE chore SET project_id = 9999 WHERE id = ?").run(chore.id);

    const fake = await tick(new Fake([running()]));

    expect((fake.work[0] as Work).instruction).toBe("");
  });
});

describe("the orderings the dialect cannot spell", () => {
  /** The open assignments used to be picked by a phase list and an ORDER BY. Both are done
   *  in memory now, so both are asserted: an ended assignment is not handed over, and the
   *  ones that are come oldest first. */
  it("hands over every open assignment, oldest first, and no ended one", async () => {
    const first = assign("task", task);
    const second = assign("acceptance_test", acceptance);
    const ended = assign("task_test", taskTest);
    db.prepare("UPDATE assignment SET phase = 'succeeded' WHERE id = ?").run(ended);

    const fake = await tick(new Fake([running(), running()]));

    expect(fake.work.map((w) => w.id)).toEqual([first, second]);
  });

  /** `ORDER BY id DESC LIMIT 1` over the earlier attempts at this task. Three of them, so
   *  "the newest" is a different row from both "the first" and "the only one". */
  it("tells a retry about the newest earlier attempt, not the first", async () => {
    for (const [reason, sha] of [
      ["timeout", "aaaaaaa"],
      ["rejected", "bbbbbbb"],
      ["lost", "ccccccc"],
    ] as const) {
      const old = assign("task", task);
      db.prepare("UPDATE assignment SET phase = 'failed', reason = ?, commit_sha = ? WHERE id = ?").run(
        reason,
        sha,
        old,
      );
    }
    db.prepare("UPDATE task SET attempts = 3 WHERE id = ?").run(task);
    assign("task", task);

    const fake = await tick(new Fake([running()]));

    expect((fake.work[0] as Work).history).toMatchObject({ attempts: 3, reason: "lost", commit: "ccccccc" });
  });

  /** A first attempt is told nothing, whatever the branch holds. */
  it("tells a first attempt nothing about any other assignment", async () => {
    assign("task", task);

    const fake = await tick(new Fake([running()]));

    expect((fake.work[0] as Work).history).toBeNull();
  });

  it("names every failing task_test in id order, reduced to its last line", async () => {
    const second = make.taskTest(task, "the address is validated", "script", "true");
    db.prepare("UPDATE task_test SET state = 'failed', last_output = ? WHERE id = ?").run(
      "running\nExpected 1, got 0\n\n",
      taskTest,
    );
    db.prepare("UPDATE task_test SET state = 'failed' WHERE id = ?").run(second);
    db.prepare("UPDATE task SET attempts = 1 WHERE id = ?").run(task);
    assign("task", task);

    const fake = await tick(new Fake([running()]));

    expect((fake.work[0] as Work).history?.failures).toEqual([
      { statement: "the mailer is called", line: "Expected 1, got 0" },
      { statement: "the address is validated", line: "" },
    ]);
  });
});

describe("the writes, through the layer", () => {
  it("counts the attempt by reading the column it then writes", async () => {
    db.prepare("UPDATE task SET attempts = 4 WHERE id = ?").run(task);
    assign("task", task);

    await tick(new Fake([{ phase: "succeeded", session: "s", spent: spent(), commit: "abc" }]));

    expect(db.prepare("SELECT attempts FROM task WHERE id = ?").get(task)).toEqual({ attempts: 5 });
  });

  /** The increment hung off a subquery that matched nothing unless the objective was a
   *  task. A test's attempt must still leave every task's count alone. */
  it("counts nothing against a task when the objective is not one", async () => {
    db.prepare("UPDATE task SET attempts = 4 WHERE id = ?").run(task);
    assign("acceptance_test", acceptance);

    await tick(new Fake([{ phase: "succeeded", session: "s", spent: spent(), commit: "abc" }]));

    expect(db.prepare("SELECT attempts FROM task WHERE id = ?").get(task)).toEqual({ attempts: 4 });
  });

  it("clears the previous answer when a new question is asked", async () => {
    const id = assign("task", task);
    db.prepare("UPDATE assignment SET answer = 'yes', answered_by = 'operator' WHERE id = ?").run(id);

    await tick(
      new Fake([
        running(),
        {
          phase: "waiting",
          session: "s",
          spent: spent(),
          kind: "decision",
          question: "which base?",
          options: ["main", "master"],
        },
      ]),
      2,
    );

    expect(db.prepare("SELECT phase, answer, answered_by, options FROM assignment WHERE id = ?").get(id)).toEqual({
      phase: "waiting",
      answer: null,
      answered_by: null,
      options: '["main","master"]',
    });
  });

  /** `session = coalesce(?, session)`: an adapter that finishes without naming a session
   *  leaves the one already recorded alone rather than clearing it. */
  it("keeps the recorded session when the finishing observation names none", async () => {
    const id = assign("task", task);

    await tick(
      new Fake([
        { phase: "running", session: "sess-1", spent: spent() },
        {
          phase: "succeeded",
          session: null as unknown as string,
          spent: spent(),
          commit: "deadbee",
        },
      ]),
      2,
    );

    expect(db.prepare("SELECT session, commit_sha FROM assignment WHERE id = ?").get(id)).toEqual({
      session: "sess-1",
      commit_sha: "deadbee",
    });
  });

  it("finds no adapter, and fails the assignment, when the worker row is gone", async () => {
    const id = assign("task", task);
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM worker WHERE id = ?").run(worker);

    const report = await new Foreman(db, { agent: new Fake() }).tick();

    expect(report.failed).toEqual([id]);
    expect(db.prepare("SELECT phase, reason FROM assignment WHERE id = ?").get(id)).toEqual({
      phase: "failed",
      reason: "other",
    });
  });
});
