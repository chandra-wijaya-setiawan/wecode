import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { CreateError, Engine, Maker, open, type Scope } from "../src/index.js";
import { tmp } from "./tmpdir.js";

const source = readFileSync(fileURLToPath(new URL("../src/create.ts", import.meta.url)), "utf8");

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;

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
});

const row = (table: string, id: number): Record<string, unknown> =>
  db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;

describe("the create module, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in the module", () => {
    expect(source).not.toMatch(/\bprepare\s*\(/);
    expect(source.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT)\b/g)).toBeNull();
  });

  it("speaks to the database only through the dialect", () => {
    expect(source).toContain('from "./db.js"');
    expect(source).not.toMatch(/\bdb\.(prepare|exec|get|all|run)\b/);
    expect(source).not.toMatch(/last_insert_rowid/);
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migrations cannot drift apart without a test saying
   *  so — and the list lives in one place, the module, not in a copy here. */
  it("writes only columns the migrations actually built", () => {
    const named = [...source.matchAll(/table<(\w+)>\(\s*"(\w+)",\s*(\[[^\]]*\]|\w+)/g)];
    const lists = new Map(
      [...source.matchAll(/const (\w+) = \[([^\]]*)\] as const/g)].map((m) => [m[1], m[2]]),
    );
    const shapes = new Map(
      [...source.matchAll(/interface (\w+) (?:extends (\w+) )?\{([^}]*)\}/g)].map((m) => [
        m[1],
        { parent: m[2], body: m[3] },
      ]),
    );

    const columnsOf = (spec: string): string[] => {
      const body = spec.startsWith("[") ? spec : `[${lists.get(spec) ?? ""}]`;
      const spreads = [...body.matchAll(/\.\.\.(\w+)/g)].flatMap((s) => columnsOf(s[1]));
      return [...spreads, ...[...body.matchAll(/"(\w+)"/g)].map((c) => c[1])];
    };

    const fieldsOf = (shape: string): string[] => {
      const found = shapes.get(shape);
      if (found === undefined) return [];
      return [
        ...(found.parent === undefined ? [] : fieldsOf(found.parent)),
        ...[...found.body.matchAll(/(\w+)\??:/g)].map((f) => f[1]),
      ];
    };

    expect(named.map((m) => m[2]).sort()).toEqual([
      "acceptance_criteria",
      "acceptance_test",
      "assignment",
      "epic",
      "project",
      "release",
      "requirement",
      "role",
      "story",
      "task",
      "task_test",
      "worker",
      "workspace",
    ]);

    for (const m of named) {
      const [, shape, name, spec] = m;
      const declared = columnsOf(spec);
      const actual = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
      expect(declared.length).toBeGreaterThan(0);
      for (const c of declared) expect(actual, `${name}.${c}`).toContain(c);
      // The row shape and the column list are the same fact twice; they must agree.
      expect([...declared].sort(), `${name} shape`).toEqual([...fieldsOf(shape)].sort());
    }
  });
});

describe("the new id, read back without last_insert_rowid", () => {
  it("returns the id of the row it just wrote, at every level of the tree", () => {
    const at = make.acceptanceTest(criteria, "prove it", "script", "bash x.sh");
    const t = make.task(at, "do it");
    const tt = make.taskTest(t, "unit", "script", "vitest run");

    expect(row("acceptance_test", at).statement).toBe("prove it");
    expect(row("task", t).title).toBe("do it");
    expect(row("task_test", tt).parent_id).toBe(t);
  });

  /** The ids a tree of siblings gets are the ids their rows have — the read-back must not
   *  hand out an earlier sibling's id when every column but the slug matches. */
  it("keeps siblings written in the same millisecond apart", () => {
    const ids = ["a", "b", "c"].map((n) => make.acceptanceTest(criteria, n, "manual"));

    expect(new Set(ids).size).toBe(3);
    for (const [i, id] of ids.entries()) expect(row("acceptance_test", id).slug).toBe(["a", "b", "c"][i]);
  });

  /** Two workspaces may hold a project of the same name, and the slug is unique only within
   *  the parent — so the read-back has to be narrowed by the parent as well. */
  it("tells two same-named projects in different workspaces apart", () => {
    const other = make.workspace("other", "/other");
    const mine = make.project(other, "s", "/r2");

    expect(row("project", mine).workspace_id).toBe(other);
    expect(row("project", mine).repo).toBe("/r2");
  });

  it("gives an assignment its final slug, built from the id it was given", () => {
    const w = make.worker("claude-1", "engineer", "agent");
    const a = make.assignment({
      objective_type: "task",
      objective_id: 7,
      worker_id: w,
      scope: { write: [], tools: [] },
      budget: { tokens: 1, seconds: 1 },
      worktree: "/tmp/wt",
    });

    expect(row("assignment", a).slug).toBe(`task-7-${a}`);
    expect(row("assignment", a).phase).toBe("pending");
  });

  it("writes a null artefact as null, not as the string", () => {
    const at = make.acceptanceTest(criteria, "manual proof", "manual");

    expect(row("acceptance_test", at).artefact).toBeNull();
    expect(row("acceptance_test", at).script_path).toBeNull();
  });

  it("copies the scope and budget it was handed, and defaults the rest", () => {
    const scope: Scope = { write: ["src/**"], tools: ["bash"] };
    const at = make.acceptanceTest(criteria, "p", "manual");
    const t = make.task(at, "scoped", { scope, role: "engineer", max_retry: 9 });

    expect(JSON.parse(String(row("task", t).scope))).toEqual(scope);
    expect(row("task", t).max_retry).toBe(9);
    expect(row("task", t).attempts).toBe(0);
    expect(JSON.parse(String(row("task", t).budget))).toMatchObject({ tokens: expect.any(Number) });
  });
});

describe("the refusals, through the layer", () => {
  it("names the row that already holds the slug", () => {
    make.acceptanceTest(criteria, "prove it", "manual");

    expect(() => make.acceptanceTest(criteria, "prove it", "manual")).toThrow(
      /acceptance_test: slug "prove-it" is already taken by acceptance_test #\d+ \(planned\)/,
    );
  });

  it("says a dropped row still holds it", () => {
    const at = make.acceptanceTest(criteria, "prove it", "manual");
    engine.apply("acceptance_test", at, "drop", "chief");

    expect(() => make.acceptanceTest(criteria, "prove it", "manual")).toThrow(
      /\(dropped\)\. A dropped row still holds its slug\./,
    );
  });

  /** A table with no state column has no state to name, and the message must not invent one. */
  it("names a stateless row without a state", () => {
    make.worker("claude-1", "engineer", "agent");

    expect(() => make.worker("claude-1", "engineer", "agent")).toThrow(
      /worker: slug "claude-1" is already taken by worker #\d+\. Choose a different title\./,
    );
  });

  it("still refuses a task under a settled acceptance_test", () => {
    const at = make.acceptanceTest(criteria, "prove it", "manual");
    engine.apply("acceptance_test", at, "drop", "chief");

    expect(() => make.task(at, "doomed")).toThrow(CreateError);
    expect(() => make.task(at, "doomed")).toThrow(/is dropped, so a task under it could never be accepted/);
  });

  it("lets a task under an open acceptance_test through", () => {
    const at = make.acceptanceTest(criteria, "prove it", "manual");

    expect(make.task(at, "fine")).toBeGreaterThan(0);
  });

  it("still refuses a version that is not major.minor.patch", () => {
    const ws = make.workspace("beta", "/beta");
    const p = make.project(ws, "b", "/rb");

    expect(() => make.release(p, "0.1")).toThrow(/version must be major\.minor\.patch/);
  });
});
