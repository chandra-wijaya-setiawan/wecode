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
  repo = tmp("wecode-plan-dup-");
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

function file(body: string, name = "plan.yaml"): string {
  const path = join(repo, name);
  writeFileSync(path, body);
  return path;
}

const complained = (): string => err.join("");

function count(table: string): number {
  const db = open(process.env["WECODE_DB"] as string);
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const STORY = "the cockpit is one reusable list";
const CRITERIA = "one function renders rows, columns, a height and a cursor";

const plan = (story: string, criteria: string): string => `story: ${story}
epic: 1

requirements:
  - statement: a box and a box page are one list function
    criteria:
      - statement: ${criteria}
        test: pnpm exec vitest run packages/tui
        tasks:
          - title: write the list so that ${story}
            scope: ["src/list.ts", "test/list.test.ts"]
            test: pnpm exec vitest run test/list.test.ts
`;

describe("wecode plan refuses a sentence this project has already said", () => {
  it("names the story id a repeated story title duplicates, and creates nothing", () => {
    project();
    expect(run(["plan", file(plan(STORY, CRITERIA))])).toBe(0);
    err.length = 0;

    expect(run(["plan", file(plan(STORY, "a different criteria entirely"), "again.yaml")])).toBe(1);
    expect(complained()).toContain(`story #1 already says ${STORY}`);
    expect(count("story")).toBe(1);
    expect(count("acceptance_criteria")).toBe(1);
  });

  it("names the criteria id a repeated criteria statement duplicates", () => {
    project();
    expect(run(["plan", file(plan(STORY, CRITERIA))])).toBe(0);
    err.length = 0;

    expect(run(["plan", file(plan("a wholly different story", CRITERIA), "again.yaml")])).toBe(1);
    expect(complained()).toContain(`criteria #1 already says ${CRITERIA}`);
    expect(count("story")).toBe(1);
  });

  it("names both, in one refusal, when the whole file is a repeat", () => {
    project();
    expect(run(["plan", file(plan(STORY, CRITERIA))])).toBe(0);
    err.length = 0;

    expect(run(["plan", file(plan(STORY, CRITERIA), "again.yaml")])).toBe(1);
    expect(complained()).toContain(`story #1 already says ${STORY}`);
    expect(complained()).toContain(`criteria #1 already says ${CRITERIA}`);
  });

  it("lets a story whose sentences are all new through", () => {
    project();
    expect(run(["plan", file(plan(STORY, CRITERIA))])).toBe(0);
    err.length = 0;

    expect(run(["plan", file(plan("the board wakes on a keypress", "the keypress redraws one row"), "again.yaml")])).toBe(
      0,
    );
    expect(complained()).toBe("");
    expect(count("story")).toBe(2);
  });

  it("refuses a repeat inside an epic the file is making, not only at the root", () => {
    project();
    expect(run(["plan", file(plan(STORY, CRITERIA))])).toBe(0);
    err.length = 0;

    const nested = `epic: a second cockpit
release: 1

stories:
  - story: ${STORY}
    requirements:
      - statement: a box and a box page are one list function
        criteria:
          - statement: something new under the sun
            test: pnpm test
            tasks:
              - title: write it
                scope: ["src/list.ts"]
`;
    expect(run(["plan", file(nested, "nested.yaml")])).toBe(1);
    expect(complained()).toContain(`story #1 already says ${STORY}`);
    expect(count("epic")).toBe(1);
  });

  it("says nothing about a root joined by id, which carries no sentence of its own", () => {
    project();
    expect(run(["plan", file(plan(STORY, CRITERIA))])).toBe(0);
    err.length = 0;

    const joined = `story: 1

requirements:
  - statement: a second requirement on the same story
    criteria:
      - statement: a criteria nobody has said yet
        test: pnpm test
        tasks:
          - title: write it
            scope: ["src/list.ts"]
`;
    expect(run(["plan", file(joined, "joined.yaml")])).toBe(0);
    expect(complained()).toBe("");
    expect(count("story")).toBe(1);
    expect(count("requirement")).toBe(2);
  });
});
