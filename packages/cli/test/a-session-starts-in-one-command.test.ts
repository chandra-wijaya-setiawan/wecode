/** A session starts in one command.
 *
 *  An orchestrating agent arrives knowing nothing and assembles the picture out of `board`,
 *  `doctor`, `delivered` and a look at the runner — four commands whose answers overlap and
 *  none of which says which to read first, so the operator supplied the procedure out loud,
 *  every few minutes, for as long as the session lasted.
 *
 *  `wecode standup` is that procedure written down, and the procedure is what is held here:
 *  the eight questions come back in one read, in the one order that makes sense of them;
 *  the runner is first because nothing below it moves without one; nothing in the record is
 *  touched by the asking; and the last line is a command, because a digest that ends in a
 *  list is a digest somebody still has to decide from, and deciding was exactly the part
 *  being done by hand.
 *
 *  Driven through `run()` end to end. The state a real session finds — an assignment in
 *  flight, a task out of attempts, a story delivered and off the base, a violation the
 *  doctor holds open — is written straight into the record where no cli command reaches it,
 *  because what is under test is the reading and never the writing. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open, recordBuildDrift, takeLease } from "@wecode/core";
import { linesIn, undocumented } from "../src/capabilities.js";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(tmp("wecode-standup-"), "wecode.db");
  delete process.env["WECODE_ACTOR"];
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");
const complained = (): string => err.join("");
const db = () => open(process.env["WECODE_DB"] as string);

/** The last thing the command said, the trailing newline dropped so it really is the last. */
const lastLine = (): string => said().trimEnd().split("\n").at(-1) as string;

/** The record, reached where no command reaches it. A session finds states no verb of the
 *  cli can put the record into — an assignment mid-flight, a task out of attempts — and the
 *  subject here is the read, so they are written rather than acted out. */
const write = (...statements: readonly string[]): void => {
  const handle = new DatabaseSync(process.env["WECODE_DB"] as string);
  for (const s of statements) handle.exec(s);
  handle.close();
};

const STAMP = "2026-01-01T00:00:00.000Z";

/** The shallowest tree with a task in it, in the project this directory is, plus the one
 *  person a question can be put to. */
function fixture(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront", "--path", process.cwd()]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "recovery"]);
  run(["story", "create", "--parent", "1", "password reset"]);
  run(["requirement", "create", "--parent", "1", "one change per link"]);
  run(["acceptance_criteria", "create", "--parent", "1", "a reset link arrives in 60s"]);
  run(["acceptance_test", "create", "--parent", "1", "the mail arrives", "--artefact", "bash mail.sh"]);
  run(["task", "create", "--parent", "1", "send the reset mail", "--role", "engineer"]);
  run(["worker", "create", "cws", "--role", "operator", "--kind", "human"]);
  out.length = 0;
  err.length = 0;
}

/** The tree, plus a runner of record that is alive and current — the state every question
 *  below the first one is asked in, and the one the next-step ladder starts from. */
function ready(behind: number | null = 0): void {
  fixture();
  const handle = db();
  takeLease(handle, "host/4242", 30_000);
  if (behind !== null) recordBuildDrift(handle, "host/4242", behind);
}

/** A lease whose holder stopped beating ten minutes ago, which is many of its intervals. */
const abandoned = (): void => void takeLease(db(), "host/9", 1_000, new Date(Date.now() - 600_000).toISOString());

/** An assignment in flight against task 1. Written, not dispatched: allocating one needs a
 *  runner, and this is a test about reading. */
const dispatched = (phase: string): void =>
  write(
    `INSERT INTO assignment (id, slug, objective_type, objective_id, worker_id, scope, budget,` +
      ` worktree, phase, spent, created_at, updated_at) VALUES (1, 'a-1', 'task', 1, 1, '', '',` +
      ` '/tmp/wt', '${phase}', '0', '${STAMP}', '${STAMP}')`,
  );

const stopped = (task: number): string =>
  `UPDATE task SET state = 'failed', attempts = 3, max_retry = 3 WHERE id = ${task}`;

const DELIVERED = "UPDATE story SET state = 'delivered' WHERE id = 1";

const asked = (): void => {
  run(["ask", "1", "rebase the branch, or cut a fresh one?"]);
  out.length = 0;
};

/** One row of the doctor's report. `cleared` null is drift still standing. */
const adrift = (invariant: string, slug: string, cleared: string | null = null): string =>
  `INSERT INTO doctor_violation (invariant, entity, entity_id, slug, detail, found_at, first_seen,` +
  ` last_seen, cleared_at) VALUES ('${invariant}', 'story', 1, '${slug}', '${slug} is adrift',` +
  ` '${STAMP}', '${STAMP}', '${STAMP}', ${cleared === null ? "NULL" : `'${cleared}'`})`;

