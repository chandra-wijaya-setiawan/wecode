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

/** The criteria the plan below hangs its task off. It is the statement the gate has to carry:
 *  a test file already asserting it is red at base and wants no edit from this task. */
const CRITERIA = "the plan refuses a gate the task may not edit";

beforeEach(() => {
  repo = tmp("wecode-gate-written-");
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  err = [];
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
}

/** A file in the tree with a body of its own: what the body says is the whole question here. */
function wrote(path: string, body: string): void {
  mkdirSync(join(repo, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
  writeFileSync(join(repo, path), body);
}

/** A suite that already asserts the criteria — the gate an agent finds red at base. */
const asserts = (statement: string): string =>
  `import { describe, expect, it } from "vitest";\n\ndescribe("the list", () => {\n  it("${statement}", () => expect(1).toBe(2));\n});\n`;

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

const plan = (scope: string, test: string, criteria = CRITERIA): string =>
  `story: the board grades a task by a suite it can move
epic: 1
requirements:
  - statement: a task's gate is a file its own hands can write
    criteria:
      - statement: ${criteria}
        test: pnpm test
        tasks:
          - title: write the refusal
            scope: ${scope}
            test: ${test}
            role: engineer
`;

const GATE = "pnpm exec vitest run test/list.test.ts";
const REFUSED = "test/list.test.ts is a gate this scope cannot write";

describe("a gate file outside scope is refused only when it must be written", () => {
  it("takes a gate outside the scope that already carries the criteria statement", () => {
    project();
    wrote("test/list.test.ts", asserts(CRITERIA));
    expect(run(["plan", file(plan('["src/list.ts"]', GATE))])).toBe(0);
    expect(count("task")).toBe(1);
    expect(complained()).toBe("");
  });

  it("refuses a gate outside the scope that does not carry it yet, because the task must write it", () => {
    project();
    wrote("test/list.test.ts", asserts("the list renders"));
    expect(run(["plan", file(plan('["src/list.ts"]', GATE))])).toBe(1);
    expect(complained()).toContain(REFUSED);
    expect(count("task")).toBe(0);
  });

  it("refuses an empty gate file, which carries no statement at all", () => {
    project();
    wrote("test/list.test.ts", "");
    expect(run(["plan", file(plan('["src/list.ts"]', GATE))])).toBe(1);
    expect(complained()).toContain(REFUSED);
  });

  it("still refuses a gate that is not there, which is the missing-path rule's to answer for", () => {
    project();
    expect(run(["plan", file(plan('["src/list.ts"]', GATE))])).toBe(1);
    const why = complained();
    expect(why).toContain("no file matches test/list.test.ts");
    expect(why).not.toContain(REFUSED);
  });

  it("refuses it under --dry-run too, so a preview hides nothing", () => {
    project();
    wrote("test/list.test.ts", asserts("the list renders"));
    expect(run(["plan", file(plan('["src/list.ts"]', GATE)), "--dry-run"])).toBe(1);
    expect(complained()).toContain(REFUSED);
  });

  it("takes a carried gate under --dry-run as well", () => {
    project();
    wrote("test/list.test.ts", asserts(CRITERIA));
    expect(run(["plan", file(plan('["src/list.ts"]', GATE)), "--dry-run"])).toBe(0);
    expect(complained()).toBe("");
  });

  it("judges each gate the command names on its own body", () => {
    project();
    wrote("test/a.test.ts", asserts(CRITERIA));
    wrote("test/b.test.ts", asserts("something else"));
    const test = "pnpm exec vitest run test/a.test.ts test/b.test.ts";
    expect(run(["plan", file(plan('["src/list.ts"]', test))])).toBe(1);
    const why = complained();
    expect(why).not.toContain("test/a.test.ts is a gate");
    expect(why).toContain("test/b.test.ts is a gate");
  });

  it("says nothing of a gate the scope spells, whatever its body says", () => {
    project();
    wrote("test/list.test.ts", asserts("the list renders"));
    expect(run(["plan", file(plan('["src/list.ts", "test/list.test.ts"]', GATE))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("matches the statement as the criteria spells it, not a paraphrase of it", () => {
    project();
    wrote("test/list.test.ts", asserts("the plan refuses gates the task may not edit"));
    expect(run(["plan", file(plan('["src/list.ts"]', GATE))])).toBe(1);
    expect(complained()).toContain(REFUSED);
  });

  it("leaves a source file the command names alone: it is not a gate for anyone to write", () => {
    project();
    wrote("src/list.ts", "export const list = [];\n");
    wrote("vitest.config.ts", "export default {};\n");
    const test = "pnpm exec vitest run --config vitest.config.ts";
    expect(run(["plan", file(plan('["src/list.ts"]', test))])).toBe(0);
    expect(count("task")).toBe(1);
  });
});
