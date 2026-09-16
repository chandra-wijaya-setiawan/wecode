import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EditError,
  NO_ARTEFACT,
  NO_WORDS,
  RESTATABLE,
  recordScopeRefusal,
  restate,
  scopeRefusals,
  setArtefact,
  setScriptPath,
  setTaskRole,
  setTaskScope,
  type Restatable,
} from "../src/index.js";
import { freshDb, recordRed, seed } from "./helpers.js";

const source = readFileSync(fileURLToPath(new URL("../src/edit.ts", import.meta.url)), "utf8");

const PAST = "2020-01-01T00:00:00.000Z";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

/** Read one column of one row the way nothing in `edit.ts` may any more: in SQL, from the
 *  test, so what the module wrote is checked against the database and not against itself. */
const column = (table: string, col: string, id: number): string | null => {
  const row = db.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(id) as
    | { v: string | null }
    | undefined;
  return row === undefined ? null : row.v;
};

const ledgerFor = (entity: string, id: number) =>
  db
    .prepare("SELECT verb, from_state, to_state, actor, at FROM ledger WHERE entity = ? AND entity_id = ?")
    .all(entity, id) as { verb: string; from_state: string; to_state: string; actor: string; at: string }[];

/** Back-date the stamp, so "it re-stamped the row" is a question about the code and not
 *  about whether two writes in the same millisecond produced two different ISO strings. */
const backdate = (table: string, id: number): void => {
  db.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(PAST, id);
};

/** Every restatable entity, with the id the fixture gave it. */
const ROWS: Record<Restatable, () => number> = {
  epic: () => tree.epic,
  story: () => tree.story,
  requirement: () => tree.requirement,
  acceptance_criteria: () => tree.criteria,
  acceptance_test: () => tree.acceptance,
  task: () => tree.task,
  task_test: () => tree.taskTest,
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

describe("the edit verbs, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in the module", () => {
    expect(source).not.toMatch(/\bprepare\s*\(/);
    expect(source.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES|CONFLICT)\b/g)).toBeNull();
  });

  it("speaks to the database only through the dialect", () => {
    // `DatabaseSync` is still every caller's currency, but it arrives as a type: nothing in
    // here may call a method on it.
    expect(source).toMatch(/import type \{ DatabaseSync \}/);
    // `./db.js` is the dialect's own module, so only a call on the binding counts.
    expect(source).not.toMatch(/\bdb\.(prepare|exec|run|get|all|close)\b/);
  });

  it("declares its tables unexported, so `export *` from index.ts cannot collide", () => {
    expect(source).not.toMatch(/export const \w+ = table</);
  });
});

describe("restate, on the typed layer", () => {
  it("rewrites the prose of every restatable entity in the column RESTATABLE names", () => {
    for (const [entity, col] of Object.entries(RESTATABLE) as [Restatable, string][]) {
      const id = ROWS[entity]();
      const was = column(entity, col, id);

      const out = restate(db, entity, id, `  the ${entity} said better  `, "chief");

      // The closure's column and the one RESTATABLE advertises are two copies of the same
      // fact; this is the check between them.
      expect(column(entity, col, id)).toBe(`the ${entity} said better`);
      expect(out).toEqual({ was, now: `the ${entity} said better`, state: column(entity, "state", id) });
    }
  });

  it("leaves the slug and the state exactly as they were", () => {
    const slug = column("story", "slug", tree.story);
    const state = column("story", "state", tree.story);

    restate(db, "story", tree.story, "reset the password by mail", "chief");

    expect(column("story", "slug", tree.story)).toBe(slug);
    expect(column("story", "state", tree.story)).toBe(state);
  });

  it("re-stamps the row, with the same clock reading the ledger line carries", () => {
    backdate("story", tree.story);

    restate(db, "story", tree.story, "reset the password by mail", "chief");

    const [line] = ledgerFor("story", tree.story);
    expect(column("story", "updated_at", tree.story)).not.toBe(PAST);
    expect(column("story", "updated_at", tree.story)).toBe(line.at);
  });

  it("puts the old wording on the ledger, from_state and to_state the same", () => {
    const was = column("story", "title", tree.story);

    restate(db, "story", tree.story, "reset the password by mail", "chief");

    expect(ledgerFor("story", tree.story)).toEqual([
      {
        verb: "restate",
        from_state: "in_progress",
        to_state: "in_progress",
        actor: `chief: was "${was}"`,
        at: column("story", "updated_at", tree.story),
      },
    ]);
  });

  it("refuses wording that is nothing but blanks, and writes neither row nor ledger line", () => {
    backdate("story", tree.story);

    expect(() => restate(db, "story", tree.story, "   ", "chief")).toThrow(NO_WORDS);

    expect(column("story", "updated_at", tree.story)).toBe(PAST);
    expect(ledgerFor("story", tree.story)).toEqual([]);
  });

  it("refuses a record that is not there, and leaves the ledger empty", () => {
    expect(() => restate(db, "story", 9999, "words", "chief")).toThrow(new EditError("no story #9999"));
    expect(ledgerFor("story", 9999)).toEqual([]);
  });

  it("loses the row and the ledger line together when the write fails after the prose", () => {
    // `actor` is NOT NULL on the ledger; a state the row cannot keep is not reachable, so
    // the transaction is proved by the ledger insert being inside it.
    const before = column("story", "title", tree.story);
    db.prepare("DROP TABLE ledger").run();

    expect(() => restate(db, "story", tree.story, "reset the password by mail", "chief")).toThrow();

    expect(column("story", "title", tree.story)).toBe(before);
  });
});

