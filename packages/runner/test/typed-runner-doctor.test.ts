import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open, type Violation } from "@wecode/core";
import { Doctor, healLandedMarkers, snapshot, violations, WORLD_CHECK, type Git } from "../src/doctor.js";
import { Examiner, NOT_IN_TREE } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

const doctorSource = readFileSync(fileURLToPath(new URL("../src/doctor.ts", import.meta.url)), "utf8");
const examinerSource = readFileSync(fileURLToPath(new URL("../src/examiner.ts", import.meta.url)), "utf8");

/** The source with its prose taken out. Both files talk *about* SQL — a comment saying the
 *  dialect spells no JOIN is the explanation of the port, not a query — so the assertions
 *  below are made against the code, which is the only place a query could hide. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** `lazy` is the tables a module declares but creates only when it first writes one, so a
 *  record that has never been healed does not have them yet. */
const MODULES: readonly { readonly name: string; readonly source: string; readonly lazy: readonly string[] }[] = [
  { name: "doctor.ts", source: doctorSource, lazy: ["landed_branch"] },
  { name: "examiner.ts", source: examinerSource, lazy: [] },
];

let dir: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let release: number;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A git that answers nothing in particular. The world-facing half of the pass is
 *  `doctor-parity.test.ts`'s subject; what is being proven here is the record half. */
const silent: Git = () => "";

beforeEach(() => {
  dir = tmp("wecode-typed-runner-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@localhost");
  writeFileSync(join(dir, "README.md"), "the base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");

  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  project = make.project(make.workspace("acme", dir), "storefront", dir);
  release = make.release(project, "1.0.0");
});

/** Every column the migrations declare for a table. `rowid` is a real column of every
 *  ordinary table and `table_info` does not list it, so it is named here as the one
 *  exception rather than left to weaken the check for every other name. */
const columnsOf = (name: string): readonly string[] => [
  ...(db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name),
  "rowid",
];

/** Something `table_info` can describe. It answers for `sqlite_master` too, which is a
 *  table the doctor really does select from and which does not list itself. */
const exists = (name: string): boolean => columnsOf(name).length > 1;

