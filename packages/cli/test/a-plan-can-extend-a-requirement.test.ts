import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { plan } from "../src/plan.js";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A requirement already on the ledger is where the next criteria belongs. Without this, a
 *  plan file could only ever make a new requirement, so extending the work already running
 *  meant either a duplicate requirement saying the same thing or eighteen `create` commands
 *  by hand. A requirement named by id is the parent; the criteria under it are new. */

let repo: string;
let out: string[];
let err: string[];

const PROJECT = `stack: node
test: pnpm test
typecheck: tsc -b
source: ["src/**"]
tests: ["test/**"]
`;

const ROLES = `invariants:
  never_touch: [".github/**"]
  never_run: ["rm -rf /*"]

roles:
  engineer:
    worker_kind: agent
    scope:
      write: ["src/**", "test/**"]
      tools: ["bash", "read", "edit", "write"]
`;

beforeEach(() => {
  repo = tmp("wecode-plan-extend-");
  mkdirSync(join(repo, "config"));
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  writeFileSync(join(repo, "config", "roles.yaml"), ROLES);
});

afterEach(() => vi.restoreAllMocks());

/** A project with an in-progress epic and story #1, which already holds requirement #1 and
 *  one criteria under it. Story #2 is a second story, so "someone else's requirement" is a
 *  row that really exists rather than a made-up id. */
function project(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "0.0.1"]);
  run(["epic", "create", "--parent", "1", "the cockpit"]);
  run(["epic", "start", "1"]);
  run(["story", "create", "--parent", "1", "the list is one function"]);
  run(["story", "start", "1"]);
  run(["requirement", "create", "--parent", "1", "a box and a box page are one list function"]);
  run(["requirement", "start", "1"]);
  run(["acceptance_criteria", "create", "--parent", "1", "one function renders rows and a cursor"]);
  run(["story", "create", "--parent", "1", "the outline names its columns"]);
  out.length = 0;
  err.length = 0;
}

function db() {
  return open(process.env["WECODE_DB"] as string);
}

function rows<R>(sql: string, ...args: unknown[]): R[] {
  return db()
    .prepare(sql)
    .all(...(args as never[])) as R[];
}

