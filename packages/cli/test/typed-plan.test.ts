import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

const source = readFileSync(fileURLToPath(new URL("../src/plan.ts", import.meta.url)), "utf8");

/** The module with its prose taken out. The port's commentary names the SQL it replaced —
 *  `ORDER BY id DESC LIMIT 1` is the clearest way to say what the `Math.max` is — and a
 *  keyword in a comment reaches no database. What must be gone is the SQL that runs. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

let out: string[];
let err: string[];
let repo: string;

const PROJECT = `stack: node
test: pnpm test
typecheck: tsc -b
source: ["src/**"]
tests: ["test/**"]
`;

beforeEach(() => {
  repo = tmp("wecode-typed-plan-");
  mkdirSync(join(repo, "config"));
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

/** This repository, as an onboarded project with one in-progress epic — what a plan file
 *  hangs off when it names no parent. */
function project(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "0.0.1"]);
  run(["epic", "create", "--parent", "1", "the cockpit"]);
  run(["epic", "start", "1"]);
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  out.length = 0;
}

function db(): DatabaseSync {
  return open(process.env["WECODE_DB"] as string);
}

/** A second project, in another repository, with a whole tree of its own. Rows here are
 *  found by their sentence and never by id: every id is global, so a test that recognised a
 *  row by its number would pass while the project narrowing it means to prove was gone. */
function elsewhere(story: string, statement: string): { project: number; story: number; criteria: number } {
  const conn = db();
  const make = new Maker(conn);
  const engine = new Engine(conn);
  const p = make.project(1, "other", "/elsewhere");
  const rel = make.release(p, "9.0.0");
  const epic = make.epic(rel, "their epic");
  engine.apply("epic", epic, "start", "operator");
  const s = make.story(epic, story);
  const req = make.requirement(s, "their requirement");
  const criteria = make.criteria(req, statement);
  return { project: p, story: s, criteria };
}

function file(body: string): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(path, body);
  return path;
}

const said = (): string => out.join("");
const complained = (): string => err.join("");

const row = <T>(sql: string, ...args: (string | number)[]): T =>
  db().prepare(sql).get(...args) as T;

/** A one-requirement story body, so a test says only what it is about. */
const story = (title: string, statement = "a criteria", rule = "a rule"): string =>
  `story: ${title}
requirements:
  - statement: ${rule}
    criteria:
      - statement: ${statement}
        test: pnpm test
        tasks:
          - title: do the work
`;

