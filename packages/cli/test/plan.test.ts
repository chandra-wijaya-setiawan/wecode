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

  it("is in the manual", () => {
    expect(run(["--help"])).toBe(0);
    expect(said()).toContain("wecode plan <file.yaml>");
  });
});
