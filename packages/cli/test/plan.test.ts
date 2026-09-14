import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";

let out: string[];
let err: string[];
let repo: string;

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
  repo = mkdtempSync(join(tmpdir(), "wecode-plan-"));
  mkdirSync(join(repo, "config"));
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

/** A project with one in-progress epic, which is what a plan file hangs off. */
function project(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "0.0.1"]);
  run(["epic", "create", "--parent", "1", "the cockpit"]);
  run(["epic", "start", "1"]);
  out.length = 0;
}

function config(body: string = PROJECT): void {
  writeFileSync(join(repo, "config", "project.yaml"), body);
}

function file(body: string): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(path, body);
  return path;
}

const said = (): string => out.join("");
const complained = (): string => err.join("");

function db() {
  return open(process.env["WECODE_DB"] as string);
}

function count(table: string): number {
  return (db().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function state(table: string, id: number): string {
  return (db().prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;
}

const GOOD = `story: the cockpit is one reusable list at three sizes
epic: 1

requirements:
  - statement: a box, a box page and a node's children are one list function
    criteria:
      - statement: one function renders rows, columns, a height and a cursor
        test: pnpm exec vitest run packages/tui
        tasks:
          - title: write packages/tui/src/list.ts as the contract specifies
            scope: ["src/list.ts", "test/list.test.ts"]
            test: pnpm exec vitest run test/list.test.ts
            role: engineer
`;

describe("wecode plan", () => {
  it("creates the whole story, starts it, and prints the tree", () => {
    project();
    config();
    expect(run(["plan", file(GOOD)])).toBe(0);

    expect(count("story")).toBe(1);
    expect(count("requirement")).toBe(1);
    expect(count("acceptance_criteria")).toBe(1);
    expect(count("acceptance_test")).toBe(1);
    expect(count("task")).toBe(1);
    expect(count("task_test")).toBe(1);

    // Everything it created is started, and each test whose artefact resolves is delivered.
    expect(state("story", 1)).toBe("in_progress");
    expect(state("requirement", 1)).toBe("in_progress");
    expect(state("acceptance_criteria", 1)).toBe("in_progress");
    expect(state("acceptance_test", 1)).toBe("ready");
    expect(state("task_test", 1)).toBe("ready");
    expect(state("task", 1)).toBe("ready");

    const task = db().prepare("SELECT role, scope FROM task WHERE id = 1").get() as { role: string; scope: string };
    expect(task.role).toBe("engineer");
    expect(JSON.parse(task.scope)).toEqual({ write: ["src/list.ts", "test/list.test.ts"], tools: ["bash", "read", "edit", "write"] });

    // The tree comes back as a shape, with every id on it.
    expect(said()).toContain("the cockpit is one reusable list at three sizes");
    expect(said()).toContain("#1");
    expect(said()).toContain("ready");
    expect(said()).toContain("└──");
  });

  it("refuses an unknown key, and creates nothing", () => {
    project();
    config();
    const path = file(`story: a story
epic: 1
requirements:
  - statement: a rule
    criteria:
      - statement: a criteria
        tests: pnpm test
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("unknown key tests");
    expect(count("story")).toBe(0);
  });

  it("refuses a missing statement", () => {
    project();
    config();
    const path = file(`story: a story
epic: 1
requirements:
  - criteria:
      - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("statement is required");
    expect(count("requirement")).toBe(0);
  });

  it("falls back to project.yaml for the scope, the tests and the role, and to the newest epic", () => {
    project();
    config();
    const path = file(`story: a story that leans on the project
requirements:
  - statement: a rule
    criteria:
      - statement: a criteria
        tasks:
          - title: do the work
`);
    expect(run(["plan", path])).toBe(0);

    const story = db().prepare("SELECT epic_id FROM story WHERE id = 1").get() as { epic_id: number };
    expect(story.epic_id).toBe(1);

    const task = db().prepare("SELECT role, scope FROM task WHERE id = 1").get() as { role: string; scope: string };
    expect(task.role).toBe("engineer");
    expect((JSON.parse(task.scope) as { write: string[] }).write).toEqual(["src/**", "test/**"]);

    const artefacts = db()
      .prepare("SELECT artefact FROM acceptance_test UNION ALL SELECT artefact FROM task_test")
      .all() as unknown as { artefact: string }[];
    expect(artefacts.map((a) => a.artefact)).toEqual(["pnpm test", "pnpm test"]);
  });

  it("refuses a task with no scope and no project.yaml", () => {
    project();
    const path = file(`story: a story
epic: 1
requirements:
  - statement: a rule
    criteria:
      - statement: a criteria
        tasks:
          - title: change whatever it likes
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("no scope, and no config/project.yaml");
    expect(count("story")).toBe(0);
  });

  it("refuses a scope that leaves the role's ceiling", () => {
    project();
    config();
    writeFileSync(join(repo, "config", "roles.yaml"), ROLES);
    const path = file(`story: a story
epic: 1
requirements:
  - statement: a rule
    criteria:
      - statement: a criteria
        tasks:
          - title: reach outside
            scope: ["infra/main.tf"]
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("outside the role's write scope: infra/main.tf");
    expect(count("task")).toBe(0);
  });

  it("refuses an epic in another project", () => {
    project();
    config();
    run(["project", "create", "--parent", "1", "other", "--path", join(repo, "elsewhere")]);
    run(["release", "create", "--parent", "2", "0.0.1"]);
    run(["epic", "create", "--parent", "2", "theirs"]);
    out.length = 0;

    expect(run(["plan", file(GOOD.replace("epic: 1", "epic: 2"))])).toBe(1);
    expect(complained()).toContain("belongs to project #2");
    expect(count("story")).toBe(0);
  });

  it("--dry-run prints the tree and creates nothing", () => {
    project();
    config();
    expect(run(["plan", file(GOOD), "--dry-run"])).toBe(0);
    expect(said()).toContain("the cockpit is one reusable list at three sizes");
    expect(said()).toContain("under epic #1");
    expect(said()).toContain("nothing created");
    for (const table of ["story", "requirement", "acceptance_criteria", "acceptance_test", "task", "task_test"]) {
      expect(count(table)).toBe(0);
    }
  });

  it("a file that fails halfway leaves nothing behind", () => {
    project();
    config();
    const path = file(`story: a story
epic: 1
requirements:
  - statement: the good half
    criteria:
      - statement: a criteria
        tasks:
          - title: do the work
            scope: ["src/a.ts"]
  - criteria:
      - statement: the bad half has no statement above it
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("requirement 2: statement is required");
    for (const table of ["story", "requirement", "acceptance_criteria", "acceptance_test", "task", "task_test"]) {
      expect(count(table)).toBe(0);
    }
  });

  it("an epic root creates the epic under the newest in-progress release, with its stories", () => {
    project();
    run(["release", "start", "1"]);
    config();
    out.length = 0;
    const path = file(`epic: the cockpit is one list
stories:
  - story: the first story
    requirements:
      - statement: a rule
        criteria:
          - statement: a criteria
            tasks:
              - title: do the work
  - story: the second story
    requirements:
      - statement: another rule
        criteria:
          - statement: another criteria
`);
    expect(run(["plan", path])).toBe(0);

    // Epic 1 is the project's; this file made epic 2, under the release it named none of.
    expect(count("epic")).toBe(2);
    expect((db().prepare("SELECT release_id AS r FROM epic WHERE id = 2").get() as { r: number }).r).toBe(1);
    expect(state("epic", 2)).toBe("in_progress");

    expect(count("story")).toBe(2);
    const stories = db().prepare("SELECT id, epic_id, title FROM story ORDER BY id").all() as unknown as {
      id: number;
      epic_id: number;
      title: string;
    }[];
    expect(stories.map((s) => s.epic_id)).toEqual([2, 2]);
    expect(stories.map((s) => s.title)).toEqual(["the first story", "the second story"]);
    expect(state("story", 1)).toBe("in_progress");
    expect(state("story", 2)).toBe("in_progress");
    expect(count("requirement")).toBe(2);
    expect(said()).toContain("the second story");
  });

  it("a release root creates the release under this project, with its epics and their stories", () => {
    project();
    config();
    const path = file(`release: 0.0.2
epics:
  - epic: the next epic
    stories:
      - story: a story under it
        requirements:
          - statement: a rule
            criteria:
              - statement: a criteria
`);
    expect(run(["plan", path])).toBe(0);

    const made = db().prepare("SELECT project_id AS p, version FROM release WHERE id = 2").get() as {
      p: number;
      version: string;
    };
    expect(made).toEqual({ p: 1, version: "0.0.2" });
    expect(state("release", 2)).toBe("in_progress");
    expect((db().prepare("SELECT release_id AS r FROM epic WHERE id = 2").get() as { r: number }).r).toBe(2);
    expect(state("epic", 2)).toBe("in_progress");
    expect((db().prepare("SELECT epic_id AS e FROM story WHERE id = 1").get() as { e: number }).e).toBe(2);
    expect(state("story", 1)).toBe("in_progress");
  });

  it("a root given as a number joins that row, and does not start it again", () => {
    project();
    config();
    run(["release", "start", "1"]);
    out.length = 0;
    const path = file(`epic: 1
stories:
  - story: a story hung off the epic that was already there
    requirements:
      - statement: a rule
        criteria:
          - statement: a criteria
`);
    expect(run(["plan", path])).toBe(0);

    expect(count("epic")).toBe(1);
    expect(state("epic", 1)).toBe("in_progress");
    expect((db().prepare("SELECT epic_id AS e FROM story WHERE id = 1").get() as { e: number }).e).toBe(1);
    expect(state("story", 1)).toBe("in_progress");
  });

  it("a story root given as a number hangs new requirements off the story that is there", () => {
    project();
    config();
    run(["plan", file(GOOD)]);
    out.length = 0;

    const path = file(`story: 1
requirements:
  - statement: a rule that was thought of afterwards
    criteria:
      - statement: a criteria
`);
    expect(run(["plan", path])).toBe(0);
    expect(count("story")).toBe(1);
    expect(count("requirement")).toBe(2);
    expect((db().prepare("SELECT story_id AS s FROM requirement WHERE id = 2").get() as { s: number }).s).toBe(1);
    expect(state("requirement", 2)).toBe("in_progress");
  });

  it("--epic says which release a new epic belongs to", () => {
    project();
    config();
    run(["release", "create", "--parent", "1", "0.0.2"]);
    run(["epic", "create", "--parent", "2", "an epic in the later release"]);
    out.length = 0;

    const path = file(`epic: a sibling of that one
stories:
  - story: a story
    requirements:
      - statement: a rule
        criteria:
          - statement: a criteria
`);
    expect(run(["plan", path, "--epic", "2"])).toBe(0);
    expect((db().prepare("SELECT release_id AS r FROM epic WHERE id = 3").get() as { r: number }).r).toBe(2);
  });

  it("refuses a file with no root, before creating anything", () => {
    project();
    config();
    const path = file(`requirements:
  - statement: a rule
    criteria:
      - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("the first key names the root");
    expect(complained()).toContain("not requirements");
    expect(count("requirement")).toBe(0);
  });

  it("refuses a file with more than one root", () => {
    project();
    config();
    const path = file(`story: a story
release: 0.0.2
requirements:
  - statement: a rule
    criteria:
      - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("more than one root — story and release");
    expect(count("story")).toBe(0);
  });

  it("refuses a root whose parent cannot be found, naming it", () => {
    project();
    config();
    const path = file(`epic: an epic with nowhere to go
release: 9
stories:
  - story: a story
    requirements:
      - statement: a rule
        criteria:
          - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("no release #9");
    expect(count("epic")).toBe(1);
  });

  it("refuses a new epic when the project has no in-progress release", () => {
    project();
    config();
    const path = file(`epic: an epic with no release under way
stories:
  - story: a story
    requirements:
      - statement: a rule
        criteria:
          - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("has no in-progress release");
    expect(count("epic")).toBe(1);
  });

  it("refuses a root that is joined and given a parent too", () => {
    project();
    config();
    const path = file(`epic: 1
release: 1
stories:
  - story: a story
    requirements:
      - statement: a rule
        criteria:
          - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("epic #1 already exists, so release must not be given too");
    expect(count("story")).toBe(0);
  });

  it("refuses joining a row in another project", () => {
    project();
    config();
    run(["project", "create", "--parent", "1", "other", "--path", join(repo, "elsewhere")]);
    run(["release", "create", "--parent", "2", "0.0.1"]);
    out.length = 0;

    const path = file(`release: 2
epics:
  - epic: an epic in someone else's release
    stories:
      - story: a story
        requirements:
          - statement: a rule
            criteria:
              - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("release #2 belongs to project #2 other");
    expect(count("epic")).toBe(1);
  });

  it("refuses an id below the root, where only a sentence says what is being made", () => {
    project();
    config();
    run(["release", "start", "1"]);
    out.length = 0;
    const path = file(`epic: a new epic
stories:
  - story: 1
    requirements:
      - statement: a rule
        criteria:
          - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("only the root joins an existing row by id");
    expect(count("epic")).toBe(1);
  });

  it("refuses a release whose version the ledger will not take, and leaves nothing behind", () => {
    project();
    config();
    const path = file(`release: the one after this one
epics:
  - epic: an epic
    stories:
      - story: a story
        requirements:
          - statement: a rule
            criteria:
              - statement: a criteria
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("version must be major.minor.patch");
    expect(count("release")).toBe(1);
    expect(count("epic")).toBe(1);
    expect(count("story")).toBe(0);
  });

  it("--dry-run prints a release root's whole tree and creates nothing", () => {
    project();
    config();
    const path = file(`release: 0.0.2
epics:
  - epic: the next epic
    stories:
      - story: a story under it
        requirements:
          - statement: a rule
            criteria:
              - statement: a criteria
`);
    expect(run(["plan", path, "--dry-run"])).toBe(0);
    expect(said()).toContain("0.0.2   under project #1");
    expect(said()).toContain("the next epic");
    expect(said()).toContain("a story under it");
    expect(said()).toContain("nothing created");
    expect(count("release")).toBe(1);
  });

  it("is in the manual", () => {
    expect(run(["--help"])).toBe(0);
    expect(said()).toContain("wecode plan <file.yaml>");
  });
});