function state(table: string, id: number): string {
  return (db().prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;
}

/** A plan file joining story #1 and hanging one new criteria off requirement #1. */
const EXTENDING = `story: 1

requirements:
  - requirement: 1
    criteria:
      - statement: the cursor survives a resize
        test: pnpm exec vitest run test/list.test.ts
        tasks:
          - title: keep the cursor on resize
            scope: ["src/list.ts", "test/list.test.ts"]
            test: pnpm exec vitest run test/list.test.ts
`;

function planning(body: string): number {
  const path = join(repo, "plan.yaml");
  writeFileSync(path, body);
  return plan([path]);
}

const complained = (): string => err.join("");
const printed = (): string => out.join("");

describe("a plan names an existing requirement as the parent of new criteria", () => {
  it("creates the criteria under that requirement and no second requirement", () => {
    project();
    expect(planning(EXTENDING)).toBe(0);
    expect(complained()).toBe("");

    const made = rows<{ id: number; requirement_id: number; statement: string }>(
      "SELECT id, requirement_id, statement FROM acceptance_criteria ORDER BY id",
    );
    expect(made.map((c) => [c.statement, c.requirement_id])).toEqual([
      ["one function renders rows and a cursor", 1],
      ["the cursor survives a resize", 1],
    ]);
    expect(rows("SELECT id FROM requirement")).toHaveLength(1);
  });

  it("makes the whole chain under it — an acceptance test, a task and its test", () => {
    project();
    planning(EXTENDING);

    const criterion = rows<{ id: number }>("SELECT id FROM acceptance_criteria WHERE statement = ?", "the cursor survives a resize")[0];
    expect(criterion).toBeDefined();
    const test = rows<{ id: number; parent_id: number }>(
      "SELECT id, parent_id FROM acceptance_test WHERE parent_id = ?",
      criterion?.id,
    );
    expect(test).toHaveLength(1);
    expect(rows("SELECT id FROM task WHERE title = ?", "keep the cursor on resize")).toHaveLength(1);
  });

  it("starts the new criteria and leaves the joined requirement's own state alone", () => {
    project();
    expect(state("requirement", 1)).toBe("in_progress");
    planning(EXTENDING);

    const criterion = rows<{ id: number }>("SELECT id FROM acceptance_criteria WHERE statement = ?", "the cursor survives a resize")[0];
    expect(state("acceptance_criteria", criterion?.id as number)).toBe("in_progress");
    expect(state("requirement", 1)).toBe("in_progress");
    expect(
      rows("SELECT id FROM ledger WHERE entity = 'requirement' AND entity_id = 1 AND verb = 'start'"),
    ).toHaveLength(1);
  });

  it("starts a joined requirement that is still planned, so its criteria can run", () => {
    project();
    run(["requirement", "create", "--parent", "1", "the outline is one function"]);
    out.length = 0;
    expect(state("requirement", 2)).toBe("planned");

    expect(planning(EXTENDING.replace("requirement: 1", "requirement: 2"))).toBe(0);
    expect(state("requirement", 2)).toBe("in_progress");
  });

  it("prints the joined requirement back with the id and statement it already had", () => {
    project();
    planning(EXTENDING);
    expect(printed()).toContain("a box and a box page are one list function");
    expect(printed()).toContain("the cursor survives a resize");
  });

  it("names it as joined in a dry run, and creates nothing", () => {
    project();
    const path = join(repo, "plan.yaml");
    writeFileSync(path, EXTENDING);
    expect(plan([path, "--dry-run"])).toBe(0);
    expect(printed()).toContain("requirement #1   joined");
    expect(rows("SELECT id FROM acceptance_criteria WHERE statement = ?", "the cursor survives a resize")).toHaveLength(0);
  });

  it("refuses a requirement id no row has", () => {
    project();
    expect(planning(EXTENDING.replace("requirement: 1", "requirement: 99"))).toBe(1);
    expect(complained()).toContain("no requirement #99");
    expect(rows("SELECT id FROM acceptance_criteria")).toHaveLength(1);
  });

  it("refuses a requirement belonging to another story", () => {
    project();
    run(["requirement", "create", "--parent", "2", "the outline names its columns"]);
    out.length = 0;
    expect(planning(EXTENDING.replace("requirement: 1", "requirement: 2"))).toBe(1);
    expect(complained()).toContain("requirement #2 belongs to story #2, but this file joined story #1");
  });

  it("refuses a joined requirement under a story the file is making", () => {
    project();
    expect(
      planning(`story: a new story

requirements:
  - requirement: 1
    criteria:
      - statement: the cursor survives a resize
        test: pnpm exec vitest run test/list.test.ts
`),
    ).toBe(1);
    expect(complained()).toContain("requirement #1 is under story #1");
    expect(rows("SELECT id FROM story")).toHaveLength(2);
  });

  it("refuses an id that is not one, rather than reading it as a statement", () => {
    project();
    expect(planning(EXTENDING.replace("requirement: 1", "requirement: the list is one function"))).toBe(1);
    expect(complained()).toContain("requirement must be an id");
  });

  it("refuses a requirement that is both joined and stated", () => {
    project();
    expect(planning(EXTENDING.replace("  - requirement: 1", "  - requirement: 1\n    statement: a second sentence"))).toBe(1);
    expect(complained()).toContain("requirement #1 already exists, so statement must not be given too");
  });

  it("refuses a joined requirement with no criteria under it, which would create nothing", () => {
    project();
    expect(
      planning(`story: 1

requirements:
  - requirement: 1
    criteria: []
`),
    ).toBe(1);
    expect(complained()).toContain("requirement #1 is joined to hang criteria off, and there are none");
  });

  it("still requires a statement from a requirement that names no id", () => {
    project();
    expect(planning(EXTENDING.replace("  - requirement: 1\n", "  - \n"))).toBe(1);
    expect(complained()).toContain("statement is required");
  });

  it("says in --help that a requirement id joins that requirement", () => {
    plan(["--help"]);
    expect(printed()).toContain("requirement: 12");
    expect(printed()).toContain("A requirement given as an id joins that requirement");
  });
});