describe("the runner's doctor and examiner, ported onto the typed layer", () => {
  /** The point of the port. One `db.prepare` left behind is one query the compiler does not
   *  check, and one is enough to lose the guarantee — so this is spelled as "none", against
   *  the source, rather than as a test of the queries that happened to be ported. */
  it.each(MODULES)("leaves no prepared statement in $name", ({ source }) => {
    expect(code(source)).not.toMatch(/\bprepare\s*\(/);
  });

  it.each(MODULES)("leaves no query text in $name", ({ source }) => {
    const text = code(source);
    expect(
      text.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT|PRAGMA)\b/g),
    ).toBeNull();
  });

  /** The one thing the dialect does not spell, and should not: a `CREATE TABLE` carries no
   *  column name a typecheck could catch, and these two tables are the runner's own. So
   *  `db.exec` survives — for DDL only, which is what this pins. */
  it.each(MODULES)("uses the raw handle in $name for nothing but its own DDL", ({ source }) => {
    const calls = [...code(source).matchAll(/\bdb\.exec\(\s*`([^`]*)`/g)].map((m) => m[1]!.trim());

    expect(calls.length).toBeGreaterThan(0);
    for (const sql of calls) expect(sql.startsWith("CREATE TABLE IF NOT EXISTS")).toBe(true);
    // Every other method of the live handle is gone, including the transaction keywords:
    // `transact` is core's, and two modules opening their own BEGIN is how a tick ends up
    // half-committed.
    expect(code(source)).not.toMatch(/\bdb\.(prepare|get|all|run)\b/);
    expect(code(source)).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/);
  });

  it.each(MODULES)("speaks to the database through core's dialect in $name", ({ source }) => {
    expect(source).toContain('} from "@wecode/core/dist/db.js";');
  });

  /** Every table either module declares is read out of its source and held against the real
   *  schema, so the declaration and the migration cannot drift apart without a test saying
   *  so — and the list lives in the module, not in a copy here. */
  it.each(MODULES)("asks only for columns that are really there, in $name", ({ source, lazy }) => {
    new Doctor(db, [], silent);
    new Examiner(db);
    // A list given by name is resolved to the list itself: the examiner declares its two
    // test tables against one shared const, which is the point of it.
    const named = (list: string): string =>
      list.startsWith("[") ? list : (new RegExp(`const ${list} = (\\[[\\s\\S]*?\\])`).exec(source)?.[1] ?? "");
    const declared = [...source.matchAll(/table<[\s\S]*?>\(\s*"(\w+)",\s*(\[[\s\S]*?\]|\w+)/g)].map((m) => ({
      name: m[1]!,
      columns: [...named(m[2]!).matchAll(/"(\w+)"/g)].map((c) => c[1]!),
    }));

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((d) => !exists(d.name)).map((d) => d.name)).toEqual(lazy);
    for (const d of declared.filter((x) => exists(x.name))) {
      const actual = columnsOf(d.name);
      expect(d.columns.length, d.name).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });

  /** A shared column list is one declaration used twice, not a table name inferred from a
   *  variable: both test tables carry every column the examiner reads. */
  it("declares the examiner's two test tables against the same real column list", () => {
    const shared = [...examinerSource.matchAll(/^const TEST_COLUMNS = \[([\s\S]*?)\] as const;/gm)]
      .flatMap((m) => [...m[1]!.matchAll(/"(\w+)"/g)])
      .map((c) => c[1]!);

    expect(shared.length).toBeGreaterThan(0);
    for (const t of ["task_test", "acceptance_test"]) {
      for (const c of shared) expect(columnsOf(t), `${t}.${c}`).toContain(c);
    }
  });
});

/** Ids that coincide are the trap this port exists to close: every seed makes one epic per
 *  story, so an entity placed by the wrong column is placed correctly anyway. Each fixture
 *  below deliberately pushes the ids apart. */
describe("the snapshot, through the layer", () => {
  const nodesOf = (entity: string): readonly { id: number; parent_id: number | null }[] =>
    snapshot(db).nodes.filter((n) => n.entity === entity);

  it("parents a story by its own epic, not by an epic that shares the story's id", () => {
    const first = make.epic(release, "the first epic");
    const second = make.epic(release, "the second epic");
    // One epic with nothing under it, so the story's id is the *other* epic's.
    const story = make.story(second, "a story");
    expect(story).toBe(first);

    const placed = nodesOf("story").find((n) => n.id === story);

    expect(placed?.parent_id).toBe(second);
  });

  it("parents every entity by the column its own table carries", () => {
    const epic = make.epic(release, "e");
    const story = make.story(epic, "s");
    const requirement = make.requirement(story, "it works");
    const criteria = make.criteria(requirement, "accepted");
    const test = make.acceptanceTest(criteria, "proved", "script", "bash a.sh");
    const task = make.task(test, "do it", { role: "engineer" });
    const unit = make.taskTest(task, "unit", "script", "vitest run");

    const of = (entity: string, id: number): number | null | undefined =>
      nodesOf(entity).find((n) => n.id === id)?.parent_id;

    expect(of("release", release)).toBeNull();
    expect(of("epic", epic)).toBe(release);
    expect(of("story", story)).toBe(epic);
    expect(of("requirement", requirement)).toBe(story);
    expect(of("acceptance_criteria", criteria)).toBe(requirement);
    expect(of("acceptance_test", test)).toBe(criteria);
    expect(of("task", task)).toBe(test);
    expect(of("task_test", unit)).toBe(task);
  });

  it("carries the columns only one entity has", () => {
    const criteria = make.criteria(make.requirement(make.story(make.epic(release, "e"), "s"), "r"), "c");
    const test = make.acceptanceTest(criteria, "proved", "script", "bash a.sh");
    const task = make.task(test, "do it", { role: "engineer" });
    db.prepare("UPDATE acceptance_test SET red_at_base_sha = 'deadbeef' WHERE id = ?").run(test);

    const nodes = snapshot(db).nodes;

    expect(nodes.find((n) => n.entity === "acceptance_test" && n.id === test)?.red_at_base_sha).toBe("deadbeef");
    expect(nodes.find((n) => n.entity === "task" && n.id === task)?.role).toBe("engineer");
  });

  it("comes back in id order however the rows were last touched", () => {
    const epic = make.epic(release, "e");
    const ids = ["a", "b", "c"].map((t) => make.story(epic, t));
    db.prepare("UPDATE story SET title = title WHERE id = ?").run(ids[0]);

    expect(nodesOf("story").map((n) => n.id)).toEqual([...ids].sort((a, b) => a - b));
    expect(snapshot(db).nodes.map((n) => `${n.entity}`)).toContain("release");
  });

  it("says what version the record is at", () => {
    expect(snapshot(db).schema_version).toBeGreaterThan(0);
  });

  it("names no worker before one exists, and every worker's role after", () => {
    expect(snapshot(db).workers).toEqual([]);
    make.worker("claude-1", "engineer", "agent");

    expect(snapshot(db).workers).toEqual([{ slug: "claude-1", role: "engineer" }]);
  });
});

describe("the landed marker, read back up the chain", () => {
  /** A story with `tasks` tasks under it. More than one is what pushes the task ids past
   *  the story ids, so a marker read by id lands somewhere it should not. */
  const storyWithTasks = (title: string, count = 1): { story: number; tasks: number[] } => {
    const story = make.story(make.epic(release, `epic for ${title}`), title);
    const criteria = make.criteria(make.requirement(story, `${title} works`), `${title} accepted`);
    const test = make.acceptanceTest(criteria, `${title} proved`, "script", "bash a.sh");
    const tasks = Array.from({ length: count }, (_, i) => make.task(test, `build ${title} ${i}`, { role: "engineer" }));
    return { story, tasks };
  };

  const markLanded = (task: number, sha: string): void => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS landed_branch (
         task_id INTEGER PRIMARY KEY, branch TEXT NOT NULL, sha TEXT NOT NULL, merged_at TEXT NOT NULL)`,
    );
    db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?, ?, ?, ?)").run(
      task,
      "story/x",
      sha,
      "2026-01-01T00:00:00.000Z",
    );
  };

  const landedShaOf = (story: number): string | null | undefined =>
    snapshot(db).nodes.find((n) => n.entity === "story" && n.id === story)?.landed_sha;

  it("is null everywhere while the lander's table does not exist", () => {
    const { story } = storyWithTasks("password reset");

    expect(landedShaOf(story)).toBeNull();
  });

  it("lands on the story that owns the marked task, and on no other", () => {
    const first = storyWithTasks("password reset", 2);
    const second = storyWithTasks("session timeout");
    const marked = first.tasks[1]!;
    // The trap: that task's id is the *second* story's, so a marker read by id rather than
    // walked up the chain would land the sha on the story that never had it.
    expect(marked).toBe(second.story);
    markLanded(marked, "cafe1234");

    expect(landedShaOf(first.story)).toBe("cafe1234");
    expect(landedShaOf(second.story)).toBeNull();
  });

  it("ignores a marker on a task that is not in the record at all", () => {
    const { story } = storyWithTasks("password reset");
    markLanded(9999, "cafe1234");

    expect(landedShaOf(story)).toBeNull();
  });
});