describe("the plan command, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in the module", () => {
    expect(code).not.toMatch(/\bprepare\s*\(/);
    expect(code.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT)\b/g)).toBeNull();
  });

  it("speaks to the database only through the dialect", () => {
    // `DatabaseSync` is still the currency every caller passes, but it arrives as a type and
    // is handed on; nothing in here calls a method on it.
    expect(source).toContain('import { queries, table, type Dialect }');
    expect(code).not.toMatch(/\bdb\.(prepare|exec|get|all|run)\b/);
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migration cannot drift apart without a test saying
   *  so — and the list lives in one place, the module, not in a copy here. */
  it("asks only for columns the migrations actually built", () => {
    project();
    const conn = db();
    const declared = [...source.matchAll(/table<[^>]*>\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map((m) => ({
      name: m[1] as string,
      columns: [...(m[2] as string).matchAll(/"(\w+)"/g)].map((c) => c[1] as string),
    }));

    expect(declared.map((d) => d.name).sort()).toEqual([
      "acceptance_criteria",
      "acceptance_test",
      "epic",
      "project",
      "release",
      "requirement",
      "story",
      "task",
      "task_test",
    ]);
    for (const d of declared) {
      const actual = (conn.prepare(`PRAGMA table_info(${d.name})`).all() as { name: string }[]).map((c) => c.name);
      expect(d.columns.length).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });
});

describe("the parent a file hangs off, through the layer", () => {
  it("hangs a story off the newest in-progress epic, not the first and not a planned one", () => {
    project();
    run(["epic", "create", "--parent", "1", "the second epic"]);
    run(["epic", "start", "2"]);
    run(["epic", "create", "--parent", "1", "a planned epic"]);

    expect(run(["plan", file(story("a story with no parent named"))])).toBe(0);
    expect(row<{ epic_id: number }>("SELECT epic_id FROM story WHERE id = 1").epic_id).toBe(2);
  });

  it("says which project an id belongs to when it is not this one", () => {
    project();
    const theirs = elsewhere("their story", "their criteria");

    expect(run(["plan", file(story(String(theirs.story)))])).toBe(1);
    expect(complained()).toContain(`story #${theirs.story} belongs to project #${theirs.project} other`);
    expect(complained()).toContain("but you are in #1 storefront");
  });

  it("says there is no such row for an id nothing owns", () => {
    project();
    expect(run(["plan", file(story("404"))])).toBe(1);
    expect(complained()).toContain("no story #404");
  });

  it("takes a new epic's release from the epic --epic names", () => {
    project();
    const path = file(`epic: a new epic
stories:
  - story: a story under it
    requirements:
      - statement: a rule
        criteria:
          - statement: a criteria
            test: pnpm test
`);
    expect(run(["plan", path, "--epic", "1"])).toBe(0);
    expect(row<{ release_id: number }>("SELECT release_id FROM epic WHERE id = 2").release_id).toBe(1);
  });

  it("hangs a new release off the project this repository is", () => {
    project();
    const path = file(`release: 0.0.2
epics:
  - epic: an epic in the new release
    stories:
      - story: a story in it
        requirements:
          - statement: a rule
            criteria:
              - statement: a criteria
                test: pnpm test
`);
    expect(run(["plan", path])).toBe(0);
    expect(row<{ project_id: number }>("SELECT project_id FROM release WHERE version = '0.0.2'").project_id).toBe(1);
    // Read back by the column a release is named by, which is the label closure's to choose.
    expect(said()).toContain("0.0.2");
  });

  it("refuses a story with no epic when this project has no in-progress epic", () => {
    project();
    db().prepare("UPDATE epic SET state = 'planned' WHERE id = 1").run();

    expect(run(["plan", file(story("a story with nowhere to hang"))])).toBe(1);
    expect(complained()).toContain("project #1 storefront has no in-progress epic");
  });
});

describe("what this project has already said, through the layer", () => {
  it("refuses a story sentence this project already carries, by the id it duplicates", () => {
    project();
    expect(run(["plan", file(story("one reusable list", "the list renders"))])).toBe(0);

    expect(run(["plan", file(story("one reusable list", "something else entirely"))])).toBe(1);
    expect(complained()).toContain("story #1 already says one reusable list");
  });

  it("refuses a criteria sentence this project already carries", () => {
    project();
    expect(run(["plan", file(story("the first story", "the list renders at three sizes"))])).toBe(0);

    expect(run(["plan", file(story("a different story", "the list renders at three sizes"))])).toBe(1);
    expect(complained()).toContain("already says the list renders at three sizes");
  });

  /** The narrowing the join used to do. Another project's sentence is not this project's
   *  duplicate — two projects may want the same list — and a `sameStory` that forgot whose
   *  project a row was in would refuse this file. */
  it("allows a sentence only another project has said", () => {
    project();
    const theirs = elsewhere("one reusable list", "the list renders at three sizes");

    expect(run(["plan", file(story("one reusable list", "the list renders at three sizes"))])).toBe(0);
    expect(complained()).toBe("");
    const mine = row<{ id: number }>(
      "SELECT id FROM story WHERE title = 'one reusable list' AND id != ?",
      theirs.story,
    );
    expect(mine.id).not.toBe(theirs.story);
  });
});

describe("the tree it prints back, through the layer", () => {
  it("reads every rung back by its own label column, with the state it is in", () => {
    project();
    expect(run(["plan", file(story("the story", "the criteria"))])).toBe(0);

    // A release is its version, an epic and a story and a task are titles, the rest are
    // statements — eight rungs whose label column used to be interpolated into the SQL.
    expect(said()).toContain("the story");
    expect(said()).toContain("a rule");
    expect(said()).toContain("the criteria");
    expect(said()).toContain("do the work");
    expect(said()).toContain("in_progress");
    expect(said()).toContain("ready");
  });

  it("starts a story it joined by id, and prints it by its own title", () => {
    project();
    run(["story", "create", "--parent", "1", "an existing story"]);
    out.length = 0;

    expect(run(["plan", file(story("1"))])).toBe(0);
    expect(row<{ state: string }>("SELECT state FROM story WHERE id = 1").state).toBe("in_progress");
    expect(said()).toContain("an existing story");
  });

  /** The state read is what decides. A story already underway must not be started again —
   *  the ledger would carry a second `start` line for a transition that never happened. */
  it("leaves a story already underway alone", () => {
    project();
    run(["story", "create", "--parent", "1", "an existing story"]);
    run(["story", "start", "1"]);
    out.length = 0;

    expect(run(["plan", file(story("1"))])).toBe(0);
    expect(row<{ state: string }>("SELECT state FROM story WHERE id = 1").state).toBe("in_progress");
    const starts = row<{ n: number }>(
      "SELECT count(*) AS n FROM ledger WHERE entity = 'story' AND entity_id = 1 AND verb = 'start'",
    );
    expect(starts.n).toBe(1);
  });
});