describe("setTaskScope and setTaskRole, on the typed layer", () => {
  const WIDER = { write: ["packages/**"], tools: ["bash"] };

  it("writes the scope as JSON and re-stamps the task", () => {
    backdate("task", tree.task);

    setTaskScope(db, tree.task, WIDER);

    expect(JSON.parse(column("task", "scope", tree.task) ?? "null")).toEqual(WIDER);
    expect(column("task", "updated_at", tree.task)).not.toBe(PAST);
  });

  it("refuses a task that is not there", () => {
    expect(() => setTaskScope(db, 9999, WIDER)).toThrow(new EditError("no task #9999"));
  });

  it("checks the role's ceiling when roles are loaded, and writes nothing when refused", () => {
    const before = column("task", "scope", tree.task);
    const roles = { roles: { engineer: { scope: { write: ["src/mail/**"], tools: ["bash"] } } } };

    expect(() => setTaskScope(db, tree.task, WIDER, roles)).toThrow(EditError);
    expect(column("task", "scope", tree.task)).toBe(before);

    setTaskScope(db, tree.task, { write: ["src/mail/api.ts"], tools: ["bash"] }, roles);
    expect(JSON.parse(column("task", "scope", tree.task) ?? "null")).toEqual({
      write: ["src/mail/api.ts"],
      tools: ["bash"],
    });
  });

  it("forgets a refusal the new scope covers, and keeps one it does not", () => {
    recordScopeRefusal(db, tree.task, ["config/views.yaml", "packages/tui/src/views.ts"]);

    setTaskScope(db, tree.task, { write: ["packages/**"], tools: [] });

    expect(scopeRefusals(db, tree.task)).toEqual(["config/views.yaml"]);

    setTaskScope(db, tree.task, { write: ["config/**", "packages/**"], tools: [] });
    expect(scopeRefusals(db, tree.task)).toEqual([]);
  });

  it("sets a role, re-stamps the task, and refuses an id with no row", () => {
    backdate("task", tree.task);

    setTaskRole(db, tree.task, "reviewer");

    expect(column("task", "role", tree.task)).toBe("reviewer");
    expect(column("task", "updated_at", tree.task)).not.toBe(PAST);
    expect(() => setTaskRole(db, 9999, "reviewer")).toThrow(new EditError("no task #9999"));
  });
});

describe("recordScopeRefusal, on the typed layer", () => {
  it("accumulates the paths as a sorted set, one row per task", () => {
    recordScopeRefusal(db, tree.task, ["config/views.yaml"]);
    recordScopeRefusal(db, tree.task, [" packages/tui/src/views.ts ", "config/views.yaml", "  "]);

    expect(scopeRefusals(db, tree.task)).toEqual(["config/views.yaml", "packages/tui/src/views.ts"]);
    const rows = db.prepare("SELECT task_id FROM scope_refusal").all();
    expect(rows).toHaveLength(1);
  });

  it("re-stamps the row it upserts over", () => {
    recordScopeRefusal(db, tree.task, ["config/views.yaml"]);
    db.prepare("UPDATE scope_refusal SET at = ? WHERE task_id = ?").run(PAST, tree.task);

    recordScopeRefusal(db, tree.task, ["packages/tui/src/views.ts"]);

    const at = (db.prepare("SELECT at FROM scope_refusal WHERE task_id = ?").get(tree.task) as { at: string }).at;
    expect(at).not.toBe(PAST);
  });

  it("records nothing for a set of blanks, and reads empty for a task with no row", () => {
    recordScopeRefusal(db, tree.task, ["", "   "]);
    expect(db.prepare("SELECT task_id FROM scope_refusal").all()).toEqual([]);
    expect(scopeRefusals(db, tree.task)).toEqual([]);
  });

  it("is silent on a workspace whose database predates the table", () => {
    db.prepare("DROP TABLE scope_refusal").run();

    expect(() => recordScopeRefusal(db, tree.task, ["config/views.yaml"])).not.toThrow();
    expect(scopeRefusals(db, tree.task)).toEqual([]);
    expect(() => setTaskScope(db, tree.task, { write: ["packages/**"], tools: [] })).not.toThrow();
  });

  it("reads empty rather than throwing when the stored paths are not an array of strings", () => {
    recordScopeRefusal(db, tree.task, ["config/views.yaml"]);
    db.prepare("UPDATE scope_refusal SET paths = ? WHERE task_id = ?").run('{"not":"an array"}', tree.task);

    expect(scopeRefusals(db, tree.task)).toEqual([]);
  });
});

