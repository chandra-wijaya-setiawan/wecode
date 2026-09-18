import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

let out: string[];
let err: string[];
let repo: string;

const PROJECT = `stack: pnpm
test: pnpm exec vitest run
typecheck: tsc -b
source: ["packages/*/src/**"]
tests: ["packages/*/test/**"]
`;

const ROLES = `invariants:
  never_touch: [".github/**"]
  never_run: ["rm -rf /*"]

roles:
  engineer:
    worker_kind: agent
    scope:
      write: ["packages/**"]
      tools: ["bash", "read", "edit", "write"]
`;

beforeEach(() => {
  repo = tmp("wecode-gate-scope-");
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
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  writeFileSync(join(repo, "config", "roles.yaml"), ROLES);
  out.length = 0;
}

/** A pnpm workspace of two packages, which is the only thing that makes a package a package:
 *  the plan command reads the globs from the workspace file rather than assuming a layout. */
function workspace(globs: string = 'packages:\n  - "packages/*"\n'): void {
  writeFileSync(join(repo, "pnpm-workspace.yaml"), globs);
  for (const [dir, name] of [
    ["cli", "@wecode/cli"],
    ["core", "@wecode/core"],
  ]) {
    mkdirSync(join(repo, "packages", dir as string, "test"), { recursive: true });
    writeFileSync(join(repo, "packages", dir as string, "package.json"), JSON.stringify({ name }));
    writeFileSync(join(repo, "packages", dir as string, "test", "board.test.ts"), "");
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

/** One story, one criteria, one task — with the task's scope and test the two things under
 *  examination and everything else out of the way. */
function plan(scope: string, test: string): string {
  return file(`story: the board says what it cannot do
epic: 1

requirements:
  - statement: a gate is proven by a suite its own hands can move
    criteria:
      - statement: the board refuses a plan it cannot grade
        test: pnpm exec vitest run
        tasks:
          - title: write the refusal
            scope: [${scope}]
            test: ${test}
            role: engineer
`);
}

describe("a gate stays inside the scope", () => {
  it("refuses a task whose test filters to a package the scope cannot reach", () => {
    project();
    workspace();
    expect(run(["plan", plan('"packages/cli/src/**"', "pnpm --filter @wecode/core test")])).toBe(1);
    expect(complained()).toContain("runs packages/core, which this scope cannot reach");

    // Refused whole: a plan that cannot be graded creates nothing to grade.
    expect(count("story")).toBe(0);
    expect(count("task")).toBe(0);
  });

  it("refuses it when the package is named by path rather than by filter", () => {
    project();
    workspace();
    const path = plan('"packages/cli/src/**"', "pnpm exec vitest run packages/core/test/board.test.ts");
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("runs packages/core, which this scope cannot reach");
    expect(count("story")).toBe(0);
  });

  it("names the package the test runs, not the one the scope holds", () => {
    project();
    workspace();
    run(["plan", plan('"packages/cli/src/**"', "pnpm --filter=@wecode/core test")]);
    expect(complained()).toContain("packages/core");
    expect(complained()).not.toContain("runs packages/cli");
  });

  it("allows a test that runs the package the scope writes", () => {
    project();
    workspace();
    expect(run(["plan", plan('"packages/cli/src/**"', "pnpm --filter @wecode/cli test")])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("allows a scope whose wildcard covers every package", () => {
    project();
    workspace();
    expect(run(["plan", plan('"packages/*/src/**"', "pnpm exec vitest run packages/core")])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("allows a command that narrows to no package at all", () => {
    project();
    workspace();
    expect(run(["plan", plan('"packages/cli/src/**"', "pnpm exec vitest run")])).toBe(0);
    expect(count("task")).toBe(1);
  });

  it("judges the test the project falls back to, not only the one the file spells", () => {
    project();
    workspace();
    writeFileSync(join(repo, "config", "project.yaml"), PROJECT.replace("pnpm exec vitest run", "pnpm --filter @wecode/core test"));
    const path = file(`story: a story that leans on the project
epic: 1

requirements:
  - statement: a rule
    criteria:
      - statement: a criteria
        tasks:
          - title: do the work
            scope: ["packages/cli/src/**"]
            role: engineer
`);
    expect(run(["plan", path])).toBe(1);
    expect(complained()).toContain("runs packages/core, which this scope cannot reach");
  });

  it("has nothing to refuse in a tree that declares no workspace", () => {
    project();
    expect(run(["plan", plan('"packages/cli/src/**"', "pnpm --filter @wecode/core test")])).toBe(0);
    expect(count("task")).toBe(1);
  });
});