describe("the recorded report, through the layer", () => {
  const broken: Invariantish = {
    name: "the_moon_is_where_we_left_it",
    check: () => [
      { invariant: "the_moon_is_where_we_left_it", entity: "story", id: 1, slug: "first", detail: "one" },
      { invariant: "the_moon_is_where_we_left_it", entity: "story", id: 2, slug: "second", detail: "two" },
    ],
  };

  it("reads back nothing at all before a pass has ever run", () => {
    expect(violations(db)).toEqual([]);
  });

  it("reads the report back in the order the pass found it", () => {
    new Doctor(db, [broken], silent).check();

    expect(violations(db).map((v) => v.detail)).toEqual(["one", "two"]);
  });

  it("replaces the last report rather than appending to it", () => {
    const doctor = new Doctor(db, [broken], silent);
    doctor.check();
    doctor.check();

    expect(violations(db)).toHaveLength(2);
    expect(violations(db).map((v) => v.id)).toEqual([1, 2]);
  });

  it("writes an empty report when the pass found nothing", () => {
    new Doctor(db, [broken], silent).check();
    new Doctor(db, [], silent).check();

    expect(violations(db)).toEqual([]);
  });
});

/** The `Invariant` shape, without importing the type only to name it once. */
interface Invariantish {
  readonly name: string;
  readonly check: () => readonly Violation[];
}