describe("setArtefact and setScriptPath, on the typed layer", () => {
  it("sets the artefact on either test table, and re-stamps it", () => {
    for (const [entity, id] of [
      ["acceptance_test", tree.acceptance],
      ["task_test", tree.taskTest],
    ] as const) {
      backdate(entity, id);

      setArtefact(db, entity, id, "bash test/new.sh");

      expect(column(entity, "artefact", id)).toBe("bash test/new.sh");
      expect(column(entity, "updated_at", id)).not.toBe(PAST);
    }
  });

  it("refuses an empty artefact, and an id with no row, on either table", () => {
    expect(() => setArtefact(db, "acceptance_test", tree.acceptance, "  ")).toThrow(NO_ARTEFACT);
    expect(column("acceptance_test", "artefact", tree.acceptance)).toBe("bash test/mail.sh");
    expect(() => setArtefact(db, "task_test", 9999, "vitest run")).toThrow(
      new EditError("no task_test #9999"),
    );
  });

  it("clears the acceptance_test's red-at-base verdict, because it observed the old command", () => {
    recordRed(db, tree.acceptance);
    expect(column("acceptance_test", "red_at_base_sha", tree.acceptance)).not.toBeNull();

    setArtefact(db, "acceptance_test", tree.acceptance, "bash test/new.sh");

    expect(column("acceptance_test", "red_at_base_sha", tree.acceptance)).toBeNull();
    expect(column("acceptance_test", "red_at_base_at", tree.acceptance)).toBeNull();
  });

  it("clears the `red_at_base` lens with the column, because since 007 the name is a view", () => {
    // Migration 007 made `red_at_base` a read-only view over the column, so the side-table
    // branch is unreachable on a migrated database — and has to stay unreachable, since a
    // DELETE against a view is an error. The lens empties because the column did.
    expect(
      db.prepare("SELECT type FROM sqlite_master WHERE name = 'red_at_base'").get(),
    ).toEqual({ type: "view" });
    recordRed(db, tree.acceptance);
    expect(
      db.prepare("SELECT red_at_base_sha AS v FROM red_at_base WHERE test_id = ?").get(tree.acceptance),
    ).toEqual({ v: "base0000" });

    setArtefact(db, "acceptance_test", tree.acceptance, "bash test/new.sh");

    expect(
      db.prepare("SELECT red_at_base_sha AS v FROM red_at_base WHERE test_id = ?").get(tree.acceptance),
    ).toEqual({ v: null });
  });

  it("leaves the verdict alone when the test is a task_test — only an acceptance_test records one", () => {
    recordRed(db, tree.acceptance);

    setArtefact(db, "task_test", tree.taskTest, "vitest run mailer");

    expect(column("acceptance_test", "red_at_base_sha", tree.acceptance)).toBe("base0000");
  });

  it("sets a script path, clears it with null, and refuses an id with no row", () => {
    for (const [entity, id] of [
      ["acceptance_test", tree.acceptance],
      ["task_test", tree.taskTest],
    ] as const) {
      setScriptPath(db, entity, id, "test/mail.sh");
      expect(column(entity, "script_path", id)).toBe("test/mail.sh");

      backdate(entity, id);
      setScriptPath(db, entity, id, null);
      expect(column(entity, "script_path", id)).toBeNull();
      expect(column(entity, "updated_at", id)).not.toBe(PAST);
    }
    expect(() => setScriptPath(db, "acceptance_test", 9999, "test/x.sh")).toThrow(
      new EditError("no acceptance_test #9999"),
    );
  });

  it("does not clear the red-at-base verdict for a script path — the command is unchanged", () => {
    recordRed(db, tree.acceptance);

    setScriptPath(db, "acceptance_test", tree.acceptance, "test/mail.sh");

    expect(column("acceptance_test", "red_at_base_sha", tree.acceptance)).toBe("base0000");
  });
});
