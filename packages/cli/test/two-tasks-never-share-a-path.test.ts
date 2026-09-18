import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

// Two tasks under one story run at the same time. If both may write a path, whichever lands
// second loses the other's work or fails to apply, and no test says which — so the plan is
// refused before either agent is dispatched.

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
  repo = tmp("wecode-share-");
  mkdirSync(join(repo, "config"));
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
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  out.length = 0;
}

function file(body: string): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(path, body);
  return path;
}

const complained = (): string => err.join("");

function count(table: string): number {
  return (open(process.env["WECODE_DB"] as string).prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
    .n;
}

/** One story, one requirement, one criteria, two tasks with the scopes given. */
function plan(first: string, second: string, criteria = 1): string {
  const task = (title: string, scope: string): string => `          - title: ${title}
            scope: ${scope}
            test: pnpm exec vitest run test
`;
  const head = `story: the cockpit is one reusable list
epic: 1

requirements:
  - statement: a box and a box page are one list function
    criteria:
      - statement: one function renders rows and columns
        test: pnpm exec vitest run test
        tasks:
`;
  if (criteria === 1) return `${head}${task("write the list", first)}${task("wire the page", second)}`;
  return `${head}${task("write the list", first)}      - statement: the cursor moves by row
        test: pnpm exec vitest run test
        tasks:
${task("wire the page", second)}`;
}

describe("two tasks under one story never share a scope path", () => {
  it("refuses two tasks whose scopes name the same path, and creates nothing", () => {
    project();
    expect(run(["plan", file(plan(`["src/list.ts", "test/list.test.ts"]`, `["src/list.ts"]`))])).toBe(1);

    expect(complained()).toContain("write the list");
    expect(complained()).toContain("wire the page");
    expect(complained()).toContain("both write src/list.ts");
    expect(complained()).toContain("two tasks under one story share no path");

    // Refused whole: the story is checked before any of it is written.
    expect(count("story")).toBe(0);
    expect(count("task")).toBe(0);
  });

  it("refuses a glob that reaches inside another task's path", () => {
    project();
    expect(run(["plan", file(plan(`["src/**"]`, `["src/list.ts"]`))])).toBe(1);
    expect(complained()).toContain("both write src/** and src/list.ts");
    expect(count("story")).toBe(0);
  });

  it("refuses across criteria, because it is the story whose tasks run together", () => {
    project();
    expect(run(["plan", file(plan(`["src/list.ts"]`, `["src/*.ts"]`, 2))])).toBe(1);
    expect(complained()).toContain("both write src/list.ts and src/*.ts");
    expect(count("story")).toBe(0);
  });

  it("allows two tasks whose scopes are disjoint", () => {
    project();
    expect(run(["plan", file(plan(`["src/list.ts"]`, `["src/page.ts", "test/page.test.ts"]`))])).toBe(0);
    expect(complained()).toBe("");
    expect(count("task")).toBe(2);
  });

  it("allows one task per path when the directories differ at the first segment", () => {
    project();
    expect(run(["plan", file(plan(`["src/**"]`, `["test/**"]`))])).toBe(0);
    expect(count("task")).toBe(2);
  });

  it("says nothing about scopes the file did not spell, which all fall back to the same one", () => {
    project();
    const body = `story: the cockpit is one reusable list
epic: 1

requirements:
  - statement: a box and a box page are one list function
    criteria:
      - statement: one function renders rows and columns
        test: pnpm exec vitest run test
        tasks:
          - title: write the list
          - title: wire the page
`;
    expect(run(["plan", file(body)])).toBe(0);
    expect(count("task")).toBe(2);
  });
});
