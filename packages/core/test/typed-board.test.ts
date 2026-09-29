import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Aged, Row } from "../src/board/row.js";
import { byId, elapsed, folded, instant, lastLine, minutes, thousands } from "../src/board/row.js";
import { board, clearRefusal, Engine, openAssignments, recordRefusal, recordScopeRefusal } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const source = readFileSync(fileURLToPath(new URL("../src/board.ts", import.meta.url)), "utf8");
const rowSource = readFileSync(fileURLToPath(new URL("../src/board/row.ts", import.meta.url)), "utf8");

/** The module with its prose taken out. The comments quote the SQL the port replaced —
 *  which is the only way a reader can see what `storyOfTask` used to be — so "no SQL left"
 *  is a claim about the code, and the code is what this holds it against. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

const T = "2026-09-13T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** Minutes ago, as the record writes a timestamp. */
const ago = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const epicIn = (release: number, slug: string, state = "in_progress"): number =>
  ins(
    "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    release,
    slug,
    state,
    T,
    T,
  );

const storyIn = (epic: number, slug: string, state = "in_progress", updated = T): number =>
  ins(
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    epic,
    slug,
    state,
    T,
    updated,
  );

/** A second project in the same workspace, down to a release and an epic. Two projects is
 *  the only place a mistaken walk up shows: with one, every wrong answer is still right. */
const otherProject = (slug: string): { project: number; release: number; epic: number } => {
  const project = ins(
    "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    slug,
    tree.ws,
    slug,
    `/${slug}`,
    "in_progress",
    T,
    T,
  );
  const release = ins(
    "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    `${slug}-v1`,
    project,
    "1.0",
    "in_progress",
    T,
    T,
  );
  return { project, release, epic: epicIn(release, `${slug}-epic`) };
};

const worker = (name: string): number =>
  ins(
    "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    name,
    name,
    "engineer",
    "agent",
    T,
    T,
  );

const assign = (
  slug: string,
  a: {
    objective_type?: string;
    objective_id?: number;
    worker_id?: number;
    phase?: string;
    kind?: string | null;
    question?: string | null;
    spent?: string;
    created_at?: string;
    updated_at?: string;
  } = {},
): number =>
  ins(
    `INSERT INTO assignment
       (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,question,spent,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    slug,
    a.objective_type ?? "task",
    a.objective_id ?? tree.task,
    a.worker_id ?? worker(slug),
    "{}",
    "{}",
    "/tmp/wt",
    a.phase ?? "running",
    a.kind ?? null,
    a.question ?? null,
    a.spent ?? "{}",
    a.created_at ?? T,
    a.updated_at ?? T,
  );

/** The lander's own table, created the way the runner creates it: beside the record, so a
 *  workspace that has never landed has no such table at all. */
const landConflict = (story: number, branch: string, reason: string): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS land_conflict (
       story_id INTEGER PRIMARY KEY, branch TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL)`,
  );
  db.prepare("INSERT INTO land_conflict (story_id,branch,reason,at) VALUES (?,?,?,?)").run(story, branch, reason, T);
};

