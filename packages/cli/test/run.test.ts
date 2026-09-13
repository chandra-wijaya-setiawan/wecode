import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(mkdtempSync(join(tmpdir(), "wecode-cli-")), "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");

describe("the cli", () => {
  it("builds a tree and cascades a pass to a delivered epic", () => {
    expect(run(["init"])).toBe(0);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    run(["release", "create", "--parent", "1", "1.0"]);
    run(["epic", "create", "--parent", "1", "recovery"]);
    run(["story", "create", "--parent", "1", "password reset"]);
    run(["requirement", "create", "--parent", "1", "one change per link"]);
    run(["acceptance_criteria", "create", "--parent", "1", "emailed in 60s"]);
    run(["acceptance_test", "create", "--parent", "1", "mail arrives", "--artefact", "bash x.sh"]);
    run(["task", "create", "--parent", "1", "send the mail", "--role", "engineer"]);
    run(["task_test", "create", "--parent", "1", "mailer called", "--artefact", "vitest run"]);

    for (const e of ["project", "release", "epic", "story", "requirement", "acceptance_criteria"]) {
      expect(run([e, "start", "1"])).toBe(0);
    }

    expect(run(["task", "start", "1"])).toBe(1);
    expect(err.join("")).toContain("no write scope");

    run(["task", "scope", "1", "--write", "src/**", "--tools", "bash"]);
    run(["task_test", "deliver", "1"]);
    expect(run(["task", "start", "1"])).toBe(0);

    out.length = 0;
    run(["task_test", "pass", "1"]);
    expect(said()).toContain("task #1  ready → done  (cascade)");

    out.length = 0;
    run(["acceptance_test", "deliver", "1"]);
    run(["acceptance_test", "pass", "1"]);
    expect(said()).toContain("epic #1  in_progress → delivered  (cascade)");
  });

  it("names the legal verbs when one is refused", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "p"]);
    expect(run(["project", "release", "1"])).toBe(1);
    expect(err.join("")).toContain("Legal here");
  });

  it("refuses an entity that has no states", () => {
    run(["init"]);
    expect(run(["worker", "start", "1"])).toBe(1);
    expect(err.join("")).toContain("has no states");
  });
});

describe("answering", () => {
  it("refuses an assignment that is not waiting on anybody", () => {
    run(["init"]);
    expect(run(["answer", "1", "yes"])).toBe(1);
    expect(err.join("")).toContain("no assignment #1");
  });

  it("records the answer and who gave it", () => {
    run(["init"]);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(process.env["WECODE_DB"] as string);
    db.prepare(
      `INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES ('w','w','engineer','agent','t','t')`,
    ).run();
    db.prepare(
      `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,question,spent,created_at,updated_at)
       VALUES ('a','task',1,1,'{}','{}','/tmp','waiting','approval','may I?','{}','t','t')`,
    ).run();
    db.close();

    expect(run(["answer", "1", "yes,", "go", "ahead"])).toBe(0);
    expect(said()).toContain("answered by operator");
  });
});

describe("help is what an agent reads first", () => {
  it("says what the work is shaped like, not only which flags exist", () => {
    run(["--help"]);
    const out = said();
    expect(out).toContain("acceptance_test");
    expect(out).toContain("wecode onboard");
    expect(out).toContain("two tasks whose write scopes overlap");
  });

  it("prints an entity's real states and verbs, off the machine table", () => {
    run(["task", "--help"]);
    const out = said();
    expect(out).toContain("planned · ready · done · failed · dropped");
    expect(out).toContain("task_may_be_attempted");
    expect(out).toContain("automatic");
  });

  it("falls back to the manual for a word that is not an entity", () => {
    expect(run(["worker", "--help"])).toBe(0);
    expect(said()).toContain("THE SHAPE OF THE WORK");
  });
});

describe("first contact", () => {
  it("says where wecode is not, rather than throwing a stack trace", () => {
    process.env["WECODE_DB"] = "/tmp/wecode-nowhere/does-not-exist.db";
    expect(run(["board"])).toBe(1);
    expect(err.join("")).toContain("no wecode workspace");
    expect(err.join("")).toContain("wecode onboard");
  });
});
