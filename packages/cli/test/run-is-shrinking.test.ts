/** run.ts is a dispatch, and a dispatch is short.
 *
 *  The entity helpers — the table declarations, `Kin` and the tree they describe, and the
 *  verbs that amend one row: scope, artefact, retry — are in `verbs/entity.ts` now. This
 *  holds the move from three sides: run.ts is under the line budget, the bodies are gone
 *  from it and exported from the new module, and every command they back still answers the
 *  way it did.
 *
 *  The budget is counted in code lines rather than in lines: a file is long because of what
 *  it does, and the comments that say why are the part worth keeping. Blank lines and
 *  comment lines do not count. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECLARED, run } from "../src/run.js";
import * as ent from "../src/verbs/entity.js";
import { tmp } from "../../core/test/tmpdir.js";

const source = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

/** Lines that are neither blank nor comment — what the file actually asks the reader to
 *  follow. A `//` line, a `/**` opener and a ` *` continuation are all comment. */
const codeLines = (text: string): number =>
  text.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|$)/.test(l)).length;

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(tmp("wecode-shrink-"), "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");

/** The shallowest tree with a task in it, which is what scope, artefact and retry amend. */
const aTask = (): void => {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "recovery"]);
  run(["story", "create", "--parent", "1", "password reset"]);
  run(["requirement", "create", "--parent", "1", "one change per link"]);
  run(["acceptance_criteria", "create", "--parent", "1", "emailed in 60s"]);
  run(["acceptance_test", "create", "--parent", "1", "mail arrives", "--artefact", "bash x.sh"]);
  run(["task", "create", "--parent", "1", "send the mail", "--role", "engineer"]);
  out.length = 0;
};

describe("run.ts is a dispatch rather than the cli", () => {
  it("is under seven hundred code lines", () => {
    expect(codeLines(source("run.ts"))).toBeLessThan(700);
  });

  it("counts code lines rather than lines: a comment is not a reason to split a file", () => {
    expect(codeLines("const a = 1;\n\n// why\n/** why\n *  at length */\nconst b = 2;\n")).toBe(2);
  });

  it("holds none of the entity helpers' bodies", () => {
    const run_ts = source("run.ts");
    for (const gone of [
      "function kin<", "const ENTITIES:", "function instead(", "function projectOf(",
      "function elsewhere(", "function crossesProject(", "function retry(", "function scope(",
      "function artefact(", "function scopeHelp(", "function artefactHelp(",
      "function createHelp(", 'table<TaskRow>("task"', 'table<LedgerRow>("ledger"',
    ]) {
      expect(run_ts, gone).not.toContain(gone);
    }
  });

  it("dispatches the amending verbs and the helps through the module", () => {
    const run_ts = source("run.ts");
    for (const dispatched of [
      "ent.scope(at, entity, args)", "ent.artefact(at, entity, args)", "ent.retry(at, args)",
      "ent.scopeHelp()", "ent.artefactHelp()", "ent.createHelp(at, entity)",
      "ent.elsewhere(at, entity, id)", "ent.projectOf(at, entity, id)",
      "ent.instead(q, entity, id)", "ent.under(at, entity, id)",
    ]) {
      expect(run_ts, dispatched).toContain(dispatched);
    }
  });

  it("keeps run.ts's own words out of the new module: it parses no argv it was not given", () => {
    expect(source("verbs/entity.ts")).not.toContain("process.argv");
    // Nor does it decide where the workspace is: the database arrives as `At`.
    expect(source("verbs/entity.ts")).not.toContain("currentDatabase");
  });

  it("still names the row shapes and the declared tables by run.ts's name", () => {
    // `verbs/run-and-see.ts` imports the row types from run.ts, and typed-run.test.ts holds
    // DECLARED against PRAGMA table_info. Moving the tables must not move those names.
    expect(DECLARED).toBe(ent.DECLARED);
    expect(DECLARED.map((t) => t.name)).toContain("task");
    expect(source("run.ts")).toContain('export { DECLARED } from "./verbs/entity.js";');
  });
});

describe("the entity module", () => {
  it("exports the tables, the shape of the tree, and the verbs that amend one row", () => {
    for (const name of [
      "workspace", "project", "story", "requirement", "criteria", "acceptanceTest", "task",
      "worker", "assignment", "ledger", "landedBranch", "DECLARED", "ENTITIES", "kin",
      "instead", "projectOf", "elsewhere", "crossesProject", "under", "projectConfig",
      "retry", "scope", "artefact", "createHelp", "scopeHelp", "artefactHelp",
    ]) {
      expect(ent, name).toHaveProperty(name);
    }
  });

  it("describes every entity the cli can be handed by name", () => {
    expect(Object.keys(ent.ENTITIES).sort()).toEqual([
      "acceptance_criteria", "acceptance_test", "assignment", "epic", "project", "release",
      "requirement", "role", "story", "task", "task_test", "worker", "workspace",
    ]);
    expect(ent.ENTITIES["task"]?.parent).toBe("acceptance_test");
    expect(ent.ENTITIES["worker"]?.up).toBeNull();
  });
});

describe("the commands the move carries still answer", () => {
  it("scopes a task, and refuses a scope on anything else", () => {
    aTask();
    expect(run(["task", "scope", "1", "--write", "src/**", "--tools", "bash,read"])).toBe(0);
    expect(said()).toContain("task #1 scope src/**");
    expect(run(["story", "scope", "1", "--write", "src/**"])).toBe(1);
    expect(err.join("")).toContain("only a task carries a scope");
  });

  it("sets a test's artefact and clears its script path", () => {
    aTask();
    expect(run(["acceptance_test", "artefact", "1", "--set", "bash mail.sh", "--script-path", "mail.sh"])).toBe(0);
    expect(said()).toContain("acceptance_test #1 artefact bash mail.sh");
    expect(said()).toContain("acceptance_test #1 script path mail.sh");
    out.length = 0;
    expect(run(["acceptance_test", "artefact", "1", "--script-path", ""])).toBe(0);
    expect(said()).toContain("script path cleared");
    expect(run(["story", "artefact", "1", "--set", "x"])).toBe(1);
    expect(err.join("")).toContain("only an acceptance_test or a task_test carries an artefact");
  });

  it("demands a reason before it retries a task", () => {
    aTask();
    expect(run(["task", "retry", "1"])).toBe(1);
    expect(err.join("")).toContain("wecode task retry <id> --reason");
  });

  it("answers --help for create, scope and artefact out of the module", () => {
    aTask();
    expect(run(["task", "create", "--help"])).toBe(0);
    expect(said()).toContain("wecode task create [flags]");
    out.length = 0;
    expect(run(["task", "scope", "--help"])).toBe(0);
    expect(said()).toContain("which files that task may change");
    out.length = 0;
    expect(run(["acceptance_test", "artefact", "--help"])).toBe(0);
    expect(said()).toContain("the command that proves the test");
  });

  it("still says what a new record joined, which is the tree read through ENTITIES", () => {
    aTask();
    expect(run(["task_test", "create", "--parent", "1", "mailer called"])).toBe(0);
    expect(said()).toContain("under task #1  send the mail");
  });

  it("still lists the ids that are there when the one asked for is not", () => {
    aTask();
    expect(run(["show", "story", "9"])).toBe(1);
    expect(err.join("")).toContain("no story #9. These story ids exist:");
    expect(err.join("")).toContain("#1  password reset");
  });
});