describe("one command, the whole picture", () => {
  it("answers eight questions in one read, numbered in the order they have to be read", () => {
    fixture();
    expect(run(["standup"])).toBe(0);
    expect(complained()).toBe("");
    const at = [
      "1 RUNNER", "2 RUNNING", "3 READY", "4 FAILED", "5 DELIVERED, NOT LANDED",
      "6 WAITING ON A PERSON", "7 RED ACCEPTANCE TESTS", "8 DOCTOR",
    ].map((h) => said().indexOf(h));
    expect(at.filter((i) => i === -1)).toEqual([]);
    // The order is the whole point: a digest whose sections move is four commands again.
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // An empty group is said as empty rather than left out, or absence reads as unasked.
    expect(said()).toContain("2 RUNNING (0)");
    expect(said()).toContain("7 RED ACCEPTANCE TESTS (0)");
    expect(said()).toContain("  —");
  });

  it("narrows to the project you stand in, answers for the workspace, and refuses a bad id", () => {
    fixture();
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("#1 storefront");
    expect(said()).toContain("wecode standup --all");
    out.length = 0;
    expect(run(["standup", "--all"])).toBe(0);
    expect(said()).toContain("all 1 projects in this workspace");
    expect(run(["standup", "--project", "9"])).toBe(1);
    expect(complained()).toContain("no project #9");
    expect(run(["standup", "--project", "storefront"])).toBe(1);
    expect(complained()).toContain("wecode standup --project <id>");
  });
});

describe("whether the runner holds its lease, and whether its build is behind", () => {
  it("says nobody holds it, and calls a lease whose holder stopped beating stale, not held", () => {
    fixture();
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("nobody holds the lease");
    out.length = 0;
    abandoned();
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("stale, so nothing is ticking");
  });

  it("names the holder, how long since it was alive, and how far behind its build is", () => {
    ready(3);
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("host/4242 holds the lease");
    expect(said()).toContain("last alive");
    expect(said()).toContain("its build is 3 commits behind the base");
    expect(said()).not.toContain("nobody holds the lease");
  });

  it("calls a build with no measured drift current, and an unmeasured one unmeasured", () => {
    // Only the holder may write the number, so its absence means no tick has measured it —
    // a different thing from a build that is current, and reading them alike is how a
    // runner three days stale goes on looking healthy.
    ready(0);
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("its build is current with the base");
    out.length = 0;
    recordBuildDrift(db(), "host/4242", null);
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("its build drift has not been measured");
    expect(said()).not.toContain("current with the base");
  });
});

describe("what is running, ready, failed and delivered but unlanded", () => {
  it("puts each of the three kinds of work in flight under its own heading", () => {
    ready();
    run(["task", "create", "--parent", "1", "expire the link", "--role", "engineer"]);
    run(["task", "create", "--parent", "1", "log the send", "--role", "engineer"]);
    out.length = 0;
    dispatched("running");
    write("UPDATE task SET state = 'ready' WHERE id = 2", stopped(3));

    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("2 RUNNING (1)");
    expect(said()).toContain("send the reset mail");
    expect(said()).toContain("3 READY (1)");
    expect(said()).toContain("expire the link");
    expect(said()).toContain("4 FAILED (1)");
    expect(said()).toContain("out of attempts");
  });

  it("shows a delivered story that never reached the base, and why nothing has moved it", () => {
    ready();
    write(DELIVERED);
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("5 DELIVERED, NOT LANDED (1)");
    expect(said()).toContain("password reset");
    expect(said()).toContain("nothing is owed it");
  });

  it("stops counting it once its branch is on the base, which the state never says", () => {
    // Delivered is the record's word and landed is the repository's; they disagree for a
    // day at a time, so the group is read from what actually merged.
    ready();
    write(
      DELIVERED,
      `CREATE TABLE IF NOT EXISTS landed_branch (task_id INTEGER PRIMARY KEY, branch TEXT NOT NULL,` +
        ` sha TEXT NOT NULL, merged_at TEXT NOT NULL)`,
      `INSERT INTO landed_branch (task_id, branch, sha, merged_at)` +
        ` VALUES (1, 'story/password-reset', 'abc1234', '${STAMP}')`,
    );
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("5 DELIVERED, NOT LANDED (0)");
  });
});

describe("every approval waiting on a person", () => {
  it("shows the question, and stops showing it once somebody has answered", () => {
    ready();
    asked();
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("6 WAITING ON A PERSON (1)");
    expect(said()).toContain("rebase the branch, or cut a fresh one?");
    expect(run(["answer", "1", "rebase"])).toBe(0);
    out.length = 0;
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("6 WAITING ON A PERSON (0)");
  });
});

