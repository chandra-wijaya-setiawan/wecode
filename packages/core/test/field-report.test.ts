/** The field report, reconciled against what is already true.
 *
 *  Thirteen stories under epic 105 record bugs and hassles found by hand. Most of them were
 *  fixed by later work, and the fix is only as durable as the test that holds it down — a
 *  story closed on a note reopens the first time somebody refactors the thing that fixed it.
 *  One test per claim, each driving the engine (or the client that drives the engine) the
 *  way the report's reporter did, so a regression fails here rather than in a shell.
 *
 *  A claim that is *not* true is skipped rather than deleted, with what is missing named in
 *  a comment: the story stays open, and the test is already written for whoever closes it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Maker, board, open, recordRefusal } from "../src/index.js";
import { run } from "../../cli/src/run.js";
import { allocate } from "../../runner/src/allocator.js";
import { DEFAULT_BUDGET } from "../../runner/src/budget.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

/** What a run of the engine did, as the engine reported it: entity and the state it moved
 *  to. Reading the outcome rather than the rows is the point — a test that re-reads a column
 *  proves the column, and the claims here are all about what the engine *does*. */
const moves = (changes: readonly { entity: string; to: string }[]): string[] =>
  changes.map((c) => `${c.entity}:${c.to}`);

let db: DatabaseSync;
let engine: Engine;
let tree: ReturnType<typeof seed>;

beforeEach(() => {
  db = freshDb();
  engine = new Engine(db);
  tree = seed(db);
});

// ---------------------------------------------------------------------------------------
// The engine's own claims: the ones a database and a verb are enough to prove.
// ---------------------------------------------------------------------------------------

describe("#106 automatic transitions do not wait for an event", () => {
  it("settles a tree whose work finished while nothing was looking", () => {
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");

    // The incident: a verdict that arrived without a verb — a runner recovering state, a
    // row written by hand — so no cascade ever walked up from it. Three ticks later the
    // criteria was still in_progress with every test passed.
    db.prepare("UPDATE acceptance_test SET state = 'passed' WHERE id = ?").run(tree.acceptance);

    expect(moves(engine.settle())).toEqual([
      "acceptance_criteria:accepted",
      "requirement:met",
      "story:delivered",
      "epic:delivered",
    ]);
    // Level-triggered, so a second tick with nothing owed does nothing.
    expect(engine.settle()).toEqual([]);
  });
});

describe.skip("#107 dropped work does not read as shipped work", () => {
  /** STILL OPEN. `every_criteria_accepted_or_dropped` is satisfied by children that are all
   *  dropped, so `meet` fires on a requirement whose every criteria was abandoned, and the
   *  story delivers behind it. What is missing is a guard that requires at least one
   *  *accepted* criteria before a requirement may be met — the same for every_story_* and
   *  every_requirement_* above it. Nothing here changes behaviour; this test is the shape
   *  the fix has to satisfy. */
  it("refuses to meet a requirement whose criteria were all dropped", () => {
    const second = new Maker(db).criteria(tree.requirement, "a second expectation");
    engine.apply("acceptance_criteria", tree.criteria, "drop", "operator");

    // The last one: whatever the cascade does here is what the board will report as having
    // shipped. Asking `may` afterwards would not catch it — a requirement the cascade
    // already met refuses `meet` for the wrong reason — so the cascade's own report is read.
    const last = engine.apply("acceptance_criteria", second, "drop", "operator");
    expect(last.ok).toBe(true);
    const cascaded = moves(last.ok ? last.changes : []);
    expect(cascaded).not.toContain("requirement:met");
    expect(cascaded).not.toContain("story:delivered");
    expect(moves(engine.settle())).not.toContain("requirement:met");
  });
});

describe("#109 a slug collision is explained, not relayed from SQLite", () => {
  it("names the task already holding the slug, and says a dropped one still holds it", () => {
    const make = new Maker(db);
    const first = make.task(tree.acceptance, "send the welcome mail");
    engine.apply("task", first, "drop", "operator");

    let why = "";
    try {
      make.task(tree.acceptance, "send the welcome mail");
    } catch (err) {
      why = (err as Error).message;
    }

    expect(why).not.toContain("UNIQUE constraint failed");
    expect(why).toContain(`task #${first}`);
    expect(why).toContain("dropped");
    expect(why).toContain("A dropped row still holds its slug");
  });
});

