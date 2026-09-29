import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { plan as planCommand } from "../src/plan.js";
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

const OWNERS = "packages/core/config/components.yaml";

beforeEach(() => {
  repo = tmp("wecode-module-owner-");
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

/** A tree that says who owns what, plus one module already on disk. The map's contents are
 *  the core's business; all this rule reads is whether a task may write the file. */
function owned(): void {
  mkdirSync(join(repo, "packages", "core", "config"), { recursive: true });
  writeFileSync(join(repo, OWNERS), "components:\n  view-index:\n    modules: [ports]\n");
  mkdirSync(join(repo, "packages", "lens", "src"), { recursive: true });
  writeFileSync(join(repo, "packages", "lens", "src", "ports.ts"), "export {};\n");
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

/** One story, one criteria, and the tasks under examination — nothing else in the way. */
function plan(...tasks: readonly { title: string; scope: string }[]): string {
  const rows = tasks
    .map(
      (t) => `          - title: ${t.title}
            scope: [${t.scope}]
            test: pnpm exec vitest run
            role: engineer
`,
    )
    .join("");
  return file(`story: the wireframe is drawn from the tree
epic: 1

requirements:
  - statement: a module the tree does not claim is a module nobody owns
    criteria:
      - statement: every new module is claimed where the map is kept
        test: pnpm exec vitest run
        tasks:
${rows}`);
}

describe("a new module brings its owner", () => {
  it("refuses a story that adds a module no task here may claim", () => {
    project();
    owned();
    expect(run(["plan", plan({ title: "write the wireframe", scope: '"packages/lens/src/wireframe.ts"' })])).toBe(1);
    expect(complained()).toContain("adds packages/lens/src/wireframe.ts");
    expect(complained()).toContain(`no task here may write ${OWNERS}`);

    // Refused whole: a story that cannot claim its own module creates nothing.
    expect(count("story")).toBe(0);
    expect(count("task")).toBe(0);
  });

  it("allows it once some task under the story may write the map", () => {
    project();
    owned();
    const path = plan(
      { title: "write the wireframe", scope: '"packages/lens/src/wireframe.ts"' },
      { title: "claim it", scope: `"${OWNERS}"` },
    );
    expect(run(["plan", path])).toBe(0);
    expect(complained()).toBe("");
    expect(count("story")).toBe(1);
  });

  it("takes the claim from the same task when that is where it sits", () => {
    project();
    owned();
    const scope = `"packages/lens/src/wireframe.ts", "${OWNERS}"`;
    expect(run(["plan", plan({ title: "write the wireframe and claim it", scope })])).toBe(0);
    expect(count("story")).toBe(1);
  });

  it("accepts a glob over the map, which is a scope that can still write it", () => {
    project();
    owned();
    const scope = '"packages/lens/src/wireframe.ts", "packages/core/config/*.yaml"';
    expect(run(["plan", plan({ title: "write the wireframe", scope })])).toBe(0);
    expect(count("story")).toBe(1);
  });

  it("says nothing about a module that is already there, which is an edit", () => {
    project();
    owned();
    expect(run(["plan", plan({ title: "rewrite the ports", scope: '"packages/lens/src/ports.ts"' })])).toBe(0);
    expect(complained()).toBe("");
    expect(count("story")).toBe(1);
  });

  it("judges only a path spelled out, because a glob states a shape and not a module", () => {
    project();
    owned();
    expect(run(["plan", plan({ title: "work on the lens", scope: '"packages/lens/src/**"' })])).toBe(0);
    expect(complained()).toBe("");
  });

  it("leaves a scope outside packages/*/src alone", () => {
    project();
    owned();
    const scope = '"packages/lens/test/wireframe.test.ts", "packages/lens/README.md"';
    expect(run(["plan", plan({ title: "write the test", scope })])).toBe(0);
    expect(complained()).toBe("");
  });

  it("claims nothing in a tree that keeps no map", () => {
    project();
    owned();
    rmSync(join(repo, OWNERS));
    expect(run(["plan", plan({ title: "write the wireframe", scope: '"packages/lens/src/wireframe.ts"' })])).toBe(0);
    expect(complained()).toBe("");
    expect(count("story")).toBe(1);
  });

  it("names the rule in the help, so a person reads it before a plan is refused", () => {
    expect(planCommand(["--help"])).toBe(0);
    expect(out.join("")).toContain(`${OWNERS} in some task's scope`);
  });
});
