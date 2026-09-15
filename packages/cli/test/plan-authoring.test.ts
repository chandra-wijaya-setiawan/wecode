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
source: ["packages/cli/src/**"]
tests: ["packages/cli/test/**"]
`;

/** Both roles, so the authoring task has a role to take its scope from. */
const ROLES = `invariants:
  never_touch: [".github/**"]
  never_run: ["rm -rf /*"]

roles:
  engineer:
    worker_kind: agent
    scope:
      write: ["packages/*/src/**", "packages/*/test/**"]
      tools: ["bash", "read", "edit", "write"]

  acceptance-tester:
    worker_kind: agent
    scope:
      write: ["packages/*/test/**", "tests/acceptance/**"]
      tools: ["bash", "read", "edit"]
`;

beforeEach(() => {
  repo = tmp("wecode-plan-authoring-");
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
  out.length = 0;
}

function config(): void {
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  writeFileSync(join(repo, "config", "roles.yaml"), ROLES);
}

function file(body: string): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(path, body);
  return path;
}

function db() {
  return open(process.env["WECODE_DB"] as string);
}

function tasks(): { id: number; title: string; role: string; scope: string }[] {
  return db().prepare("SELECT id, title, role, scope FROM task ORDER BY id").all() as unknown as {
    id: number;
    title: string;
    role: string;
    scope: string;
  }[];
}

const STATEMENT = "one function renders rows, columns, a height and a cursor";

const WITHOUT_TEST = `story: the cockpit is one reusable list at three sizes
epic: 1
requirements:
  - statement: a box and a box page are one list function
    criteria:
      - statement: ${STATEMENT}
        tasks:
          - title: write packages/tui/src/list.ts as the contract specifies
            scope: ["packages/cli/src/list.ts"]
            role: engineer
`;

const WITH_TEST = WITHOUT_TEST.replace(
  `    criteria:\n      - statement: ${STATEMENT}\n`,
  `    criteria:\n      - statement: ${STATEMENT}\n        test: pnpm exec vitest run packages/tui\n`,
);

describe("a criteria with no test of its own", () => {
  it("creates an authoring task under the acceptance-tester role", () => {
    project();
    config();
    expect(run(["plan", file(WITHOUT_TEST)])).toBe(0);

    const rows = tasks();
    expect(rows).toHaveLength(2);

    const authoring = rows.filter((t) => t.role === "acceptance-tester");
    expect(authoring).toHaveLength(1);

    // The engineer task the file asked for is untouched, and is still the engineer's.
    expect(rows.filter((t) => t.role === "engineer").map((t) => t.title)).toEqual([
      "write packages/tui/src/list.ts as the contract specifies",
    ]);
  });

  it("titles the authoring task so the criteria statement is the whole brief, and a failing test the proof", () => {
    project();
    config();
    expect(run(["plan", file(WITHOUT_TEST)])).toBe(0);

    const title = tasks().find((t) => t.role === "acceptance-tester")?.title ?? "";
    // The statement is carried verbatim: it is all the agent has to write the test from.
    expect(title).toContain(STATEMENT);
    expect(title).toContain("fails");
  });

  it("takes its scope from the acceptance-tester role, not the engineer's", () => {
    project();
    config();
    expect(run(["plan", file(WITHOUT_TEST)])).toBe(0);

    const authoring = tasks().find((t) => t.role === "acceptance-tester");
    const scope = JSON.parse(authoring?.scope ?? "{}") as { write: string[]; tools: string[] };
    expect(scope.write).toEqual(["packages/*/test/**", "tests/acceptance/**"]);
    expect(scope.tools).toEqual(["bash", "read", "edit"]);

    // The engineer's own scope is the wider one, and did not leak into the authoring task.
    expect(scope.write).not.toContain("packages/*/src/**");
  });

  it("starts the authoring task with the rest of what the file created", () => {
    project();
    config();
    expect(run(["plan", file(WITHOUT_TEST)])).toBe(0);

    const authoring = tasks().find((t) => t.role === "acceptance-tester");
    const row = db().prepare("SELECT state FROM task WHERE id = ?").get(authoring?.id ?? 0) as { state: string };
    expect(row.state).toBe("ready");
  });
});

describe("a criteria that names its own test", () => {
  it("creates only the tasks the file listed, exactly as it does today", () => {
    project();
    config();
    expect(run(["plan", file(WITH_TEST)])).toBe(0);

    const rows = tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("engineer");
    expect(rows.some((t) => t.role === "acceptance-tester")).toBe(false);

    const artefact = db().prepare("SELECT artefact FROM acceptance_test WHERE id = 1").get() as { artefact: string };
    expect(artefact.artefact).toBe("pnpm exec vitest run packages/tui");
  });
});
