/** A task is graded by one test it can turn green, so its gate names that test.
 *
 *  Of 1,382 lessons the record holds, 114 say the same thing in different words: a task was red,
 *  or green, for a reason its own scope could not reach — the whole suite, the repository-wide
 *  ceiling, a neighbour's file red at base. Each is a task whose gate named no file of its own,
 *  so it was graded on everything. The plan refuses that shape now, while the file is still being
 *  read, because a gate fixed in a plan costs a keystroke and a gate fixed after three attempts
 *  costs the attempts.
 *
 *  The rule is the task's and only the task's. A criteria may run a package: a criteria is about
 *  the whole of a behaviour, and its test is how the story is accepted. A task is one change.
 *
 *  And it is the gate a task *declares*. A task that declares none inherits `project.yaml`'s
 *  `test:` — in this repository `pnpm typecheck && pnpm exec vitest run`, the whole suite — and
 *  whether that fallback should be refused too is a decision the operator holds, not this file.
 *  The last case below pins today's answer so that changing it is a visible act. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { oneFile } from "../src/plan/refusals.js";
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
  repo = tmp("wecode-one-file-");
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

function file(body: string): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(path, body);
  return path;
}

const complained = (): string => err.join("");

const count = (table: string): number =>
  (open(process.env["WECODE_DB"] as string).prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** One story, one criteria, one task. `task` is the task's `test:` line, or null for a task that
 *  declares none and so inherits the project's. */
const plan = (task: string | null, criteria = "pnpm exec vitest run test/list.test.ts"): string =>
  `story: a task is graded by one test it can turn green
epic: 1
requirements:
  - statement: a task's gate names its own test
    criteria:
      - statement: the plan refuses a task gate that names no file
        test: ${criteria}
        tasks:
          - title: write the list and its test
            scope: ["src/list.ts", "test/list.test.ts"]
${task === null ? "" : `            test: ${task}\n`}            role: engineer
`;

describe("a task's gate names one file", () => {
  it("refuses a gate that names no file, and says what to do instead", () => {
    project();
    expect(run(["plan", file(plan("pnpm exec vitest run"))])).toBe(1);
    expect(complained()).toContain("`pnpm exec vitest run` names no file");
    expect(complained()).toContain("so name it");
    // Refused while the file is read: nothing was written, so nothing has to be undone.
    expect(count("story")).toBe(0);
  });

  it("refuses a gate that narrows to a package or a directory, which is still a suite", () => {
    project();
    for (const gate of ["pnpm exec vitest run packages/tui", "pnpm exec vitest run test", "pnpm test -- --reporter dot"]) {
      err.length = 0;
      expect(run(["plan", file(plan(gate))]), gate).toBe(1);
      expect(complained(), gate).toContain("names no file");
    }
  });

  it("accepts a gate that names the file the task writes", () => {
    project();
    expect(run(["plan", file(plan("pnpm exec vitest run test/list.test.ts"))])).toBe(0);
    expect(count("task")).toBe(1);
  });

  // Asked of the rule directly: one plan per runner would be one story sentence written twice,
  // which the plan refuses for a reason of its own.
  it("is the same rule for any runner: a path with a file at the end of it", () => {
    const judged = (gate: string): readonly string[] => {
      const say: string[] = [];
      oneFile(gate, "task 1", say);
      return say;
    };
    for (const gate of ["uv run pytest -q tests/test_list.py", "go test ./pkg/list_test.go", "cargo test --test tests/list.rs"])
      expect(judged(gate), gate).toEqual([]);
    for (const gate of ["uv run pytest -q", "go test ./...", "cargo test"])
      expect(judged(gate), gate).toEqual([`task 1: test: \`${gate}\` names no file — a task is graded by the one test it can turn green, so name it`]);
  });

  it("leaves a criteria's test alone: a criteria may run a package, a task may not", () => {
    project();
    expect(run(["plan", file(plan("pnpm exec vitest run test/list.test.ts", "pnpm exec vitest run packages/tui"))])).toBe(0);
    expect(complained()).not.toContain("names no file");
  });

  // Today's answer, pinned so that changing it is a visible act: a task that declares no gate
  // inherits project.yaml's `test:`, and that fallback is not judged by this rule. In this
  // repository the fallback is the whole suite, which is the very shape the rule refuses — so
  // whether to refuse it too is the operator's decision, raised as an approval, and this case is
  // the one that moves when it is answered.
  it("does not judge the fallback a task inherits when it declares no gate — yet", () => {
    project();
    expect(run(["plan", file(plan(null))])).toBe(0);
    expect(complained()).not.toContain("names no file");
  });
});
