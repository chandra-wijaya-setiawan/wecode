/** The cli's verbs, on the typed query layer.
 *
 *  Two things are proved here, and they are not the same thing.
 *
 *  The first is that no prepared statement is left: `run.ts` holds no SQL text but the one
 *  `CREATE TABLE IF NOT EXISTS` that is schema rather than a query, so every identifier the
 *  client sends comes from a declared table and every value is a bound parameter. That is a
 *  property of the source, and it is read off the source.
 *
 *  The second is that the declared tables are the schema. `show` prints a whole record, so
 *  the column lists in `run.ts` are a second copy of the database's own — and a second copy
 *  with no check between it and the first is the defect the config rule names. Every list is
 *  held against `PRAGMA table_info`, name for name and in order, so a column added to a
 *  migration and not to `run.ts` fails here rather than going missing out of `show`.
 *
 *  The rest is the behaviour the port could quietly have changed: the joins, the ORDER BYs
 *  and the `max(id)` the dialect cannot spell, which are now composed in TypeScript.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { DECLARED, run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

const SOURCE = readFileSync(new URL("../src/run.ts", import.meta.url), "utf8");

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(tmp("wecode-typed-cli-"), "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");
const why = (): string => err.join("");

const sql = (): DatabaseSync => new DatabaseSync(process.env["WECODE_DB"] as string);

/** A tree in the project the test is standing in. */
const shaped = (): void => {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront", "--path", process.cwd()]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "recovery"]);
  run(["story", "create", "--parent", "1", "password reset"]);
};

describe("no prepared statement is left in the cli", () => {
  it("holds no prepared statement at all", () => {
    expect(SOURCE).not.toMatch(/\.prepare\(/);
  });

  it("leaves exactly one piece of SQL text, and it is a schema rather than a query", () => {
    const statements = [...SOURCE.matchAll(/\.exec\(/g)];
    expect(statements).toHaveLength(1);
    // A SELECT, an UPDATE or an INSERT written out in this file would be a query the layer
    // was meant to compile. Only DDL is left, because the dialect spells queries.
    expect(SOURCE).not.toMatch(/SELECT .* FROM /);
    expect(SOURCE).not.toMatch(/INSERT INTO/);
    expect(SOURCE).not.toMatch(/UPDATE [a-z_]+ SET/);
    expect(SOURCE).toContain("CREATE TABLE IF NOT EXISTS landed_branch");
  });

  it("reads no row out through a cast, which is the checking the port is for", () => {
    expect(SOURCE).not.toMatch(/as unknown as/);
  });
});

describe("the declared tables are the schema", () => {
  const columnsOf = (db: DatabaseSync, name: string): string[] =>
    (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);

  it("names every column of every table it reads, in the order the database declares them", () => {
    const db = open(join(tmp("wecode-schema-"), "wecode.db"));
    try {
      for (const t of DECLARED) {
        expect({ [t.name]: t.columns }).toEqual({ [t.name]: columnsOf(db, t.name) });
      }
    } finally {
      db.close();
    }
  });

  it("covers every entity the cli can be asked to show", () => {
    shaped();
    out.length = 0;
    run(["show", "epick", "1"]);
    const entities = (why().split("There is ")[1] ?? "").trim().split(", ");
    expect(entities.length).toBeGreaterThan(0);
    for (const e of entities) {
      const table = e === "acceptance_criteria" ? "acceptance_criteria" : e;
      expect(DECLARED.map((t) => t.name)).toContain(table);
    }
  });

  it("prints every column of a record, which is what SELECT * did", () => {
    shaped();
    out.length = 0;
    expect(run(["show", "story", "1"])).toBe(0);
    const printed = said();
    // Every column of story is non-empty on a freshly created row, so all of them show.
    for (const column of DECLARED.find((t) => t.name === "story")?.columns ?? ["missing"]) {
      expect(printed).toContain(column);
    }
    expect(printed).toContain("password reset");
  });
});

describe("the tree is walked by the entity's own typed read, not by a spliced column name", () => {
  /** Ids that diverge at every level: story #1 hangs off epic #2 and story #2 off epic #1,
   *  so a lookup that placed a row by whichever ancestor shared its id gets both wrong. A
   *  fixture where every level is numbered alike cannot tell the two apart — the earlier
   *  defect in `board.ts` survived exactly that way. */
  const crossed = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "one", "--path", "/elsewhere/one"]);
    run(["project", "create", "--parent", "1", "two", "--path", process.cwd()]);
    run(["release", "create", "--parent", "1", "0.0.1", "--project", "1"]);
    run(["release", "create", "--parent", "2", "0.0.2"]);
    run(["epic", "create", "--parent", "1", "epic of one", "--project", "1"]);
    run(["epic", "create", "--parent", "2", "epic of two"]);
    // story #1 under epic #2, story #2 under epic #1
    run(["story", "create", "--parent", "2", "story under epic two"]);
    run(["story", "create", "--parent", "1", "story under epic one", "--project", "1"]);
  };

  it("names the project of a row whose id matches another branch's ancestor", () => {
    crossed();

    out.length = 0;
    expect(run(["show", "story", "1"])).toBe(0);
    expect(said()).toContain("project            #2 two");

    out.length = 0;
    expect(run(["show", "story", "2"])).toBe(0);
    expect(said()).toContain("project            #1 one");
  });

  it("names the parent a new row joined, which was a join and is now its two halves", () => {
    crossed();
    out.length = 0;
    expect(run(["story", "create", "--parent", "2", "another under two"])).toBe(0);
    expect(said()).toContain("under epic #2  epic of two");
  });

  it("refuses a parent in the other project, having walked up to it", () => {
    crossed();
    err.length = 0;
    expect(run(["requirement", "create", "--parent", "2", "a rule"])).toBe(1);
    expect(why()).toContain("belongs to project #1 one");
    expect(why()).toContain("but you are in #2 two");
  });

  it("shows a record that hangs off no project without inventing one", () => {
    crossed();
    out.length = 0;
    expect(run(["show", "workspace", "1"])).toBe(0);
    expect(said()).toContain("acme");
    expect(said()).not.toContain("project            #");
  });
});

