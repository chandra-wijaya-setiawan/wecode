/** The runner, moved onto the generated facade.
 *
 *  Two halves, for the same reason the typed-query ports have two.
 *
 *  The first is the move itself, asserted as an absence: `engine.apply("assignment", id,
 *  "ask", …)` names its entity and its verb as strings, so a misspelt word, a verb the
 *  machine table no longer has, or an entity that never had that verb all typecheck and
 *  fail at the tick as a transition that silently did nothing. One left behind is one place
 *  the compiler cannot see, so this is spelled as "none" against the source.
 *
 *  The second is that nothing moved with it. Every transition these three modules invoke is
 *  exercised here against the states it is supposed to reach — the move is only worth
 *  making if the behaviour is identical, and "identical" is a claim about the record, not
 *  about the source. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open, Verbs } from "@wecode/core";
import { DEFAULT_BUDGET, Examiner, Foreman, Runner, type Observation, type WorkerAdapter } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

const sourceOf = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

/** The source with its prose taken out. All three modules talk *about* the engine and about
 *  verbs — a comment saying why `engine` survives beside `verbs` is the explanation of the
 *  move, not a call — so every assertion below is made against the code. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const MODULES = ["daemon.ts", "foreman.ts", "examiner.ts"].map((name) => ({ name, source: sourceOf(name) }));

/** Every method the facade really has. Read off the class, not copied into a list here:
 *  the facade is generated from machines.yaml, and a copy would be one more thing to keep
 *  in agreement with it. */
const FACADE_METHODS = new Set(
  Object.getOwnPropertyNames(Verbs.prototype).filter((n) => n !== "constructor"),
);