describe("the heal's writes, through the layer", () => {
  let story: number;
  let slug: string;
  let tasks: readonly number[];

  beforeEach(() => {
    story = make.story(make.epic(release, "recovery"), "password reset");
    const criteria = make.criteria(make.requirement(story, "it works"), "accepted");
    const test = make.acceptanceTest(criteria, "proved", "script", "bash a.sh");
    tasks = [make.task(test, "build it", { role: "engineer" }), make.task(test, "check it", { role: "engineer" })];
    slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(story) as { slug: string }).slug;
  });

  const found = (): readonly Violation[] => [
    { invariant: WORLD_CHECK, entity: "story", id: story, slug, detail: "never reached the base" },
  ];

  /** git as the heal is allowed to see it: one land commit for this story, and a branch
   *  that is not in the base. */
  const gitWith = (sha: string): Git => (args) => {
    if (args[0] === "log") return `${sha}\x1fland story/${slug}\n`;
    if (args[0] === "rev-list") return "1";
    return "ok";
  };

  const markers = (): { task_id: number; branch: string; sha: string }[] =>
    db
      .prepare("SELECT task_id, branch, sha FROM landed_branch ORDER BY task_id")
      .all() as unknown as { task_id: number; branch: string; sha: string }[];

  it("writes one marker per task under the story, and a ledger line saying why", () => {
    const report = healLandedMarkers(db, found(), gitWith("cafe1234"));

    expect(report.written).toEqual([{ story, slug, sha: "cafe1234" }]);
    expect(markers()).toEqual(tasks.map((t) => ({ task_id: t, branch: `story/${slug}`, sha: "cafe1234" })));
    expect(
      db.prepare("SELECT to_state FROM ledger WHERE verb = 'heal' AND entity_id = ?").all(story),
    ).toEqual([{ to_state: `landed_sha cafe1234 from 'land story/${slug}'` }]);
  });

  /** The upsert, which is the one query here the dialect newly spells. A second heal over a
   *  story whose markers exist rewrites them; it must not fail on the primary key, and it
   *  must not leave two rows claiming one task. */
  it("rewrites a marker that is already there rather than duplicating it", () => {
    healLandedMarkers(db, found(), gitWith("cafe1234"));
    healLandedMarkers(db, found(), gitWith("f00dbeef"));

    expect(markers()).toEqual(tasks.map((t) => ({ task_id: t, branch: `story/${slug}`, sha: "f00dbeef" })));
  });

  it("says a story reached the base inside another merge once, not once per pass", () => {
    // No commit of its own, but the branch is in: the heal has no sha to copy.
    const inTheBase: Git = (args) => (args[0] === "log" ? "" : args[0] === "rev-list" ? "0" : "ok");

    const first = healLandedMarkers(db, found(), inTheBase);
    const second = healLandedMarkers(db, found(), inTheBase);

    expect(first.reached).toEqual([{ story, slug }]);
    expect(second.reached).toEqual([{ story, slug }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE verb = 'heal'").get()).toEqual({ n: 1 });
    expect(markers).toBeTruthy();
  });

  it("refuses a story with no task to carry the marker, and writes nothing", () => {
    db.prepare("DELETE FROM task").run();

    const report = healLandedMarkers(db, found(), gitWith("cafe1234"));

    expect(report.written).toEqual([]);
    expect(report.left).toEqual([{ story, slug, why: "no task under the story to carry the marker" }]);
  });
});

describe("the examiner's selection, through the layer", () => {
  let story: number;
  let criteria: number;

  beforeEach(() => {
    story = make.story(make.epic(release, "e"), "s");
    criteria = make.criteria(make.requirement(story, "r"), "c");
  });

  /** A ready task with one script test that cannot run: `unrunnable` is the one verdict the
   *  examiner reaches without the engine, so what it selected is visible on its own. */
  const scriptTask = (title: string): { task: number; test: number; unit: number } => {
    const test = make.acceptanceTest(criteria, `${title} proved`, "script", "bash ./gone.sh");
    const task = make.task(test, title, { role: "engineer" });
    const unit = make.taskTest(task, `${title} unit`, "script", "bash ./gone.sh");
    db.prepare("UPDATE task_test SET state = 'ready' WHERE id = ?").run(unit);
    db.prepare("UPDATE acceptance_test SET state = 'ready' WHERE id = ?").run(test);
    return { task, test, unit };
  };

  const lastOutput = (table: string, id: number): string | null =>
    (db.prepare(`SELECT last_output FROM ${table} WHERE id = ?`).get(id) as { last_output: string | null })
      .last_output;

  it("reads a task's own tests, not one whose id happens to be the task's", async () => {
    const first = scriptTask("first");
    make.taskTest(first.task, "first extra", "script", "bash ./gone.sh");
    const second = scriptTask("second");
    // The trap: the second task's own test is id 3, while id 2 belongs to the first task.
    expect(second.unit).not.toBe(second.task);

    const report = await new Examiner(db).runTaskTests(second.task, dir);

    expect(report.unrunnable).toEqual([second.unit]);
  });

  it("leaves out a test whose kind is not script, and one with no command", async () => {
    const { task, unit } = scriptTask("first");
    const manual = make.taskTest(task, "by hand", "manual");
    const empty = make.taskTest(task, "no command", "script");
    db.prepare("UPDATE task_test SET state = 'ready' WHERE id IN (?, ?)").run(manual, empty);

    const report = await new Examiner(db).runTaskTests(task, dir);

    expect(report.unrunnable).toEqual([unit]);
  });

  it("leaves out a test whose verdict is already settled", async () => {
    const { task, unit } = scriptTask("first");

    for (const state of ["ready", "failed"]) {
      db.prepare("UPDATE task_test SET state = ? WHERE id = ?").run(state, unit);
      expect((await new Examiner(db).runTaskTests(task, dir)).unrunnable, state).toEqual([unit]);
    }
    for (const state of ["planned", "passed", "dropped"]) {
      db.prepare("UPDATE task_test SET state = ? WHERE id = ?").run(state, unit);
      expect((await new Examiner(db).runTaskTests(task, dir)).unrunnable, state).toEqual([]);
    }
  });

  /** The risk a `Record<entity, table>` lookup carries: id 1 exists in both test tables, so
   *  a write that reached the wrong one would still find a row and still say nothing. */
  it("writes to the table the entity names, not the other one holding that id", async () => {
    const { task, test, unit } = scriptTask("first");
    expect(unit).toBe(test);

    await new Examiner(db).runTaskTests(task, dir);

    expect(lastOutput("task_test", unit)).toContain(NOT_IN_TREE);
    expect(lastOutput("acceptance_test", test)).toBeNull();
  });

  it("reads the acceptance tests of the story it was asked about, up the criteria chain", async () => {
    // Two requirements under this story, so the second story's ids do not line up with it.
    const spare = make.criteria(make.requirement(story, "r2"), "c2");
    const mine = scriptTask("mine");
    const other = make.story(make.epic(release, "e2"), "s2");
    const theirs = make.acceptanceTest(
      make.criteria(make.requirement(other, "r3"), "c3"),
      "theirs proved",
      "script",
      "bash ./gone.sh",
    );
    db.prepare("UPDATE acceptance_test SET state = 'ready' WHERE id = ?").run(theirs);
    // Nothing is waited on: what is being proven here is whose tests were chosen.
    db.prepare("UPDATE task SET state = 'done'").run();
    expect(spare).toBeGreaterThan(0);

    const report = await new Examiner(db).runAcceptanceTests(story, dir);

    expect(report.unrunnable).toEqual([mine.test]);
  });

  it("waits for every task under the test to finish before judging it", async () => {
    const { task, test } = scriptTask("mine");

    expect((await new Examiner(db).runAcceptanceTests(story, dir)).unrunnable).toEqual([]);
    for (const state of ["done", "dropped"]) {
      db.prepare("UPDATE task SET state = ? WHERE id = ?").run(state, task);
      expect((await new Examiner(db).runAcceptanceTests(story, dir)).unrunnable, state).toEqual([test]);
    }
  });
});

describe("the run that already stands, through the layer", () => {
  let task: number;
  let unit: number;

  beforeEach(() => {
    const story = make.story(make.epic(release, "e"), "s");
    const criteria = make.criteria(make.requirement(story, "r"), "c");
    const test = make.acceptanceTest(criteria, "proved", "script", "false");
    task = make.task(test, "do it", { role: "engineer" });
    // A command that fails, so the verdict leaves the test in `failed` — a test that passed
    // is settled and would never be offered a second pass to skip.
    unit = make.taskTest(task, "unit", "script", "false");
    // Already failed once: a test in `ready` has no verdict to stand on and always runs.
    db.prepare("UPDATE task_test SET state = 'failed' WHERE id = ?").run(unit);
  });

  const runs = (): { entity: string; fingerprint: string }[] =>
    db.prepare("SELECT entity, fingerprint FROM script_run").all() as unknown as {
      entity: string;
      fingerprint: string;
    }[];

  it("records what the run was against, once per test", async () => {
    await new Examiner(db).runTaskTests(task, dir);

    expect(runs()).toHaveLength(1);
    expect(runs()[0]?.entity).toBe("task_test");
  });

  it("skips the second pass over an unchanged tree, and overwrites the print when it moves", async () => {
    await new Examiner(db).runTaskTests(task, dir);
    const first = runs()[0]?.fingerprint;

    expect((await new Examiner(db).runTaskTests(task, dir)).skipped).toEqual([unit]);

    // The artefact is part of the print, so retyping the command is a tree that moved.
    db.prepare("UPDATE task_test SET artefact = 'false # again' WHERE id = ?").run(unit);
    expect((await new Examiner(db).runTaskTests(task, dir)).skipped).toEqual([]);
    // Upserted, not appended: one row still claims this test, with the new print.
    expect(runs()).toHaveLength(1);
    expect(runs()[0]?.fingerprint).not.toBe(first);
  });
});
