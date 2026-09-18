import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

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
  repo = tmp("wecode-plan-artefact-");
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

function project(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "0.0.1"]);
  run(["epic", "create", "--parent", "1", "the cockpit"]);
  run(["epic", "start", "1"]);
  out.length = 0;
}

function file(body: string): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(path, body);
  return path;
}

const complained = (): string => err.join("");

function count(table: string): number {
  return (
    open(process.env["WECODE_DB"] as string).prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

/** One story, one criteria, one task — with the two test commands as parameters, because
 *  the two artefacts a plan file carries are judged by the same rule. */
const plan = (criteriaTest: string, taskTest: string, scope = '["src/list.ts"]'): string =>
  `story: the cockpit is one reusable list
epic: 1
requirements:
  - statement: a box and a box page are one list function
    criteria:
      - statement: one function renders rows, columns and a cursor
        test: ${criteriaTest}
        tasks:
          - title: write the list
            scope: ${scope}
            test: ${taskTest}
            role: engineer
`;

describe("a plan's artefact must match a test file", () => {
  it("refuses a task's test that names a file nobody has and nobody will write, naming the path", () => {
    project();
    expect(run(["plan", file(plan("pnpm test", "pnpm exec vitest run test/maler.test.ts"))])).toBe(1);

    expect(complained()).toContain("no file matches test/maler.test.ts");
    // The whole file is judged before a row exists, so a typo plans nothing at all.
    expect(count("story")).toBe(0);
    expect(count("task_test")).toBe(0);
  });

  it("refuses a criteria's test the same way, and says which criteria said it", () => {
    project();
    expect(run(["plan", file(plan("pnpm exec vitest run test/mial.test.ts", "pnpm test"))])).toBe(1);

    const why = complained();
    expect(why).toContain("no file matches test/mial.test.ts");
    expect(why).toContain("requirement 1, criteria 1: test:");
  });

  it("takes a file that is already in the repository", () => {
    project();
    mkdirSync(join(repo, "test"));
    writeFileSync(join(repo, "test", "list.test.ts"), "");
    expect(run(["plan", file(plan("pnpm exec vitest run test/list.test.ts", "pnpm test"))])).toBe(0);
    expect(count("acceptance_test")).toBe(1);
  });

  it("takes a file some task under it is scoped to write, because that is the story", () => {
    project();
    const scope = '["src/list.ts", "test/list.test.ts"]';
    const runs = "pnpm exec vitest run test/list.test.ts";
    // Neither file exists yet: writing them is what the plan is for.
    expect(run(["plan", file(plan(runs, runs, scope))])).toBe(0);
    expect(count("task_test")).toBe(1);
  });

  it("judges a path against the task's own scope, not another task's", () => {
    project();
    expect(run(["plan", file(plan("pnpm test", "pnpm exec vitest run test/list.test.ts", '["src/**"]'))])).toBe(1);
    expect(complained()).toContain("no file matches test/list.test.ts");
  });

  it("says nothing about a word that is not a file: a directory filter, or a bare command", () => {
    project();
    expect(run(["plan", file(plan("pnpm exec vitest run packages/tui", "pnpm test -- --reporter dot"))])).toBe(0);
    expect(complained()).toBe("");
  });

  it("leaves project.yaml's fallback test alone — a path there is that file's to answer for", () => {
    project();
    const fallback = PROJECT.replace("pnpm test", "pnpm exec vitest run test/all.test.ts");
    writeFileSync(join(repo, "config", "project.yaml"), fallback);
    const body = `story: the cockpit is one reusable list
epic: 1
requirements:
  - statement: a box and a box page are one list function
    criteria:
      - statement: one function renders rows, columns and a cursor
        tasks:
          - title: write the list
            scope: ["src/list.ts"]
            role: engineer
`;
    expect(run(["plan", file(body)])).toBe(0);
  });

  it("names every bad path at once, the way the rest of the file's errors are reported", () => {
    project();
    expect(run(["plan", file(plan("pnpm exec vitest run test/a.test.ts", "pnpm exec vitest run test/b.test.ts"))])).toBe(
      1,
    );
    const why = complained();
    expect(why).toContain("test/a.test.ts");
    expect(why).toContain("test/b.test.ts");
  });

  it("refuses the same file it would otherwise have created, so --dry-run cannot hide it", () => {
    project();
    expect(run(["plan", file(plan("pnpm test", "pnpm exec vitest run test/maler.test.ts")), "--dry-run"])).toBe(1);
    expect(complained()).toContain("no file matches test/maler.test.ts");
  });
});