const failedTask = (): void => {
  db.prepare("UPDATE task SET state = 'failed', attempts = max_retry WHERE id = ?").run(tree.task);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

describe("the board module, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in its code", () => {
    expect(code).not.toMatch(/\bprepare\s*\(/);
    expect(code.match(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|FROM|JOIN|GROUP BY|ORDER BY|LIMIT)\b/g)).toBeNull();
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
    // `land_conflict` is the lander's, made beside the record, so the schema to hold the
    // declaration against is the one the runner would have left behind.
    landConflict(tree.story, "story/x", "conflict");

    const declared = [...source.matchAll(/table<[^>]*>\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map((m) => ({
      name: m[1],
      columns: [...m[2].matchAll(/"(\w+)"/g)].map((c) => c[1]),
    }));

    expect(declared.map((d) => d.name).sort()).toEqual([
      "acceptance_criteria",
      "acceptance_test",
      "assignment",
      "chore",
      "chore_refusal",
      "epic",
      "land_conflict",
      "project",
      "refusal",
      "release",
      "requirement",
      "sqlite_master",
      "story",
      "task",
      "task_test",
      "worker",
    ]);
    for (const d of declared) {
      const actual = (db.prepare(`PRAGMA table_info(${d.name})`).all() as { name: string }[]).map((c) => c.name);
      expect(actual, d.name).not.toEqual([]);
      expect(d.columns.length).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });
});

/** The walk up is what narrows every group but `projects`, and it is the one part of the
 *  port that had to change rather than move: the strings placed a story by whichever epic
 *  happened to share its id, because `ofStory` read `FROM epic e WHERE e.id = :id` while
 *  every caller handed it a story id. A Map keyed by story cannot be asked an epic's id. */
describe("the walk up to a project", () => {
  it("places a story by its own epic when story ids and epic ids have come apart", () => {
    const other = otherProject("billing");
    // The second story in the first project. Its id is the id of the *other* project's epic.
    const mine = storyIn(tree.epic, "second");
    expect(mine).toBe(other.epic);

    // By id alone the two are indistinguishable — that is the whole trap — so the story is
    // picked out by the detail only a story carries.
    const storiesOn = (project: number): number[] =>
      board(db, project)
        .open.filter((r) => r.detail.endsWith("tasks"))
        .map((r) => r.id);

    expect(storiesOn(tree.project)).toContain(mine);
    expect(storiesOn(other.project)).not.toContain(mine);
  });

  it("places a task by the story above it, not by an epic that shares the story's id", () => {
    const other = otherProject("billing");
    expect(otherProject("ledger").epic).toBeGreaterThan(other.epic);
    new Engine(db).apply("task", tree.task, "start", "chief");

    expect(board(db, tree.project).queued.map((r) => r.id)).toEqual([tree.task]);
    expect(board(db, other.project).queued).toEqual([]);
  });

  it("shows an assignment on the board of the project its objective hangs under, and no other", () => {
    const other = otherProject("billing");
    const a = assign("a1", { phase: "running" });

    expect(board(db, tree.project).running.map((r) => r.id)).toEqual([a]);
    expect(board(db, other.project).running).toEqual([]);
    // A kind with no objective table to walk has no project, so it is on the whole
    // workspace's board and on nobody's narrowed one.
    const chore = assign("a2", { objective_type: "chore", objective_id: 1 });
    expect(board(db).running.map((r) => r.id)).toEqual([a, chore]);
    expect(board(db, tree.project).running.map((r) => r.id)).toEqual([a]);
  });
});

describe("the groups, composed in TypeScript", () => {
  it("counts a project's delivered stories out of the stories it has", () => {
    storyIn(tree.epic, "done-one", "delivered");

    expect(board(db).projects).toEqual([
      { id: tree.project, what: "storefront", state: "in_progress", detail: "1/2 stories" },
    ]);
  });

  it("puts the three kinds of stale row in one list, in id order", () => {
    new Engine(db).apply("task", tree.task, "start", "chief");
    for (let i = 0; i < 3; i++) recordRefusal(db, "no worker free for role engineer", tree.task);
    db.prepare("UPDATE refusal SET since = ? WHERE task_id = ?").run(ago(20), tree.task);
    // On the acceptance_test rather than the task: an open assignment on the task itself is
    // something attempting it, and a task being attempted is not stale.
    const waiting = assign("a1", {
      objective_type: "acceptance_test",
      objective_id: tree.acceptance,
      phase: "waiting",
      updated_at: ago(40),
    });
    const empty = storyIn(tree.epic, "nothing-under-it");

    const stale = board(db).stale;

    expect(stale.map((r) => r.id)).toEqual([...stale.map((r) => r.id)].sort((a, b) => a - b));
    expect(stale.find((r) => r.id === tree.task && r.state === "ready")?.detail).toBe(
      "no worker free for role engineer · 3 passes · 20m",
    );
    expect(stale.find((r) => r.id === waiting && r.state === "waiting")?.detail).toBe("waiting on you · 40m");
    expect(stale.find((r) => r.id === empty)).toMatchObject({ what: "nothing-under-it", detail: "no work under it" });
    // The seeded story has a task under it, so it is not in there for being empty.
    expect(stale.some((r) => r.id === tree.story && r.detail === "no work under it")).toBe(false);
  });

  it("leaves a waiting assignment out of stale until it has been waiting a quarter of an hour", () => {
    const fresh = assign("a1", { phase: "waiting", updated_at: ago(5) });

    expect(board(db).stale.some((r) => r.id === fresh && r.state === "waiting")).toBe(false);
    db.prepare("UPDATE assignment SET updated_at = ? WHERE id = ?").run(ago(16), fresh);
    expect(board(db).stale.some((r) => r.id === fresh && r.state === "waiting")).toBe(true);
  });

  it("says who is running a task, for how long, and in whole thousands of tokens", () => {
    const w = worker("claude-1");
    const a = assign("a1", { worker_id: w, spent: JSON.stringify({ tokens: 2500 }), created_at: ago(7) });

    expect(board(db).running).toEqual([
      { id: a, what: "send the reset mail", state: "running", detail: "claude-1 · 7m · 2k" },
    ]);
  });

  it("says ? for a worker that is no longer there, and 0k for an attempt that has spent nothing", () => {
    db.exec("PRAGMA foreign_keys = OFF");
    const a = assign("a1", { worker_id: 9999, phase: "pending", created_at: ago(0) });
    db.exec("PRAGMA foreign_keys = ON");

    expect(board(db).running).toEqual([
      { id: a, what: "send the reset mail", state: "pending", detail: "? · 0m · 0k" },
    ]);
  });

  it("names the objective by id when it is not a task, in running as in needs_human", () => {
    const a = assign("a1", { objective_type: "acceptance_test", objective_id: tree.acceptance, phase: "waiting" });

    expect(board(db).needs_human).toEqual([
      { id: a, what: `acceptance_test #${tree.acceptance}`, state: "input", detail: "" },
    ]);
  });

  it("carries the question a waiting assignment asked, under the kind it asked it as", () => {
    const a = assign("a1", { phase: "waiting", kind: "decision", question: "which of the two?" });

    expect(board(db).needs_human).toEqual([
      { id: a, what: `task #${tree.task}`, state: "decision", detail: "which of the two?" },
    ]);
  });

  it("carries the last line of the newest failed task_test onto a failed task", () => {
    failedTask();
    db.prepare("UPDATE task_test SET state = 'failed', last_output = ?, last_run_at = ? WHERE id = ?").run(
      "older\nAssertionError: expected 1 to be 2\n\n",
      ago(30),
      tree.taskTest,
    );
    const newer = ins(
      `INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,last_output,last_run_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      "second",
      tree.task,
      "the second unit",
      "script",
      "vitest run",
      "failed",
      "TypeError: undefined is not a function\n",
      ago(1),
      T,
      T,
    );
    expect(newer).toBeGreaterThan(tree.taskTest);

    expect(board(db).failed[0]?.detail).toBe(
      "out of attempts · 3 of 3 · retry it with a reason, or drop it · TypeError: undefined is not a function",
    );
  });

  it("prefers a test that has run to one that never has, however the ids fall", () => {
    failedTask();
    // The newer id has never run, so under DESC its NULL sorts last and the dated row wins.
    db.prepare("UPDATE task_test SET state = 'failed', last_output = ?, last_run_at = ? WHERE id = ?").run(
      "it ran, and it failed",
      ago(9),
      tree.taskTest,
    );
    ins(
      `INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,last_output,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      "never-run",
      tree.task,
      "never run",
      "script",
      "vitest run",
      "failed",
      "no run behind this one",
      T,
      T,
    );

    expect(board(db).failed[0]?.detail).toContain("it ran, and it failed");
  });

  it("falls back to the acceptance test's output when no task_test of its own is red", () => {
    failedTask();
    db.prepare("UPDATE acceptance_test SET state = 'failed', last_output = ? WHERE id = ?").run(
      "bash: test/mail.sh: exit 1",
      tree.acceptance,
    );

    expect(board(db).failed[0]?.detail).toContain("bash: test/mail.sh: exit 1");
  });

  it("says the attempts it has left, and what a scope refused, while it still has some", () => {
    db.prepare("UPDATE task SET state = 'failed', attempts = 0, max_retry = 3 WHERE id = ?").run(tree.task);
    recordScopeRefusal(db, tree.task, ["config/views.yaml"]);

    expect(board(db).failed).toEqual([
      {
        id: tree.task,
        what: "send the reset mail",
        state: "failed",
        detail: "attempts 0/3 · refused a write to config/views.yaml",
      },
    ]);
  });

  it("puts a task somebody dropped under its own name, and not in failed", () => {
    db.prepare("UPDATE task SET state = 'dropped' WHERE id = ?").run(tree.task);

    expect(board(db).dropped).toEqual([
      { id: tree.task, what: "send the reset mail", state: "dropped", detail: "dropped by decision" },
    ]);
    expect(board(db).failed).toEqual([]);
  });

  it("keeps the twenty most recently changed delivered stories, newest first", () => {
    for (let i = 1; i <= 24; i++) {
      storyIn(tree.epic, `delivered-${i}`, "delivered", `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`);
    }

    const rows = board(db).delivered;

    expect(rows).toHaveLength(20);
    expect(rows[0]?.what).toBe("delivered-24");
    expect(rows[19]?.what).toBe("delivered-5");
    expect(rows.every((r) => r.detail === "story")).toBe(true);
  });

  it("is empty in unmergeable before anything has ever tried to land, and says why once it has", () => {
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(tree.story);

    expect(board(db).unmergeable).toEqual([]);
    landConflict(tree.story, "story/reset", "conflict in src/mail/send.ts");
    expect(board(db).unmergeable).toEqual([
      {
        id: tree.story,
        what: "password reset",
        state: "delivered",
        detail: "story/reset · conflict in src/mail/send.ts",
      },
    ]);
  });

  it("says nothing about a conflict recorded against a story that is not delivered", () => {
    landConflict(tree.story, "story/reset", "conflict");

    expect(board(db).unmergeable).toEqual([]);
  });

  it("lists a ready acceptance_test nobody has watched fail, by its statement", () => {
    expect(board(db).unproven).toEqual([
      {
        id: tree.acceptance,
        what: "the mail arrives with a link",
        state: "ready",
        detail: "no red run recorded",
      },
    ]);
  });

  it("orders the open filter by detail and then by id, so the stories come before the epics", () => {
    const second = epicIn(tree.release, "second-epic");

    const rows = board(db).open;

    expect(rows.map((r) => r.detail)).toEqual(["0/1 tasks", "epic", "epic"]);
    expect(rows.map((r) => r.id)).toEqual([tree.story, tree.epic, second].map(Number));
    expect(rows[0]).toMatchObject({ what: "password reset", state: "in_progress" });
  });

  it("counts the tasks under a story as done out of all of them", () => {
    expect(board(db).open.find((r) => r.detail.endsWith("tasks"))?.detail).toBe("0/1 tasks");
    db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(tree.task);
    expect(board(db).open.find((r) => r.detail.endsWith("tasks"))?.detail).toBe("1/1 tasks");
  });

  it("leaves a delivered or dropped epic out of open", () => {
    for (const state of ["delivered", "dropped"]) {
      db.prepare("UPDATE epic SET state = ? WHERE id = ?").run(state, tree.epic);
      expect(board(db).open.some((r) => r.id === tree.epic && r.detail === "epic"), state).toBe(false);
    }
  });
});

describe("what a pass records, written through the layer", () => {
  it("keeps since and counts the passes while the reason is the same", () => {
    recordRefusal(db, "no worker free for role engineer", tree.task);
    const first = db.prepare("SELECT * FROM refusal WHERE task_id = ?").get(tree.task) as {
      passes: number;
      since: string;
      why: string;
    };
    recordRefusal(db, "no worker free for role engineer", tree.task);
    const second = db.prepare("SELECT * FROM refusal WHERE task_id = ?").get(tree.task) as {
      passes: number;
      since: string;
    };

    expect(first.passes).toBe(1);
    expect(second.passes).toBe(2);
    expect(second.since).toBe(first.since);
  });

  it("starts the count and the clock again when the reason changes", () => {
    for (let i = 0; i < 3; i++) recordRefusal(db, "no worker free for role engineer", tree.task);
    const held = db.prepare("SELECT since FROM refusal WHERE task_id = ?").get(tree.task) as { since: string };
    db.prepare("UPDATE refusal SET since = ?, at = ? WHERE task_id = ?").run(ago(90), ago(90), tree.task);
    recordRefusal(db, "waiting for a slot", tree.task);

    const row = db.prepare("SELECT why, passes, since FROM refusal WHERE task_id = ?").get(tree.task) as {
      why: string;
      passes: number;
      since: string;
    };
    expect(row).toMatchObject({ why: "waiting for a slot", passes: 1 });
    expect(row.since).not.toBe(ago(90));
    expect(held.since).toBeTypeOf("string");
  });

  it("writes one row per task however many passes refuse it, and clears that row on request", () => {
    recordRefusal(db, "a", tree.task);
    recordRefusal(db, "b", tree.task);

    expect((db.prepare("SELECT count(*) AS n FROM refusal").get() as { n: number }).n).toBe(1);
    clearRefusal(db, tree.task);
    expect((db.prepare("SELECT count(*) AS n FROM refusal").get() as { n: number }).n).toBe(0);
    // Clearing what is not there is not an error: a dispatched task clears unconditionally.
    expect(() => clearRefusal(db, tree.task)).not.toThrow();
  });
});

describe("the slots an assignment holds, counted through the layer", () => {
  it("counts every open phase and no settled one", () => {
    assign("a1", { phase: "pending" });
    assign("a2", { phase: "running" });
    assign("a3", { phase: "waiting" });
    assign("a4", { phase: "done" });
    assign("a5", { phase: "failed" });

    expect(openAssignments(db)).toBe(3);
  });

  it("is zero on a workspace nothing has ever run", () => {
    expect(openAssignments(db)).toBe(0);
  });
});

/** The row shaping is the half of the board with no database in it: what a row says, how
 *  its detail is spelled, and how a folded row is ordered and aged. It lives in
 *  `src/board/row.ts`, and these hold it there — both that the module is what it claims to
 *  be, and that `board.ts` calls it rather than keeping a second copy. */
describe("what a row says, moved out of the board", () => {
  it("is a module of its own, and the board imports it", () => {
    expect(rowSource).not.toBe("");
    expect(source).toContain('from "./board/row.js"');
  });

  it("keeps the record out of it: no database, no dialect, no table", () => {
    expect(rowSource).not.toMatch(/\bfrom "node:sqlite"/);
    expect(rowSource).not.toMatch(/\bfrom "\.\.\/db\.js"/);
    expect(rowSource).not.toMatch(/\bimport\b/);
  });

  /** A second copy of `minutes` or `withAge` in `board.ts` would pass every behaviour test
   *  below and still be the defect this story is about, so the absence is spelled out. */
  it("leaves no second copy of the shaping behind in the board", () => {
    for (const moved of ["instant", "elapsed", "minutes", "thousands", "byId", "lastLine", "withAge", "oldestFirst"]) {
      expect(code, moved).not.toMatch(new RegExp(`(const|function)\\s+${moved}\\b[^;]*=?\\s*\\(`));
    }
  });

  it("still hands `Row` and `lastLine` out of board.js, which is where every caller asks", async () => {
    const board = await import("../src/board.js");
    expect(board.lastLine).toBe(lastLine);
  });

  it("reads a timestamp the way the dialect read it, Z supplied or not", () => {
    expect(instant("2026-09-13T00:00:00.000Z")).toBe(Date.parse("2026-09-13T00:00:00.000Z"));
    expect(instant("2026-09-13 00:00:00")).toBe(Date.parse("2026-09-13T00:00:00Z"));
    expect(Number.isNaN(instant("no such time"))).toBe(true);
  });

  it("counts minutes by truncation, and an undateable row as no time at all", () => {
    const asOf = Date.parse("2026-09-13T01:00:00.000Z");
    expect(elapsed("2026-09-13T00:30:30.000Z", asOf)).toBeCloseTo(29.5, 5);
    expect(minutes("2026-09-13T00:30:30.000Z", asOf)).toBe(29);
    expect(minutes("not a time", asOf)).toBe(0);
  });

  it("divides a budget the way SQLite divides it, and reads malformed JSON as nothing", () => {
    expect(thousands('{"tokens":2500}')).toBe(2);
    expect(thousands('{"tokens":2500.5}')).toBeCloseTo(2.5005, 5);
    expect(thousands(null)).toBe(0);
    expect(thousands("{")).toBe(0);
    expect(thousands('{"seconds":9}')).toBe(0);
  });

  it("cuts a test's output down to its last non-blank line", () => {
    expect(lastLine("running\n\nAssertionError: expected 2\n\n")).toBe("AssertionError: expected 2");
    expect(lastLine(null)).toBe("");
    expect(lastLine("  \n \n")).toBe("");
    expect(lastLine("x".repeat(400))).toHaveLength(120);
  });

  it("draws every panel in id order", () => {
    const row = (id: number): Row => ({ id, what: "w", state: "s", detail: "d" });
    expect([row(3), row(1), row(2)].sort(byId).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("folds the aged rows oldest first, an undateable row last", () => {
    const at = (id: number, since: string): Aged => ({ since, row: { id, what: "w", state: "s", detail: "" } });
    const asOf = Date.parse("2026-09-13T01:00:00.000Z");
    const rows = folded(
      [
        at(2, "2026-09-13T00:50:00.000Z"),
        at(9, "nothing can date this"),
        at(1, "2026-09-13T00:50:00.000Z"),
        at(3, "2026-09-13T00:10:00.000Z"),
      ],
      asOf,
    );
    expect(rows.map((r) => r.id)).toEqual([3, 1, 2, 9]);
  });

  it("leads the detail with the age, and does not say the same minutes twice", () => {
    const asOf = Date.parse("2026-09-13T01:00:00.000Z");
    const since = "2026-09-13T00:10:00.000Z";
    const shape = (detail: string): string => folded([{ since, row: { id: 1, what: "w", state: "s", detail } }], asOf)[0]?.detail ?? "";
    expect(shape("")).toBe("50m");
    expect(shape("gave up · 3 passes")).toBe("50m · gave up · 3 passes");
    expect(shape("gave up · 50m")).toBe("50m · gave up");
    // A different number is about something else, so it stays where it was.
    expect(shape("gave up · 12m")).toBe("50m · gave up · 12m");
  });
});