describe("what the dialect cannot spell is composed rather than dropped", () => {
  it("lists the ids that do exist in id order, with no ORDER BY reaching the database", () => {
    shaped();
    run(["epic", "create", "--parent", "1", "later, and lower numbered"]);
    const db = sql();
    // Rows whose insertion order is the reverse of their id order: a listing that came back
    // unsorted would print them the other way round.
    db.prepare("DELETE FROM story").run();
    db.prepare("UPDATE epic SET id = 9 WHERE id = 1").run();
    db.prepare("UPDATE epic SET id = 4 WHERE id = 2").run();
    db.close();

    err.length = 0;
    expect(run(["show", "epic", "1"])).toBe(1);
    const listed = why();
    expect(listed).toContain("no epic #1");
    expect(listed.indexOf("#4")).toBeLessThan(listed.indexOf("#9"));
    expect(listed).toContain("later, and lower numbered");
  });

  it("says the entity is empty rather than listing nothing", () => {
    shaped();
    expect(run(["show", "task", "3"])).toBe(1);
    expect(why()).toContain("no task at all yet");
  });

  it("drains the ledger oldest first, and the json keys are the columns in schema order", () => {
    shaped();
    run(["project", "start", "1"]);
    run(["release", "start", "1"]);
    run(["epic", "start", "1"]);
    run(["story", "start", "1"]);

    out.length = 0;
    expect(run(["watch", "--since", "0", "--once", "--json"])).toBe(0);
    const lines = said().trim().split("\n").filter((l) => l !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // The order the lines came out in, not the order the database happened to return.
    expect(rows.map((r) => r["id"])).toEqual([...rows.map((r) => r["id"])].sort((a, b) => Number(a) - Number(b)));
    // An orchestrator reads these keys; the port must not have reordered or dropped one.
    expect(Object.keys(rows[0] as object)).toEqual(
      DECLARED.find((t) => t.name === "ledger")?.columns,
    );
  });

  it("starts from the ledger's high-water mark when no --since is given", () => {
    shaped();
    run(["project", "start", "1"]);
    out.length = 0;
    // Everything already on the ledger is behind the cursor, so a drain says nothing —
    // which is what `max(id)` bought, and is now the largest id handed back.
    expect(run(["watch", "--once"])).toBe(0);
    expect(said()).toBe("");

    run(["release", "start", "1"]);
    out.length = 0;
    // A cursor set behind the mark replays what the mark had skipped.
    expect(run(["watch", "--since", "0", "--once"])).toBe(0);
    expect(said()).toContain("project #1  planned → in_progress");
    expect(said()).toContain("release #1  planned → in_progress");
  });

  it("counts each workspace's projects without count(*)", () => {
    // A home of the test's own, so `workspaces` lists workspaces it made rather than the
    // operator's. WECODE_DB is dropped, because it would name the database for every one.
    const home = tmp("wecode-home-count-");
    const was = process.env["WECODE_DB"];
    process.env["WECODE_HOME"] = home;
    delete process.env["WECODE_DB"];
    try {
      expect(run(["init", "busy"])).toBe(0);
      expect(run(["init", "empty"])).toBe(0);

      process.env["WECODE_DB"] = join(home, "workspaces", "busy", "wecode.db");
      run(["workspace", "create", "acme"]);
      run(["project", "create", "--parent", "1", "one", "--path", "/one"]);
      run(["project", "create", "--parent", "1", "two", "--path", "/two"]);
      delete process.env["WECODE_DB"];

      out.length = 0;
      expect(run(["workspaces"])).toBe(0);
      expect(said()).toMatch(/busy\s+2 projects/);
      expect(said()).toMatch(/empty\s+0 projects/);
    } finally {
      delete process.env["WECODE_HOME"];
      if (was !== undefined) process.env["WECODE_DB"] = was;
    }
  });
});

describe("an assignment keeps its state in phase, which the entity knows and the verb does not", () => {
  const anAssignment = (phase: string): void => {
    const db = sql();
    db.prepare(
      `INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES ('w','w','engineer','agent','t','t')`,
    ).run();
    db.prepare(
      `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,question,spent,created_at,updated_at)
         VALUES ('send-the-mail-1','task',1,1,'{}','{}','/tmp',?,'approval','may I?','{}','t','2026-01-01T00:00:00.000Z')`,
    ).run(phase);
    db.close();
  };

  it("waits on the phase column, and returns 0 for the phase the work wanted", () => {
    shaped();
    anAssignment("succeeded");
    out.length = 0;
    expect(run(["wait", "assignment", "1"])).toBe(0);
    expect(said()).toContain("assignment #1 succeeded");
  });

  it("returns 1 when the assignment settled the other way", () => {
    shaped();
    anAssignment("failed");
    expect(run(["wait", "assignment", "1"])).toBe(1);
  });

  it("waits on state for everything else", () => {
    shaped();
    run(["story", "drop", "1"]);
    expect(run(["wait", "story", "1"])).toBe(1);
    expect(said()).toContain("story #1 dropped");
  });

  it("says so when there is no such row, rather than asking SQLite about a missing column", () => {
    shaped();
    expect(run(["wait", "assignment", "7"])).toBe(1);
    expect(why()).toContain("no assignment #7");
  });

  it("records the answer, who gave it, and re-stamps the row", () => {
    shaped();
    anAssignment("waiting");
    // Back-dated first: two writes in the same millisecond produce the same ISO stamp, so
    // "it moved" can only be read against a value the clock cannot still be sitting on.
    const before = "2026-01-01T00:00:00.000Z";

    out.length = 0;
    expect(run(["answer", "1", "yes,", "go", "ahead"])).toBe(0);
    expect(said()).toContain("assignment #1 answered by operator");

    const db = sql();
    const row = db.prepare("SELECT answer, answered_by, updated_at FROM assignment WHERE id = 1").get() as {
      answer: string;
      answered_by: string;
      updated_at: string;
    };
    db.close();
    expect(row.answer).toBe("yes, go ahead");
    expect(row.answered_by).toBe("operator");
    expect(row.updated_at).not.toBe(before);
    expect(Date.parse(row.updated_at)).toBeGreaterThan(Date.parse(before));
  });

  it("names the assignment a lesson came from, by its slug", () => {
    shaped();
    anAssignment("succeeded");
    const db = sql();
    db.prepare("INSERT INTO lesson (project_id, text, assignment_id, created_at) VALUES (1, 'a note', 1, ?)").run(
      new Date().toISOString(),
    );
    db.close();

    out.length = 0;
    expect(run(["lessons"])).toBe(0);
    expect(said()).toContain("send-the-mail-1 #1");
  });
});

describe("a task's counter goes back to zero through the typed update", () => {
  it("resets attempts and stamps the row", () => {
    shaped();
    run(["requirement", "create", "--parent", "1", "one change per link"]);
    run(["acceptance_criteria", "create", "--parent", "1", "emailed in 60s"]);
    run(["acceptance_test", "create", "--parent", "1", "mail arrives", "--artefact", "bash x.sh"]);
    run(["task", "create", "--parent", "1", "send the mail", "--role", "engineer"]);

    const was = "2026-01-01T00:00:00.000Z";
    const db = sql();
    db.prepare("UPDATE task SET state = 'failed', attempts = 3, updated_at = ? WHERE id = 1").run(was);
    db.close();

    out.length = 0;
    expect(run(["task", "retry", "1", "--reason", "the mailer host is up now"])).toBe(0);
    expect(said()).toContain("attempts 3 → 0 of 3");

    const after = sql();
    const row = after.prepare("SELECT attempts, updated_at FROM task WHERE id = 1").get() as {
      attempts: number;
      updated_at: string;
    };
    after.close();
    expect(row.attempts).toBe(0);
    expect(Date.parse(row.updated_at)).toBeGreaterThan(Date.parse(was));
  });

  it("leaves the counter alone when the transition itself is refused", () => {
    shaped();
    run(["requirement", "create", "--parent", "1", "one change per link"]);
    run(["acceptance_criteria", "create", "--parent", "1", "emailed in 60s"]);
    run(["acceptance_test", "create", "--parent", "1", "mail arrives", "--artefact", "bash x.sh"]);
    run(["task", "create", "--parent", "1", "send the mail", "--role", "engineer"]);
    const db = sql();
    // done is terminal, so retry is refused — and must not leave the counter reset behind it.
    db.prepare("UPDATE task SET state = 'done', attempts = 3 WHERE id = 1").run();
    db.close();

    expect(run(["task", "retry", "1", "--reason", "no"])).toBe(1);
    const after = sql();
    const row = after.prepare("SELECT attempts FROM task WHERE id = 1").get() as { attempts: number };
    after.close();
    expect(row.attempts).toBe(3);
  });
});

describe("landing records the tasks the story's tree actually reaches", () => {
  let repo: string;
  let was: string;

  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    was = process.cwd();
    repo = tmp("wecode-typed-land-");
    process.chdir(repo);
    git("init", "-q", "-b", "master");
    git("config", "user.name", "A Person");
    git("config", "user.email", "person@example.com");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "seed.ts"), "export const one = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");

    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "p", "--path", repo]);
    run(["release", "create", "--parent", "1", "0.0.1"]);
    run(["epic", "create", "--parent", "1", "e"]);

    // Every level's ids are crossed against the level above, so the four-table join is only
    // right if each step follows its own foreign key:
    //   story 1 → requirement 2 → criteria 1 → acceptance_test 2 → task 1
    //   story 2 → requirement 1 → criteria 2 → acceptance_test 1 → task 2
    run(["story", "create", "--parent", "1", "landing"]);
    run(["story", "create", "--parent", "1", "staying"]);
    run(["requirement", "create", "--parent", "2", "a rule of staying"]);
    run(["requirement", "create", "--parent", "1", "a rule of landing"]);
    run(["acceptance_criteria", "create", "--parent", "2", "criteria of landing"]);
    run(["acceptance_criteria", "create", "--parent", "1", "criteria of staying"]);
    run(["acceptance_test", "create", "--parent", "2", "test of staying", "--artefact", "bash a.sh"]);
    run(["acceptance_test", "create", "--parent", "1", "test of landing", "--artefact", "bash b.sh"]);
    run(["task", "create", "--parent", "2", "work of landing", "--role", "engineer"]);
    run(["task", "create", "--parent", "1", "work of staying", "--role", "engineer"]);
  });

  afterEach(() => process.chdir(was));

  /** The story branch, with a commit that does not touch anything master changed. */
  const branchOf = (id: number): string => {
    const db = sql();
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);
    const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
    db.close();
    git("checkout", "-q", "-b", `story/${slug}`);
    writeFileSync(join(repo, "answer.ts"), "export const two = 2;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "the story's answer");
    git("checkout", "-q", "master");
    return `story/${slug}`;
  };

  const landed = (): { task_id: number; branch: string; sha: string; merged_at: string }[] => {
    const db = sql();
    const rows = db.prepare("SELECT * FROM landed_branch ORDER BY task_id").all() as {
      task_id: number;
      branch: string;
      sha: string;
      merged_at: string;
    }[];
    db.close();
    return rows;
  };

  it("writes one row per task under the story, and none under the other one", () => {
    const branch = branchOf(1);
    out.length = 0;
    expect(run(["land", "1"])).toBe(0);
    expect(said()).toContain(`${branch} landed on master`);

    // task #1 is the one story #1's tree reaches; task #2 belongs to story #2.
    const rows = landed();
    expect(rows.map((r) => r.task_id)).toEqual([1]);
    expect(rows[0]?.branch).toBe(branch);
    expect(rows[0]?.sha).toBe(git("rev-parse", "HEAD").trim());
  });

  it("names the landed_branch columns the same way the table does", () => {
    branchOf(1);
    expect(run(["land", "1"])).toBe(0);
    const db = sql();
    const columns = (db.prepare("PRAGMA table_info(landed_branch)").all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(columns).toEqual(["task_id", "branch", "sha", "merged_at"]);
  });

  it("overwrites the row rather than failing, when the same task lands a second time", () => {
    const branch = branchOf(1);
    expect(run(["land", "1"])).toBe(0);
    const first = landed();
    expect(first.map((r) => r.task_id)).toEqual([1]);

    // The branch moves on, so this is a real second merge of the same story and the upsert
    // meets the conflict it exists for: task #1 already has a row.
    git("checkout", "-q", branch);
    writeFileSync(join(repo, "answer.ts"), "export const two = 3;\n");
    git("commit", "-q", "-am", "the story's second answer");
    git("checkout", "-q", "master");

    out.length = 0;
    expect(run(["land", "1"])).toBe(0);
    const again = landed();
    expect(again.map((r) => r.task_id)).toEqual([1]);
    expect(again[0]?.sha).toBe(git("rev-parse", "HEAD").trim());
    expect(again[0]?.sha).not.toBe(first[0]?.sha);
  });

  it("refuses a story that is not delivered, before any of this", () => {
    expect(run(["land", "2"])).toBe(1);
    expect(why()).toContain("story #2 is planned");
  });
});