describe("#112 a task waiting on a worker is not a task blocked by a scope", () => {
  const candidateTask = (title: string, write: string[]): number => {
    const make = new Maker(db);
    const id = make.task(tree.acceptance, title, { scope: { write, tools: ["bash"] }, role: "engineer" });
    make.taskTest(id, `${title} is proven`, "script", "vitest run");
    engine.apply("task_test", (db.prepare("SELECT max(id) AS id FROM task_test").get() as { id: number }).id, "deliver", "chief");
    engine.apply("task", id, "start", "chief");
    return id;
  };

  it("gives each its own reason, and the board shows the two apart", async () => {
    const worker = new Maker(db).worker("ann", "engineer", "agent");
    const overlapping = candidateTask("touch the reset mailer", ["src/mail/reset/**"]);
    const disjoint = candidateTask("touch the parser", ["src/parse/**"]);

    // One assignment open over src/mail/** — so one candidate collides and one does not.
    new Maker(db).assignment({
      objective_type: "task",
      objective_id: tree.task,
      worker_id: worker,
      scope: { write: ["src/mail/**"], tools: ["bash"] },
      budget: { tokens: 10, seconds: 10 },
      worktree: "/tmp/tree",
    });

    const pass = await allocate(db, DEFAULT_BUDGET, async () => ({ why: "no worker free for role engineer" }));
    const why = Object.fromEntries(pass.refused.map((r) => [r.id, r.why]));

    expect(pass.created).toBeNull();
    expect(why[overlapping]).toContain("overlaps an assignment already open");
    expect(why[disjoint]).toContain("no worker free");

    for (const r of pass.refused) recordRefusal(db, r.why, r.id);
    const queued = Object.fromEntries(board(db).queued.map((r) => [r.id, r.detail]));
    expect(queued[disjoint]).toContain("no worker free");
    expect(queued[disjoint]).not.toContain("overlap");
  });
});

describe.skip("#117 a failing task_test says why on the board", () => {
  /** STILL OPEN. The reason a task_test failed is written to its own `last_output` and read
   *  back only by `wecode show task_test <id>`. The board's QUEUE detail is the allocator's
   *  refusal (why nothing is *running*), and its FAILED detail is the attempt count; neither
   *  carries the verdict, and `show task` has no column for it. What is missing is the last
   *  failing child test's output summarised onto the task's board row and into `show task`. */
  it("puts the verdict on the row, not only in the test's record", () => {
    engine.apply("task", tree.task, "start", "chief");
    db.prepare("UPDATE task_test SET last_output = ? WHERE id = ?")
      .run("no test files found in this repo", tree.taskTest);
    engine.apply("task_test", tree.taskTest, "fail", "runner");

    const row = board(db).queued.find((r) => r.id === tree.task);
    expect(row?.detail).toContain("no test files found");
  });
});

// ---------------------------------------------------------------------------------------
// The client's claims: the report was written by somebody at a terminal, so these are
// driven the same way — one process, one argv, and what it printed.
// ---------------------------------------------------------------------------------------

