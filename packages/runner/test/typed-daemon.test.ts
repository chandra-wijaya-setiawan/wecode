import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

const source = readFileSync(fileURLToPath(new URL("../src/daemon.ts", import.meta.url)), "utf8");

/** The module with its comments taken out. Every assertion about the SQL left in the source
 *  is made against this: the port replaced SQL with prose *about* SQL, and a comment saying
 *  "the dialect spells no ORDER BY" must not read as an ORDER BY. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The one thing the dialect has no spelling for: creating the runner's own side table.
 *  Cut out by name, so that this is the only SQL the assertions below tolerate — a second
 *  statement smuggled in beside it would not match and would fail them. */
const DDL = /db\.exec\(\s*`CREATE TABLE IF NOT EXISTS landed_branch \([^`]*`,?\s*\);/;
const withoutDdl = code.replace(DDL, "");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Writes the file it was told to, then reports success: the smallest real worker.
 *
 *  It writes where the assignment says and nowhere else. A `Work` whose worktree is empty,
 *  relative or missing used to resolve against `process.cwd()`, which under vitest is this
 *  repository — so a fixture worker would drop `mail.ts` into the real checkout and the
 *  stray outlived the run. Refusing is what a real adapter does with the same work (see
 *  `refuseWithoutWorktree`), so the double refuses too rather than writing somewhere. */
class Writer implements WorkerAdapter {
  readonly kind = "agent";
  /** Every path it has written, for the tests that ask where the work landed. */
  readonly wrote: string[] = [];
  constructor(private readonly file = "mail.ts") {}
  async start(w: Work): Promise<Observation> {
    const tree = w.worktree;
    if (tree.trim() === "" || !isAbsolute(tree) || !existsSync(tree) || !statSync(tree).isDirectory()) {
      throw new Error(`refusing to write outside a worktree: assignment ${w.id} names ${JSON.stringify(tree)}`);
    }
    const path = join(tree, this.file);
    writeFileSync(path, "export const send = () => {};\n");
    this.wrote.push(path);
    return { phase: "succeeded", session: "s1", spent: { tokens: 5, seconds: 1 }, commit: null };
  }
  async poll(w: Work): Promise<Observation> {
    return { phase: "running", session: w.session ?? "", spent: { tokens: 0, seconds: 0 } };
  }
  async answer(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async kill(): Promise<void> {}
}

let repo: string;
let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let task: number;
let acceptance: number;
let story: number;
let criteria: number;
let workerOne: number;

beforeEach(() => {
  repo = tmp("wecode-typed-daemon-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);

  const ws = make.workspace("acme", repo);
  const p = make.project(ws, "storefront", repo);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "recovery");
  story = make.story(e, "password reset");
  const req = make.requirement(story, "one change per link");
  criteria = make.criteria(req, "emailed in 60s");
  acceptance = make.acceptanceTest(criteria, "mail arrives", "script", "test -f mail.ts");
  task = make.task(acceptance, "send the mail", { role: "engineer", scope: { write: ["mail.ts"], tools: [] } });
  const tt = make.taskTest(task, "mailer called", "script", "true");
  // Two workers, so "the lowest free one" is an answer and not the only one.
  workerOne = make.worker("claude-1", "engineer", "agent");
  make.worker("claude-2", "engineer", "agent");

  for (const [entity, id] of [
    ["project", p],
    ["release", rel],
    ["epic", e],
    ["story", story],
    ["requirement", req],
    ["acceptance_criteria", criteria],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", acceptance, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
});

const runner = (adapter: WorkerAdapter = new Writer()): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    adapters: { agent: adapter },
    integrationBranch: "main",
  });

describe("the daemon, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement in the module", () => {
    expect(code).not.toMatch(/\bprepare\s*\(/);
  });

  /** `db.exec` of the `landed_branch` DDL is the one call left, and it is not a query: the
   *  dialect compiles SELECT, INSERT, UPDATE and DELETE and has no spelling for CREATE
   *  TABLE, and this table is the runner's own, made beside the record on first use. Pinned
   *  to exactly that one call, so a query cannot come back in through `exec`. */
  it("touches the database itself only to create its own side table", () => {
    expect(code.match(/\bdb\.(prepare|exec|get|all|run)\b/g)).toEqual(["db.exec"]);
    expect(code).toMatch(DDL);
    expect(withoutDdl.match(/\bdb\.(prepare|exec|get|all|run)\b/g)).toBeNull();
  });

  it("has no SQL text left in it besides that DDL", () => {
    const sql = withoutDdl.match(
      /\b(SELECT|INSERT INTO|DELETE FROM|UPDATE [a-z_]+ SET|FROM [a-z_]+|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT|DISTINCT|NOT EXISTS)\b/g,
    );
    expect(sql).toBeNull();
  });

  it("speaks to the database through the dialect", () => {
    expect(code).toContain("from \"@wecode/core/dist/db.js\"");
    expect(code).toMatch(/queries\(this\.db\)/);
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migrations cannot drift apart without a test saying
   *  so — and the list lives in the module, not in a copy here. The runner's two side
   *  tables are included: a `Runner` has been constructed by then, and constructing one is
   *  what creates them. */
  it("asks only for columns the schema actually has", () => {
    runner();
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
      "landed_branch",
      "project",
      "refusal",
      "release",
      "requirement",
      "script_run",
      "story",
      "task",
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
});

describe("allocation, through the layer", () => {
  it("gives the work to the lowest-numbered free worker", async () => {
    const r = await runner().tick();

    const a = db.prepare("SELECT worker_id, objective_id, commit_sha FROM assignment WHERE id = ?").get(
      r.allocated.created,
    ) as { worker_id: number; objective_id: number; commit_sha: string };
    expect(a.objective_id).toBe(task);
    expect(a.worker_id).toBe(workerOne);
    // settleEnded's UPDATE, which is the one write the port makes through the dialect's
    // `update`: the sha is on the row the attempt belongs to.
    expect(a.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.committed).toEqual([r.allocated.created]);
  });

  it("holds a worker that already has an open assignment against the role", async () => {
    // Every worker busy, so the pass has nowhere to put the task and says so. The open
    // assignments are on chores, not on this task: an assignment against the task itself
    // would stop it being a candidate at all, and then there would be no refusal to read.
    for (const w of db.prepare("SELECT id FROM worker").all() as unknown as { id: number }[]) {
      make.assignment({
        objective_type: "chore" as "task",
        objective_id: 9_000 + w.id,
        worker_id: w.id,
        scope: { write: [], tools: [] },
        budget: { tokens: 1, seconds: 1 },
        worktree: "",
      });
    }

    const r = await runner().tick();

    expect(r.allocated.created).toBeNull();
    const why = (db.prepare("SELECT why FROM refusal WHERE task_id = ?").get(task) as { why: string } | undefined)?.why;
    expect(why).toContain("no worker free for role engineer");
  });

  it("clears a refusal for a task the pass no longer speaks about", async () => {
    db.prepare("INSERT INTO refusal (task_id, why, at) VALUES (?, ?, ?)").run(task, "yesterday's reason", "2020-01-01");
    // The task is dropped, so it is not a candidate and nothing decides about it: the sweep
    // over `refusal` is the only thing that can take the stale row away.
    engine.apply("task", task, "drop", "chief");

    await runner().tick();

    expect(db.prepare("SELECT count(*) AS n FROM refusal").get()).toEqual({ n: 0 });
  });
});

/** The merge-base of the story branch and main, which is the base a test is proved at. */
const baseOf = (slug: string): string => git(repo, "merge-base", `story/${slug}`, "main");

/** This checkout, which is where a worker that escapes its worktree writes: a relative path
 *  resolves against the vitest process's cwd, and that is the repository itself. */
const checkout = git(process.cwd(), "rev-parse", "--show-toplevel");

/** True when `path` is inside `dir` — a plain prefix test is wrong, `/tmp/a-2` starts with
 *  `/tmp/a`. */
const inside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

describe("the writer stays inside its worktree", () => {
  it("writes into the tree the assignment was given, under the repo's worktree root", async () => {
    const writer = new Writer();
    const r = await runner(writer).tick();

    const tree = (
      db.prepare("SELECT worktree FROM assignment WHERE id = ?").get(r.allocated.created) as { worktree: string }
    ).worktree;
    expect(writer.wrote).toEqual([join(tree, "mail.ts")]);
    expect(inside(join(repo, ".wecode", "worktrees"), tree)).toBe(true);
  });

  it("leaves nothing of itself outside the temporary repository", async () => {
    const before = existsSync(join(checkout, "mail.ts"));
    const writer = new Writer();
    await runner(writer).tick();

    for (const path of writer.wrote) expect(inside(repo, path), path).toBe(true);
    // The stray this story is about: the suite must not add one to the real checkout.
    expect(existsSync(join(checkout, "mail.ts"))).toBe(before);
    expect(before).toBe(false);
  });

  it("refuses work that names no worktree rather than writing relative to the cwd", async () => {
    const writer = new Writer("escaped.ts");
    const work = { id: 1, objective_type: "task", objective_id: task, worktree: "" } as unknown as Work;

    await expect(writer.start(work)).rejects.toThrow(/refusing to write outside a worktree/);
    expect(writer.wrote).toEqual([]);
    expect(existsSync(resolve(process.cwd(), "escaped.ts"))).toBe(false);
  });

  it("refuses a worktree that is a relative path, which is how the cwd gets written into", async () => {
    const writer = new Writer("escaped.ts");
    const work = { id: 2, objective_type: "task", objective_id: task, worktree: "." } as unknown as Work;

    await expect(writer.start(work)).rejects.toThrow(/refusing to write outside a worktree/);
    expect(existsSync(resolve(process.cwd(), "escaped.ts"))).toBe(false);
  });

  it("refuses a worktree that has been pruned", async () => {
    const writer = new Writer();
    const gone = join(repo, ".wecode", "worktrees", "never-cut");
    const work = { id: 3, objective_type: "task", objective_id: task, worktree: gone } as unknown as Work;

    await expect(writer.start(work)).rejects.toThrow(/refusing to write outside a worktree/);
    expect(existsSync(gone)).toBe(false);
  });
});

describe("the run at base, through the layer", () => {
  it("records red at base on the test's own columns, and fingerprints the run", async () => {
    const r = await runner().tick();

    expect(r.redAtBase.proven).toEqual([acceptance]);
    const row = db
      .prepare("SELECT red_at_base_sha, red_at_base_at, red_at_base_reason, updated_at FROM acceptance_test WHERE id = ?")
      .get(acceptance) as {
      red_at_base_sha: string;
      red_at_base_at: string;
      red_at_base_reason: string | null;
      updated_at: string;
    };
    expect(row.red_at_base_sha).toBe(baseOf("password-reset"));
    expect(row.red_at_base_reason).toBeNull();

    const run = db
      .prepare("SELECT entity, test_id, fingerprint, ran_at FROM script_run WHERE entity = 'acceptance_test@base'")
      .all() as unknown as { entity: string; test_id: number; fingerprint: string; ran_at: string }[];
    expect(run).toEqual([
      {
        entity: "acceptance_test@base",
        test_id: acceptance,
        fingerprint: `${row.red_at_base_sha}|test -f mail.ts`,
        ran_at: row.red_at_base_at,
      },
    ]);
    // One read of the clock for both writes. Pinned against the ledger of runs rather than
    // against `updated_at`, which the story's own proving pass overwrites later in the same
    // tick — and not against a stamp the fixture wrote, because two writes in the same
    // millisecond are indistinguishable.
    expect(run[0]?.ran_at).toBe(row.red_at_base_at);
  });

  it("says a test that passes at base proves nothing, and leaves no sha", async () => {
    const green = make.acceptanceTest(criteria, "it builds", "script", "true");
    engine.apply("acceptance_test", green, "deliver", "chief");

    const r = await runner().tick();

    expect(r.redAtBase.unproven).toContain(green);
    const row = db.prepare("SELECT red_at_base_sha, red_at_base_reason FROM acceptance_test WHERE id = ?").get(green) as {
      red_at_base_sha: string | null;
      red_at_base_reason: string;
    };
    // `red_at_base_sha = NULL` is written as an assignment of null and read back as null,
    // not as the string "null": the dialect binds it as a parameter.
    expect(row.red_at_base_sha).toBeNull();
    expect(row.red_at_base_reason).toBe("it passes at base, so it cannot fail");
  });

  it("does not run the same test at the same base twice", async () => {
    await runner().tick();
    const print = (db.prepare("SELECT fingerprint, ran_at FROM script_run WHERE test_id = ? AND entity = 'acceptance_test@base'").get(acceptance)) as {
      fingerprint: string;
      ran_at: string;
    };
    // The sha column is what the query filters on, so it is cleared: what must stop the
    // second run now is the fingerprint alone.
    db.prepare("UPDATE acceptance_test SET red_at_base_sha = NULL, state = 'ready' WHERE id = ?").run(acceptance);

    const again = await runner().tick();

    expect(again.redAtBase).toEqual({ proven: [], unproven: [] });
    expect(db.prepare("SELECT fingerprint, ran_at FROM script_run WHERE test_id = ? AND entity = 'acceptance_test@base'").get(acceptance)).toEqual(print);
    // and nothing was recorded against the test the second time round
    expect(
      (db.prepare("SELECT red_at_base_sha FROM acceptance_test WHERE id = ?").get(acceptance) as {
        red_at_base_sha: string | null;
      }).red_at_base_sha,
    ).toBeNull();
  });
});

describe("landing, through the layer", () => {
  it("writes the branch and its tip to landed_branch, and lands nothing a second time", async () => {
    const first = await runner().tick();
    expect(first.merged).toEqual([task]);

    const tip = git(repo, "rev-parse", "task/send-the-mail");
    expect(db.prepare("SELECT task_id, branch, sha FROM landed_branch").all()).toEqual([
      { task_id: task, branch: "task/send-the-mail", sha: tip },
    ]);

    const second = await runner().tick();
    expect(second.merged).toEqual([]);
    // one row still, not two: the upsert is keyed on the task
    expect(db.prepare("SELECT count(*) AS n FROM landed_branch").get()).toEqual({ n: 1 });
  });
});

/** A second project, with an extra epic in it so that its story's id is not its epic's id.
 *  The ERD walk this port replaced eight-way joins with has to pick rows out by the chain:
 *  with one epic per story the ids coincide and a lookup keyed on the wrong one still gives
 *  the right answer. Returns the second project's task and story slug. */
function secondProject(): { task: number; story: string } {
  const ws = (db.prepare("SELECT id FROM workspace LIMIT 1").get() as { id: number }).id;
  const p = make.project(ws, "billing", repo);
  const rel = make.release(p, "2.0.0");
  make.epic(rel, "spare"); // never used: it is here to move the ids apart
  const e = make.epic(rel, "invoices");
  const s = make.story(e, "monthly invoice");
  const req = make.requirement(s, "one invoice per month");
  const c = make.criteria(req, "sent on the first");
  const at = make.acceptanceTest(c, "invoice arrives", "script", "test -f invoice.ts");
  const t = make.task(at, "write the invoice", { role: "engineer", scope: { write: ["invoice.ts"], tools: [] } });
  const tt = make.taskTest(t, "invoice unit", "script", "true");
  for (const [entity, id] of [
    ["project", p],
    ["release", rel],
    ["epic", e],
    ["story", s],
    ["requirement", req],
    ["acceptance_criteria", c],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", t, "start", "chief");
  return { task: t, story: "monthly-invoice" };
}

describe("drift, through the layer", () => {
  /** No task_test can pass, so the attempt this tick makes proves nothing and the task is
   *  still owed at the end of it. Without this the tick's own worker finishes the task and
   *  a done task is not drift. */
  const nothingPasses = (): void => {
    db.prepare("UPDATE task_test SET artefact = 'test -f never.ts'").run();
  };

  it("names each exhausted task's own story, in a workspace where the ids do not coincide", async () => {
    const other = secondProject();
    nothingPasses();
    expect(
      (db.prepare("SELECT epic_id FROM story WHERE slug = ?").get(other.story) as { epic_id: number }).epic_id,
    ).not.toBe((db.prepare("SELECT id FROM story WHERE slug = ?").get(other.story) as { id: number }).id);
    db.prepare("UPDATE task SET attempts = max_retry").run();

    const r = await runner().tick();

    expect(r.drift.map((d) => ({ slug: d.slug, story: d.story })).sort((a, b) => a.slug.localeCompare(b.slug))).toEqual([
      { slug: "send-the-mail", story: "password-reset" },
      { slug: "write-the-invoice", story: "monthly-invoice" },
    ]);
    expect(r.drift.map((d) => d.task).sort()).toEqual([task, other.task].sort());
    for (const d of r.drift) expect(d.why).toContain(`wecode task retry ${d.task} --reason`);
  });

  it("says nothing about a task whose story is already delivered", async () => {
    db.prepare("UPDATE task SET attempts = max_retry, state = 'failed' WHERE id = ?").run(task);
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(story);

    expect((await runner().tick()).drift).toEqual([]);
  });

  it("stops a ready task that has used its attempts", async () => {
    nothingPasses();
    db.prepare("UPDATE task SET attempts = max_retry WHERE id = ?").run(task);

    const r = await runner().tick();

    expect(r.exhausted).toEqual([task]);
    expect(db.prepare("SELECT state FROM task WHERE id = ?").get(task)).toEqual({ state: "failed" });
  });
});