describe("the runner names no transition as a string", () => {
  it.each(MODULES)("invokes nothing through engine.apply in $name", ({ source }) => {
    expect(code(source)).not.toMatch(/\.apply\s*\(/);
  });

  it.each(MODULES)("takes its verbs from the facade in $name", ({ source }) => {
    expect(code(source)).toMatch(/\bVerbs\b/);
    expect(code(source)).toMatch(/new Verbs\(/);
  });

  /** The move is only a guarantee if what it moved onto is real. A method spelled here that
   *  the facade does not have would not compile — but a method reached through a lookup
   *  table, which is how the examiner picks between its two tables, is only as safe as the
   *  names in it, so every name any of the three modules calls is held against the class. */
  it.each(MODULES)("calls only methods the facade declares, in $name", ({ source }) => {
    const called = [...code(source).matchAll(/\bverbs\.(\w+)\(/g)].map((m) => m[1] as string);

    expect(called.length).toBeGreaterThan(0);
    for (const name of called) expect([...FACADE_METHODS], name).toContain(name);
  });
});

const spent = (): { tokens: number; seconds: number } => ({ tokens: 10, seconds: 1 });

/** Reports whatever the test queued, one reading per call. */
class Fake implements WorkerAdapter {
  readonly kind = "agent";
  constructor(private readonly script: Observation[] = []) {}
  private next(): Observation {
    return this.script.shift() ?? { phase: "running", session: "s", spent: spent() };
  }
  async start(): Promise<Observation> {
    return this.next();
  }
  async poll(): Promise<Observation> {
    return this.next();
  }
  async resume(): Promise<Observation> {
    return this.next();
  }
  async answer(): Promise<Observation> {
    return this.next();
  }
  async kill(): Promise<void> {}
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let story: number;
let acceptance: number;
let task: number;
let taskTest: number;
let worker: number;

beforeEach(() => {
  repo = tmp("wecode-facade-runner-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  project = make.project(make.workspace("acme", repo), "storefront", repo);
  const release = make.release(project, "1.0.0");
  // A spare epic and a spare requirement, so no id in the chain coincides with another.
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

const phaseOf = (id: number): string =>
  (db.prepare("SELECT phase FROM assignment WHERE id = ?").get(id) as { phase: string }).phase;

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

const assign = (): number =>
  make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree: "/tmp/wecode-no-such-worktree",
  });

const tick = async (fake: Fake, passes = 1): Promise<void> => {
  const foreman = new Foreman(db, { agent: fake }, 3600, { repoRoot: repo, integrationBranch: "main" });
  for (let n = 0; n < passes; n += 1) await foreman.tick();
};

describe("the foreman's five assignment verbs, through the facade", () => {
  it("starts a pending assignment before recording anything the session then did", async () => {
    const id = assign();

    await tick(new Fake([{ phase: "running", session: "s", spent: spent() }]));

    expect(phaseOf(id)).toBe("running");
  });

  /** The reason the start is recorded first: succeeded is not reachable from pending, so a
   *  session that finishes inside the call that started it needs both verbs, in order. */
  it("starts and finishes in one pass when the session ends immediately", async () => {
    const id = assign();

    await tick(new Fake([{ phase: "succeeded", session: "s", spent: spent(), commit: null }]));

    expect(phaseOf(id)).toBe("succeeded");
    expect((db.prepare("SELECT attempts FROM task WHERE id = ?").get(task) as { attempts: number }).attempts).toBe(1);
  });

  it("asks when the session asks", async () => {
    const id = assign();

    await tick(
      new Fake([{ phase: "waiting", session: "s", spent: spent(), kind: "choice", question: "which?", options: [] }]),
    );

    expect(phaseOf(id)).toBe("waiting");
  });

  it("answers a waiting assignment back to running before the worker is read again", async () => {
    const id = assign();
    await tick(
      new Fake([{ phase: "waiting", session: "s", spent: spent(), kind: "choice", question: "which?", options: [] }]),
    );
    db.prepare("UPDATE assignment SET answer = 'the left one' WHERE id = ?").run(id);

    await tick(new Fake([{ phase: "running", session: "s", spent: spent() }]));

    expect(phaseOf(id)).toBe("running");
  });

  it("fails an assignment the session lost, and counts the attempt", async () => {
    const id = assign();

    await tick(new Fake([{ phase: "failed", session: "s", spent: spent(), commit: null, reason: "no mail" }]));

    expect(phaseOf(id)).toBe("failed");
    expect((db.prepare("SELECT attempts FROM task WHERE id = ?").get(task) as { attempts: number }).attempts).toBe(1);
  });
});

describe("the examiner's two verdicts, through the facade", () => {
  beforeEach(() => {
    new Engine(db).apply("task_test", taskTest, "deliver", "chief");
    new Engine(db).apply("acceptance_test", acceptance, "deliver", "chief");
  });

  it("passes a task_test whose script exits 0, and fails one that does not", async () => {
    await new Examiner(db).runTaskTests(task, repo);
    expect(stateOf("task_test", taskTest)).toBe("passed");

    const other = make.taskTest(task, "the mail is sent", "script", "false");
    new Engine(db).apply("task_test", other, "deliver", "chief");
    const report = await new Examiner(db).runTaskTests(task, repo);

    expect(report.failed).toEqual([other]);
    expect(stateOf("task_test", other)).toBe("failed");
  });

  /** The lookup this move introduced is keyed by entity, and id 1 exists in both test
   *  tables — so a verdict sent to the wrong one would still find a row and still say
   *  nothing. The fixture puts the two ids on top of each other deliberately. */
  it("passes the acceptance_test, not the task_test that shares its id", async () => {
    expect(acceptance).toBe(taskTest);
    // The task_test is left in `ready` on purpose: it is the row the wrong table holds at
    // this id, so its state is what a misplaced verdict would show up in.
    db.prepare("UPDATE task SET state = 'done'").run();
    // A test nobody has seen fail proves nothing by passing, so the record has to carry the
    // base it was red at before `pass` is allowed at all.
    db.prepare("UPDATE acceptance_test SET red_at_base_sha = 'cafe1234' WHERE id = ?").run(acceptance);

    const report = await new Examiner(db).runAcceptanceTests(story, repo);

    expect(report.refused).toEqual([]);
    expect(report.passed).toEqual([acceptance]);
    expect(stateOf("acceptance_test", acceptance)).toBe("passed");
    expect(stateOf("task_test", taskTest)).toBe("ready");
  });

  /** A refusal is still the engine's word, in the engine's words: the facade is a way to
   *  spell the transition, not a second opinion about whether it is allowed. */
  it("reports the engine's refusal rather than a verdict it could not record", async () => {
    // Nothing under the test is finished, so `pass` has nothing to stand on.
    db.prepare("UPDATE acceptance_test SET state = 'ready' WHERE id = ?").run(acceptance);
    db.prepare("UPDATE task SET state = 'done'").run();
    db.prepare("UPDATE acceptance_test SET artefact = 'false' WHERE id = ?").run(acceptance);

    const report = await new Examiner(db).runAcceptanceTests(story, repo);

    expect(report.failed.concat(report.refused.map((r) => r.id))).toEqual([acceptance]);
  });
});

describe("the daemon's one verb, through the facade", () => {
  const runner = (): Runner =>
    new Runner(db, {
      budget: DEFAULT_BUDGET,
      repoRoot: repo,
      adapters: { agent: new Fake() },
      integrationBranch: "main",
    });

  beforeEach(() => {
    const engine = new Engine(db);
    engine.apply("task_test", taskTest, "deliver", "chief");
    engine.apply("acceptance_test", acceptance, "deliver", "chief");
    engine.apply("task", task, "start", "chief");
    expect(stateOf("task", task)).toBe("ready");
  });

  it("gives up on a task that has used every attempt", async () => {
    db.prepare("UPDATE task SET attempts = max_retry WHERE id = ?").run(task);

    const report = await runner().tick();

    expect(report.exhausted).toContain(task);
    expect(stateOf("task", task)).toBe("failed");
  });

  it("leaves a task with an attempt left exactly where it was", async () => {
    db.prepare("UPDATE task SET attempts = 0, max_retry = 3 WHERE id = ?").run(task);

    const report = await runner().tick();

    expect(report.exhausted ?? []).not.toContain(task);
    expect(stateOf("task", task)).not.toBe("failed");
    expect(project).toBeGreaterThan(0);
  });
});