describe("what the client says", () => {
  let out: string[];
  let err: string[];
  let was: string;
  let repo: string;

  const said = (): string => out.join("");
  const complained = (): string => err.join("");
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });

  /** A repository with one commit, a stack marker and a git identity: the least a client
   *  command will talk to. */
  const repository = (): string => {
    const at = mkdtempSync(join(tmpdir(), "wecode-field-"));
    repo = at;
    writeFileSync(join(at, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    git("init", "-q", "-b", "master");
    git("config", "user.name", "A Person");
    git("config", "user.email", "person@example.com");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    return at;
  };

  /** project → story, through the client, in the repository the test is standing in. */
  const storyTree = (path: string): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront", "--path", path]);
    run(["release", "create", "--parent", "1", "0.0.1"]);
    run(["epic", "create", "--parent", "1", "account recovery"]);
    run(["story", "create", "--parent", "1", "password reset"]);
  };

  const sql = (): DatabaseSync => open(process.env["WECODE_DB"] as string);

  beforeEach(() => {
    was = process.cwd();
    process.env["WECODE_DB"] = join(mkdtempSync(join(tmpdir(), "wecode-field-db-")), "wecode.db");
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
  });

  afterEach(() => {
    process.chdir(was);
    vi.restoreAllMocks();
    delete process.env["WECODE_DB"];
    delete process.env["WECODE_HOME"];
  });

  describe.skip("#105 landing from inside the story's worktree", () => {
    /** STILL OPEN. `land` merges `story/<slug>` into whatever branch is checked out where it
     *  is run. Run from .wecode/worktrees/<story>, that branch *is* the story branch: git
     *  says "Already up to date", the client says "landed", and nothing reaches the
     *  developer's branch. What is missing is either a refusal when cwd is a wecode
     *  worktree, or merging into the project's base branch rather than into HEAD. */
    it("refuses, rather than merging the story branch into itself", () => {
      const at = repository();
      process.chdir(at);
      storyTree(at);

      const conn = sql();
      conn.prepare("UPDATE story SET state = 'delivered' WHERE id = 1").run();
      const slug = (conn.prepare("SELECT slug FROM story WHERE id = 1").get() as { slug: string }).slug;
      conn.close();

      git("checkout", "-q", "-b", `story/${slug}`);
      writeFileSync(join(at, "answer.ts"), "export const answer = 1;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "the story's answer");
      const answered = git("rev-parse", "HEAD").trim();
      git("checkout", "-q", "master");

      const inside = join(at, ".wecode", "worktrees", slug);
      mkdirSync(join(at, ".wecode", "worktrees"), { recursive: true });
      git("worktree", "add", "-q", inside, `story/${slug}`);
      process.chdir(inside);

      expect(run(["land", "1"])).toBe(1);
      expect(complained()).toContain("worktree");
      // and in no case may it claim a landing that master never received
      expect(git("rev-list", "master").includes(answered)).toBe(false);
      expect(said()).not.toContain("landed");
    });
  });

  describe("#108 a delivered epic is still there when you ask for it", () => {
    it("shows a record in every state, and answers a stale id with the ids that exist", () => {
      const at = repository();
      process.chdir(at);
      storyTree(at);
      sql().prepare("UPDATE epic SET state = 'delivered' WHERE id = 1").run();

      expect(run(["show", "epic", "1"])).toBe(0);
      expect(said()).toContain("account recovery");
      expect(said()).toContain("delivered");
      expect(said()).toContain("project");

      out.length = 0;
      expect(run(["show", "epic", "9"])).toBe(1);
      expect(complained()).toContain("#1");
      expect(complained()).toContain("account recovery");
    });
  });

  describe("#110 a parent in another project is refused", () => {
    it("names both projects and how to mean it", () => {
      const at = repository();
      process.chdir(at);
      storyTree(at);
      run(["project", "create", "--parent", "1", "other", "--path", "/somewhere/else"]);
      run(["release", "create", "--parent", "2", "0.0.1"]);
      out.length = 0;

      expect(run(["epic", "create", "--parent", "2", "an epic meant for the other repo"])).toBe(1);
      expect(complained()).toContain("other");
      expect(complained()).toContain("storefront");
      expect(complained()).toContain("--project");
      // nothing was written while it was refusing
      const n = sql().prepare("SELECT count(*) AS n FROM epic").get() as { n: number };
      expect(n.n).toBe(1);
    });
  });

  describe("#111 onboarding hires the workers the runner needs", () => {
    it("creates one agent worker per role and names the command that made them", () => {
      const at = repository();
      process.env["WECODE_HOME"] = mkdtempSync(join(tmpdir(), "wecode-field-home-"));
      delete process.env["WECODE_DB"];
      process.chdir(at);

      expect(run(["onboard", "storefront"])).toBe(0);
      expect(said()).toContain("worker #1  engineer");
      expect(said()).toContain("worker #2  acceptance-tester");

      const conn = open(join(process.env["WECODE_HOME"] as string, "workspaces", "default", "wecode.db"));
      const workers = conn.prepare("SELECT name, role, kind FROM worker ORDER BY id").all();
      conn.close();
      expect(workers).toEqual([
        { name: "engineer", role: "engineer", kind: "agent" },
        { name: "acceptance-tester", role: "acceptance-tester", kind: "agent" },
      ]);
    });
  });

  describe("#113 the board is the project you are standing in", () => {
    it("leaves another project's queue off it, and says how to see the whole workspace", () => {
      const at = repository();
      process.chdir(at);
      storyTree(at);

      const conn = sql();
      const make = new Maker(conn);
      // A second project, with a ready task of its own, in a repository that is not here.
      const other = make.project(1, "other", "/somewhere/else");
      const rel = make.release(other, "0.0.1");
      const epic = make.epic(rel, "theirs");
      const story = make.story(epic, "their story");
      const req = make.requirement(story, "their rule");
      const crit = make.criteria(req, "their expectation");
      const test = make.acceptanceTest(crit, "their proof", "script", "vitest run");
      const task = make.task(test, "their task", { scope: { write: ["src/**"], tools: ["bash"] }, role: "engineer" });
      conn.prepare("UPDATE task SET state = 'ready' WHERE id = ?").run(task);
      conn.close();

      expect(run(["board"])).toBe(0);
      expect(said()).toContain("storefront");
      expect(said()).not.toContain("their task");
      expect(said()).toContain("--all");

      out.length = 0;
      expect(run(["board", "--all"])).toBe(0);
      expect(said()).toContain("their task");
    });
  });

  describe("#114 create --help prints help", () => {
    it("answers with that entity's flags, and creates nothing while answering", () => {
      const at = repository();
      process.chdir(at);
      storyTree(at);
      const before = (sql().prepare("SELECT count(*) AS n FROM task").get() as { n: number }).n;
      out.length = 0;

      expect(run(["task", "create", "--help"])).toBe(0);
      expect(complained()).not.toContain("Unknown option");
      expect(said()).toContain("--parent");
      expect(said()).toContain("--role");
      expect((sql().prepare("SELECT count(*) AS n FROM task").get() as { n: number }).n).toBe(before);
    });
  });

  describe.skip("#115 a delivered story says how it reaches your branch", () => {
    /** STILL OPEN. `wecode land <story>` exists and is listed in the manual, but nothing at
     *  the moment of delivery names it: the cascade prints `story #1 in_progress →
     *  delivered` and stops, which is exactly where the report's author was left merging by
     *  hand. What is missing is the landing command on the delivery line (and on the
     *  board's DELIVERED rows), naming the story by id. */
    it("prints the exact command on the line that says it delivered", () => {
      const at = repository();
      process.chdir(at);
      storyTree(at);
      run(["requirement", "create", "--parent", "1", "a reset link authenticates one change"]);
      run(["acceptance_criteria", "create", "--parent", "1", "a link is emailed"]);
      run(["acceptance_test", "create", "--parent", "1", "the mail arrives", "--artefact", "bash mail.sh"]);
      run(["acceptance_test", "deliver", "1"]);
      recordRed(sql(), 1);
      for (const step of [["story"], ["requirement"], ["acceptance_criteria"]]) run([...step, "start", "1"]);
      out.length = 0;

      expect(run(["acceptance_test", "pass", "1"])).toBe(0);
      expect(said()).toContain("story #1");
      expect(said()).toContain("delivered");
      expect(said()).toContain("wecode land 1");
    });
  });

  describe("#116 a dispatched task can be watched from outside the TUI", () => {
    it("emits one line per state change, and a machine-readable one on --json", () => {
      const at = repository();
      process.chdir(at);
      storyTree(at);
      run(["story", "start", "1"]);
      out.length = 0;

      expect(run(["watch", "--once", "--since", "0"])).toBe(0);
      expect(said()).toContain("story #1");
      expect(said()).toContain("planned → in_progress");
      expect(said()).toContain("start");

      out.length = 0;
      expect(run(["watch", "--once", "--since", "0", "--json"])).toBe(0);
      const lines = said().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.some((l) => l["entity"] === "story" && l["to_state"] === "in_progress")).toBe(true);
    });
  });
});

// A claim the helpers already carry: the seed's states are the machine's, so a test that
// reads one is reading the machine. Kept as one assertion rather than a habit.
it("seeds a tree the engine recognises", () => {
  expect(stateOf(db, "story", tree.story)).toBe("in_progress");
});
