import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Story 107: a plan file joined a story by id, its requirement, criteria and tasks all ran,
 *  and the story itself sat in planned — where delivered is unreachable, so the fix the plan
 *  described could never be delivered. What `begin` starts is every ancestor still planned. */

let repo: string;

const PROJECT = `stack: node
test: pnpm test
typecheck: tsc -b
source: ["src/**"]
tests: ["test/**"]
`;

const ROLES = `invariants:
  never_touch: [".github/**"]
  never_run: ["rm -rf /*"]

roles:
  engineer:
    worker_kind: agent
    scope:
      write: ["src/**", "test/**"]
      tools: ["bash", "read", "edit", "write"]
`;

beforeEach(() => {
  repo = tmp("wecode-plan-start-");
  mkdirSync(join(repo, "config"));
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  writeFileSync(join(repo, "config", "roles.yaml"), ROLES);
});

afterEach(() => vi.restoreAllMocks());

/** A project with one in-progress epic, and one story under it left in planned. */
function project(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "0.0.1"]);
  run(["epic", "create", "--parent", "1", "the cockpit"]);
  run(["epic", "start", "1"]);
  run(["story", "create", "--parent", "1", "the list is one function"]);
}

function db() {
  return open(process.env["WECODE_DB"] as string);
}

function state(table: string, id: number): string {
  return (db().prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;
}

/** How many times a verb was applied to a row, so "left alone" is a claim about the ledger
 *  and not only about the state a second start would have landed on anyway. */
function applied(entity: string, id: number, verb: string): number {
  return (
    db()
      .prepare("SELECT count(*) AS n FROM ledger WHERE entity = ? AND entity_id = ? AND verb = ?")
      .get(entity, id, verb) as { n: number }
  ).n;
}

/** A file that joins story #1 by id and hangs one requirement off it. */
function joining(): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(
    path,
    `story: 1

requirements:
  - statement: a box and a box page are one list function
    criteria:
      - statement: one function renders rows, columns, a height and a cursor
        test: pnpm exec vitest run packages/tui
        tasks:
          - title: write packages/tui/src/list.ts as the contract specifies
            scope: ["src/list.ts", "test/list.test.ts"]
            test: pnpm exec vitest run test/list.test.ts
            role: engineer
`,
  );
  return path;
}

describe("wecode plan starts every ancestor that is not underway", () => {
  it("leaves a joined story that was planned in_progress", () => {
    project();
    expect(state("story", 1)).toBe("planned");

    expect(run(["plan", joining()])).toBe(0);

    expect(state("story", 1)).toBe("in_progress");
    expect(applied("story", 1, "start")).toBe(1);
  });

  it("does not disturb a joined story that is already in_progress", () => {
    project();
    run(["story", "start", "1"]);
    expect(applied("story", 1, "start")).toBe(1);

    expect(run(["plan", joining()])).toBe(0);

    expect(state("story", 1)).toBe("in_progress");
    // One start, the operator's own. A row genuinely underway is not started again.
    expect(applied("story", 1, "start")).toBe(1);
  });

  it("leaves no ancestor of a created task in planned", () => {
    project();
    expect(run(["plan", joining()])).toBe(0);

    const task = db().prepare("SELECT id, acceptance_test_id FROM task ORDER BY id").all() as unknown as {
      id: number;
      acceptance_test_id: number;
    }[];
    expect(task.length).toBeGreaterThan(0);

    // Every rung from each task up to the root, read off the ledger's own foreign keys
    // rather than assumed ids, so a task created under a second criteria is checked too.
    for (const t of task) {
      const criteria = (
        db().prepare("SELECT parent_id AS id FROM acceptance_test WHERE id = ?").get(t.acceptance_test_id) as {
          id: number;
        }
      ).id;
      const requirement = (
        db().prepare("SELECT requirement_id AS id FROM acceptance_criteria WHERE id = ?").get(criteria) as {
          id: number;
        }
      ).id;
      const story = (
        db().prepare("SELECT story_id AS id FROM requirement WHERE id = ?").get(requirement) as { id: number }
      ).id;

      expect(state("task", t.id)).not.toBe("planned");
      expect(state("acceptance_criteria", criteria)).not.toBe("planned");
      expect(state("requirement", requirement)).not.toBe("planned");
      expect(state("story", story)).not.toBe("planned");
    }
  });
});
