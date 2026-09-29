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

const CRITERIA = "the list renders every row";

beforeEach(() => {
  repo = tmp("wecode-gate-needs-");
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

function wrote(path: string, body: string): void {
  mkdirSync(join(repo, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
  writeFileSync(join(repo, path), body);
}

/** A gate carrying the criteria statement, importing whatever it is handed. */
const gate = (imports: readonly string[]): string =>
  `${imports.map((i) => `import { thing } from "${i}";`).join("\n")}\nimport { describe, expect, it } from "vitest";\n\ndescribe("the list", () => {\n  it("${CRITERIA}", () => expect(thing).toBe(2));\n});\n`;

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

const plan = (scope: string, test = GATE): string =>
  `story: a task is graded by a gate it can turn green
epic: 1
requirements:
  - statement: a gate names no path another story owns
    criteria:
      - statement: ${CRITERIA}
        test: ${test}
        tasks:
          - title: render the rows
            scope: ${scope}
            test: ${test}
            role: engineer
`;

const GATE = "pnpm exec vitest run test/list.test.ts";
const REFUSED = "test/list.test.ts needs src/list.ts, which no task under this story writes";

describe("a gate cannot need another story's output", () => {
  it("refuses a gate importing a module that is not there and that no task here writes", () => {
    project();
    wrote("test/list.test.ts", gate(["../src/list.js"]));
    expect(run(["plan", file(plan('["src/rows.ts"]'))])).toBe(1);
    expect(complained()).toContain(REFUSED);
    expect(count("task")).toBe(0);
  });

  it("takes it when a task under the story writes that module", () => {
    project();
    wrote("test/list.test.ts", gate(["../src/list.js"]));
    expect(run(["plan", file(plan('["src/list.ts"]'))])).toBe(0);
    expect(complained()).toBe("");
    expect(count("task")).toBe(1);
  });

  it("takes it when a scope glob covers that module", () => {
    project();
    wrote("test/list.test.ts", gate(["../src/list.js"]));
    expect(run(["plan", file(plan('["src/**"]'))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("takes it when the module is already on disk, whoever wrote it", () => {
    project();
    wrote("src/list.ts", "export const thing = 2;\n");
    wrote("test/list.test.ts", gate(["../src/list.js"]));
    expect(run(["plan", file(plan('["src/rows.ts"]'))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("says nothing of a bare package import, which is no story's path", () => {
    project();
    wrote("test/list.test.ts", gate(["@wecode/core"]));
    expect(run(["plan", file(plan('["src/rows.ts"]'))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("names every unwritten path the gate needs, not just the first", () => {
    project();
    wrote("test/list.test.ts", gate(["../src/list.js", "../src/rows.js"]));
    expect(run(["plan", file(plan('["src/other.ts"]'))])).toBe(1);
    const why = complained();
    expect(why).toContain("needs src/list.ts");
    expect(why).toContain("needs src/rows.ts");
  });

  it("refuses it under --dry-run too, so a preview hides nothing", () => {
    project();
    wrote("test/list.test.ts", gate(["../src/list.js"]));
    expect(run(["plan", file(plan('["src/rows.ts"]')), "--dry-run"])).toBe(1);
    expect(complained()).toContain(REFUSED);
  });

  it("leaves a gate that is not on disk to the missing-path rule", () => {
    project();
    expect(run(["plan", file(plan('["src/rows.ts", "test/list.test.ts"]'))])).toBe(0);
    expect(complained()).toBe("");
  });

  it("takes an import of a directory that has an index", () => {
    project();
    wrote("src/list/index.ts", "export const thing = 2;\n");
    wrote("test/list.test.ts", gate(["../src/list/index.js"]));
    expect(run(["plan", file(plan('["src/rows.ts"]'))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("judges a tsx module the same way", () => {
    project();
    wrote("src/list.tsx", "export const thing = 2;\n");
    wrote("test/list.test.ts", gate(["../src/list.js"]));
    expect(run(["plan", file(plan('["src/rows.ts"]'))])).toBe(0);
    expect(count("task")).toBe(1);
  });
});