describe("the acceptance tests that are red, and which of their files are red at base", () => {
  /** Two red tests: one somebody watched fail at the base, one nobody has. */
  const twoRed = (): void => {
    ready();
    run(["acceptance_test", "create", "--parent", "1", "the link expires", "--artefact", "bash expiry.sh"]);
    out.length = 0;
    write(
      "UPDATE acceptance_test SET state = 'failed' WHERE id IN (1, 2)",
      "UPDATE acceptance_test SET red_at_base_sha = 'deadbeefcafe' WHERE id = 1",
      "UPDATE acceptance_test SET red_at_base_reason = 'it passed at base' WHERE id = 2",
    );
  };

  it("lists each red test with the file its artefact runs, and which file was red at base", () => {
    // Both halves answer one question. A red test with a sha is work in flight: somebody
    // watched it fail, so making it pass will mean something. A red test with no sha proves
    // nothing yet and `test_has_been_red` will refuse its pass — so one line carries both,
    // or a reader draws the wrong conclusion twice.
    twoRed();
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("7 RED ACCEPTANCE TESTS (2)");
    expect(said()).toContain("bash mail.sh");
    expect(said()).toContain("bash expiry.sh");
    expect(said()).toContain("red at base deadbee");
    expect(said()).toContain("NOT red at base — it passed at base");
  });
});

describe("the doctor's open invariants", () => {
  it("counts what still stands, one line per invariant, and leaves out what was cleared", () => {
    ready();
    write(adrift("delivered_story_has_landed", "password-reset"));
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("8 DOCTOR, OPEN ACROSS THE WORKSPACE (1)");
    expect(said()).toContain("delivered_story_has_landed");
    expect(said()).toContain("password-reset is adrift");
    out.length = 0;
    write("DELETE FROM doctor_violation", adrift("schema_version_is_understood", "schema", STAMP));
    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("8 DOCTOR, OPEN ACROSS THE WORKSPACE (0)");
  });
});

describe("it reads and it reports, and changes nothing", () => {
  /** Everything a read could plausibly disturb, as one string. */
  const record = (): string => {
    const handle = new DatabaseSync(process.env["WECODE_DB"] as string);
    const dumped = ["story", "task", "acceptance_test", "assignment", "ledger", "doctor_violation", "runner_lease"]
      .map((t) => `${t}:${JSON.stringify(handle.prepare(`SELECT * FROM ${t}`).all())}`)
      .join("\n");
    handle.close();
    return dumped;
  };

  it("leaves the record exactly as it found it, ledger included", () => {
    ready(2);
    dispatched("running");
    write(DELIVERED, adrift("delivered_story_has_landed", "password-reset"));

    const before = record();
    expect(run(["standup"])).toBe(0);
    expect(run(["standup", "--all"])).toBe(0);
    expect(record()).toBe(before);
  });
});

describe("the last line names the next step", () => {
  it("is the last thing said, and it is a command", () => {
    fixture();
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toMatch(/^NEXT {2}\S+/);
    expect(lastLine()).toMatch(/wecode/);
    // Nothing follows it: a digest that ends in a heading has not named a next step.
    expect(said().endsWith(`${lastLine()}\n`)).toBe(true);
  });

  it("starts the runner when nothing holds the lease, because nothing below it will move", () => {
    fixture();
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode-runner");
    expect(lastLine()).toContain("nothing holds the lease");
  });

  it("starts the runner when the lease is stale, and says whose it was", () => {
    fixture();
    abandoned();
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode-runner");
    expect(lastLine()).toContain("host/9");
  });

  it("answers the person being waited on before anything a machine could do", () => {
    ready();
    asked();
    write(DELIVERED);
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode answer 1");
  });

  it("lands a delivered story before retrying a task, because the base blocks what follows", () => {
    ready();
    write(DELIVERED, stopped(1));
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode land 1");
    expect(lastLine()).toContain("password reset");
  });

  it("retries the task that stopped, naming the flag the retry needs", () => {
    ready();
    write(stopped(1));
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode task retry 1 --reason");
  });

  it("restarts a runner whose build is behind, once nothing is waiting on a person", () => {
    ready(4);
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode-runner");
    expect(lastLine()).toContain("4 behind the base");
  });

  it("calls the doctor when the only thing left is drift it is holding open", () => {
    ready();
    write(adrift("delivered_story_has_landed", "password-reset"));
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode doctor");
  });

  it("waits on the assignment in flight when there is nothing to fix", () => {
    ready();
    dispatched("running");
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode wait assignment 1");
  });

  it("waits on the queued task when nothing is running either", () => {
    ready();
    write("UPDATE task SET state = 'ready' WHERE id = 1");
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode wait task 1");
  });

  it("sends you to the whole workspace when this project owes nobody anything", () => {
    ready();
    expect(run(["standup"])).toBe(0);
    expect(lastLine()).toContain("wecode board --all");
    expect(lastLine()).toContain("nothing here is running, waiting or owed");
  });
});

describe("the command is on the surface an agent reads", () => {
  it("is in the manual under START HERE, so `wecode capabilities` can describe it", () => {
    const source = readFileSync(new URL("../src/run.ts", import.meta.url), "utf8");
    expect(undocumented(source)).toEqual([]);
    expect(linesIn(source).get("standup")).toContain("next step");
    fixture();
    expect(run(["--help"])).toBe(0);
    expect(said()).toContain("wecode standup");
  });
});
