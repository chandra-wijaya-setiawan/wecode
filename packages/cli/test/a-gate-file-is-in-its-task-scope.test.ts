import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

let err: string[];
let repo: string;

const PROJECT = `stack: node
test: pnpm test
typecheck: tsc -b
source: ["src/**"]
tests: ["test/**"]
`;

beforeEach(() => {
  repo = tmp("wecode-gate-file-");
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  err = [];
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
}

/** A file already in the tree: the gate is a file that is there, which is exactly what makes
 *  it invisible to the missing-path check. */
function existing(...paths: readonly string[]): void {
  for (const path of paths) {
    mkdirSync(join(repo, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(repo, path), "");
  }
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

/** One story, one criteria, one task, with the task's scope and test the two things under
 *  examination and everything else out of the way. */
const plan = (scope: string, test: string, criteriaTest = "pnpm test"): string =>
  `story: the board grades a task by a suite it can move
epic: 1
requirements:
  - statement: a task's gate is a file its own hands can write
    criteria:
      - statement: the plan refuses a gate the task may not edit
        test: ${criteriaTest}
        tasks:
          - title: write the refusal
            scope: ${scope}
            test: ${test}
            role: engineer
`;

describe("a gate file is in its task's scope", () => {
  it("refuses a task whose test names a test file the scope cannot write, naming the path", () => {
    project();
    existing("test/list.test.ts");
    expect(run(["plan", file(plan('["src/list.ts"]', "pnpm exec vitest run test/list.test.ts"))])).toBe(1);

    expect(complained()).toContain("test/list.test.ts is a gate this scope cannot write");
    // The whole file is judged before a row exists, so an ungradable task plans nothing at all.
    expect(count("story")).toBe(0);
    expect(count("task")).toBe(0);
  });

  it("says which task said it, and refuses the plan whole", () => {
    project();
    existing("test/list.test.ts");
    expect(run(["plan", file(plan('["src/**"]', "pnpm exec vitest run test/list.test.ts"))])).toBe(1);
    expect(complained()).toContain("requirement 1, criteria 1, task 1: test:");
  });

  it("refuses it under --dry-run too, so nothing can hide behind a preview", () => {
    project();
    existing("test/list.test.ts");
    const path = file(plan('["src/list.ts"]', "pnpm exec vitest run test/list.test.ts"));
    expect(run(["plan", path, "--dry-run"])).toBe(1);
    expect(complained()).toContain("is a gate this scope cannot write");
  });

  it("allows the same gate once the scope spells it", () => {
    project();
    existing("test/list.test.ts");
    const scope = '["src/list.ts", "test/list.test.ts"]';
    expect(run(["plan", file(plan(scope, "pnpm exec vitest run test/list.test.ts"))])).toBe(0);
    expect(count("task")).toBe(1);
    expect(complained()).toBe("");
  });

  it("allows a gate a wildcard in the scope reaches", () => {
    project();
    existing("test/list.test.ts");
    expect(run(["plan", file(plan('["src/**", "test/**"]', "pnpm exec vitest run test/list.test.ts"))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("takes a test file that is not there yet, which is the missing-path rule's to answer for", () => {
    project();
    expect(run(["plan", file(plan('["src/list.ts"]', "pnpm exec vitest run test/list.test.ts"))])).toBe(1);
    const why = complained();
    expect(why).toContain("no file matches test/list.test.ts");
    // One path, one complaint: a file that is not there is not also a gate out of reach.
    expect(why).not.toContain("is a gate this scope cannot write");
  });

  it("says nothing about a source file the command names, which is not a gate", () => {
    project();
    existing("src/list.ts", "vitest.config.ts");
    expect(run(["plan", file(plan('["src/list.ts"]', "pnpm exec vitest run --config vitest.config.ts"))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("says nothing about a directory the command narrows to, which is not a file", () => {
    project();
    existing("test/list.test.ts");
    expect(run(["plan", file(plan('["src/list.ts"]', "pnpm exec vitest run test"))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("leaves the criteria's test alone: a criteria has no scope of its own to judge it by", () => {
    project();
    existing("test/list.test.ts");
    const body = plan('["src/list.ts"]', "pnpm test", "pnpm exec vitest run test/list.test.ts");
    expect(run(["plan", file(body)])).toBe(0);
    expect(count("acceptance_test")).toBe(1);
  });

  it("leaves project.yaml's fallback test alone — a path there is that file's to answer for", () => {
    project();
    existing("test/all.test.ts");
    writeFileSync(join(repo, "config", "project.yaml"), PROJECT.replace("pnpm test", "pnpm exec vitest run test/all.test.ts"));
    const body = `story: a story that leans on the project
epic: 1
requirements:
  - statement: a rule
    criteria:
      - statement: a criteria
        tasks:
          - title: do the work
            scope: ["src/list.ts"]
            role: engineer
`;
    expect(run(["plan", file(body)])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("names every gate out of reach at once, the way the rest of the file's errors are reported", () => {
    project();
    existing("test/a.test.ts", "test/b.spec.ts");
    const test = "pnpm exec vitest run test/a.test.ts test/b.spec.ts";
    expect(run(["plan", file(plan('["src/list.ts"]', test))])).toBe(1);
    const why = complained();
    expect(why).toContain("test/a.test.ts is a gate");
    expect(why).toContain("test/b.spec.ts is a gate");
  });
});
