import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open, transact } from "../src/index.js";
import { run } from "../../cli/src/run.js";
import { tmp } from "./tmpdir.js";

/** Two writers, and a plan that dies between its halves.
 *
 *  On 15 Sep the runner's tick and a cli command each aborted with `database is locked`
 *  rather than waiting the milliseconds the other needed, and `wecode plan` died that way
 *  after creating story 171's whole tree but before starting it — a tree nobody would run
 *  and a person had to finish by hand. Both are pinned here: a busy timeout on every
 *  connection, and one transaction over the whole of plan. */

// ── a second writer waits ────────────────────────────────────────────────────────────────

/** Milliseconds the child holds the write lock. Comfortably under the 5s busy timeout, so a
 *  waiting writer gets through, and comfortably over the zero a connection without one
 *  waits, so "it waited" is a measurement rather than a coincidence. */
const HELD_FOR = 600;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A separate process, because node:sqlite is synchronous: a second connection in this
 *  process could never release a lock while this one is blocked waiting for it. */
const HOLDER = `
  const { DatabaseSync } = require("node:sqlite");
  const { writeFileSync } = require("node:fs");
  const [path, marker, held] = process.argv.slice(1);
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE");
  db.exec("UPDATE schema_version SET version = version");
  writeFileSync(marker, "held");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(held));
  db.exec("COMMIT");
  db.close();
`;

describe("a second writer waits for the first rather than aborting", () => {
  it("lets a write through that began while another connection held the lock", async () => {
    const dir = tmp("wecode-busy-");
    const path = join(dir, "wecode.db");
    open(path).close();

    const marker = join(dir, "held");
    const child = spawn(process.execPath, ["-e", HOLDER, "--", path, marker, String(HELD_FOR)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += String(b)));

    // Spin rather than await: the point of the test is what a synchronous write does while
    // the lock is genuinely held, so this thread has to reach that write still blocked.
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) sleep(10);
    expect(existsSync(marker), `the holder never took the lock: ${stderr}`).toBe(true);

    const db = open(path);
    const began = Date.now();
    transact(db, () => db.exec("UPDATE schema_version SET version = version"));
    const waited = Date.now() - began;
    db.close();

    // It waited for the holder instead of throwing, and it did not wait the whole timeout.
    expect(waited).toBeGreaterThan(HELD_FOR / 3);
    expect(waited).toBeLessThan(5000);

    await new Promise((done) => child.on("close", done));
  });
});

// ── a plan that dies partway leaves nothing ──────────────────────────────────────────────

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
  repo = tmp("wecode-plan-atomic-");
  mkdirSync(join(repo, "config"));
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  writeFileSync(join(repo, "config", "roles.yaml"), ROLES);
});

afterEach(() => vi.restoreAllMocks());

const db = () => open(process.env["WECODE_DB"] as string);

const count = (table: string): number => (db().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A project with one in-progress epic and nothing under it. */
function project(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "0.0.1"]);
  run(["epic", "create", "--parent", "1", "the cockpit"]);
  run(["epic", "start", "1"]);
}

/** A file describing a whole new story: one requirement, one criteria, one task. */
function planFile(): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(
    path,
    `story: the list is one function

requirements:
  - statement: a box and a box page are one list function
    criteria:
      - statement: one function renders rows, columns, a height and a cursor
        test: pnpm exec vitest run packages/tui
        tasks:
          - title: write src/list.ts as the contract specifies
            scope: ["src/list.ts", "test/list.test.ts"]
            test: pnpm exec vitest run test/list.test.ts
            role: engineer
`,
  );
  return path;
}

/** Kills the run at the first task start — which is after the story, the requirement and the
 *  criteria have been started and the acceptance test delivered. The ledger itself refuses
 *  the write, so this is the same shape of failure as the lock that killed story 171: a
 *  plan that has created its rows and is partway through starting them. */
function interruptAtFirstTaskStart(): void {
  const d = db();
  d.exec(
    "CREATE TRIGGER interrupt BEFORE UPDATE OF state ON task " +
      "BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
  );
  d.close();
}

describe("a plan interrupted partway leaves no half-started tree", () => {
  it("creates the whole tree started, or none of it", () => {
    project();
    interruptAtFirstTaskStart();

    let code: number | null = null;
    try {
      code = run(["plan", planFile()]);
    } catch {
      // A throw is still a failure that must leave nothing behind; the rows are the claim.
    }
    expect(code).not.toBe(0);

    // Not one row of the tree survives — not the story the file named, and not the
    // requirement, criteria, acceptance test or task hanging off it.
    expect(count("story")).toBe(0);
    expect(count("requirement")).toBe(0);
    expect(count("acceptance_criteria")).toBe(0);
    expect(count("acceptance_test")).toBe(0);
    expect(count("task")).toBe(0);
  });

  it("still plans normally when nothing interrupts it", () => {
    project();
    expect(run(["plan", planFile()])).toBe(0);

    expect(count("story")).toBe(1);
    expect(count("task")).toBeGreaterThan(0);
    const story = db().prepare("SELECT state FROM story WHERE id = 1").get() as { state: string };
    expect(story.state).toBe("in_progress");
  });
});
