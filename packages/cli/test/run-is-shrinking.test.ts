/** run.ts is a dispatch, and a dispatch is short.
 *
 *  The entity helpers — the table declarations, `Kin` and the tree they describe, and the
 *  verbs that amend one row: scope and retry — are in `verbs/entity.ts`, and the making
 *  verbs that went on from there — create's help and artefact — in `verbs/make.ts`. The last
 *  readers followed: `watch` and `wait`, the two commands that hold the process open, are
 *  in `verbs/wait.ts`, and the listings — `workspaces`, `tree`, `lessons`, `lesson drop`
 *  and an entity's own help — are in `verbs/usage.ts`. This holds each move from three
 *  sides: run.ts is under the line budget, the bodies are gone from it and exported from
 *  the new module, and every command they back still answers the way it did.
 *
 *  The budget is now the repository's own ceiling, 400, rather than a private number: a
 *  file that is a dispatch has no claim to be longer than any other file.
 *
 *  The budget is counted in code lines rather than in lines: a file is long because of what
 *  it does, and the comments that say why are the part worth keeping. Blank lines and
 *  comment lines do not count. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECLARED, run } from "../src/run.js";
import * as ent from "../src/verbs/entity.js";
import * as make from "../src/verbs/make.js";
import * as use from "../src/verbs/usage.js";
import * as until from "../src/verbs/wait.js";
import { linesIn, undocumented } from "../src/capabilities.js";
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
  it("is under four hundred code lines, which is the ceiling every other file meets", () => {
    expect(codeLines(source("run.ts"))).toBeLessThan(400);
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
      "ent.scope(at, entity, args)", "make.artefact(at, entity, args)", "ent.retry(at, args)",
      "ent.scopeHelp()", "make.artefactHelp()", "make.createHelp(at, entity)",
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
      "retry", "scope", "scopeHelp",
    ]) {
      expect(ent, name).toHaveProperty(name);
    }
  });

  /** The making verbs went on to `verbs/make.ts`: create's help, and the artefact a test is
   *  proved by. They are named here so a second move cannot quietly leave run.ts dispatching
   *  at nothing. */
  it("no longer holds the making verbs, which are exported from verbs/make.ts", () => {
    for (const name of ["createHelp", "artefact", "artefactHelp"]) {
      expect(make, name).toHaveProperty(name);
      expect(ent, name).not.toHaveProperty(name);
    }
  });

  it("keeps run.ts's own words out of the making module too", () => {
    expect(source("verbs/make.ts")).not.toContain("process.argv");
    expect(source("verbs/make.ts")).not.toContain("currentDatabase");
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

describe("the last readers leave run.ts", () => {
  it("holds none of their bodies", () => {
    const run_ts = source("run.ts");
    for (const gone of [
      "function watch(", "function wait(", "function showTree(", "function workspaces(",
      "function projectCount(", "function showLessons(", "function assignmentName(",
      "function noProjectHere(", "function lesson(", "function entityHelp(",
      "function restateHelp(", "Atomics.wait(", "setInterval(",
    ]) {
      expect(run_ts, gone).not.toContain(gone);
    }
  });

  it("dispatches each of them through the module it went to", () => {
    const run_ts = source("run.ts");
    for (const dispatched of [
      'if (head === "watch") return until.watch(at, rest);',
      'if (head === "wait") return until.wait(at, rest);',
      'if (head === "workspaces") return use.workspaces(look);',
      'if (head === "tree") return use.showTree(look, rest);',
      'if (head === "lessons") return use.showLessons(look, rest);',
      'if (head === "lesson") return use.lesson(look, rest);',
      "use.entityHelp(look, head)", "use.restateHelp()",
    ]) {
      expect(run_ts, dispatched).toContain(dispatched);
    }
  });

  it("exports the two modules by the names run.ts reaches them by", () => {
    for (const name of ["watch", "wait"]) expect(until, name).toHaveProperty(name);
    for (const name of [
      "workspaces", "projectCount", "showTree", "showLessons", "lesson", "entityHelp",
      "restateHelp",
    ]) {
      expect(use, name).toHaveProperty(name);
    }
  });

  it("parses no argv either module was not given, and neither decides where the workspace is", () => {
    for (const f of ["verbs/wait.ts", "verbs/usage.ts"]) {
      expect(source(f), f).not.toContain("process.argv");
    }
    // `usage.ts` names `currentDatabase` — it is what `wecode workspaces` marks the current
    // row with — but neither module opens the workspace the commands read: that arrives
    // as `At.conn`.
    expect(source("verbs/wait.ts")).not.toContain("currentDatabase");
    expect(source("verbs/usage.ts")).not.toContain("WECODE_DB");
  });

  it("keeps the manual itself behind, because capabilities.ts reads it out of run.ts's text", () => {
    // `manual()` in capabilities.ts slices run.ts from `function usage(` to the next `\n}`.
    // Moving those lines would empty `wecode capabilities` without failing a type check,
    // so the one help text that does not go to verbs/usage.ts is usage() — and this is why.
    const run_ts = source("run.ts");
    expect(run_ts).toContain("function usage(): number {");
    expect(undocumented(run_ts)).toEqual([]);
    const lines = linesIn(run_ts);
    for (const command of ["watch", "wait", "tree", "workspaces", "lessons", "lesson"]) {
      expect(lines.get(command), command).toBeTruthy();
    }
  });
});

describe("the commands the last two moves carry still answer", () => {
  it("drains the ledger once, and narrows it to a project", () => {
    aTask();
    expect(run(["task", "drop", "1"])).toBe(0);
    out.length = 0;
    // Everything on the ledger, read from the bottom: the drop is on it.
    expect(run(["watch", "--once", "--since", "0"])).toBe(0);
    expect(said()).toContain("task #1");
    expect(said()).toContain("→ dropped");
    out.length = 0;
    // The same ledger, asked about a project that holds none of it.
    expect(run(["watch", "--once", "--since", "0", "--project", "9"])).toBe(0);
    expect(said()).toBe("");
  });

  it("waits on a record that has already settled, and refuses one that has no states", () => {
    aTask();
    expect(run(["task", "drop", "1"])).toBe(0);
    out.length = 0;
    expect(run(["wait", "task", "1"])).toBe(1);
    expect(said()).toContain("task #1 dropped");
    expect(run(["wait", "role", "1"])).toBe(1);
    expect(err.join("")).toContain("role has no states to wait on");
  });

  it("prints the whole shape, and refuses a project that is not there", () => {
    aTask();
    expect(run(["tree"])).toBe(0);
    expect(said()).toContain("storefront");
    expect(said()).toContain("send the mail");
    expect(run(["tree", "9"])).toBe(1);
    expect(err.join("")).toContain("no project #9");
  });

  it("says how to make a workspace when the machine has none registered", () => {
    // The database here is a bare path in a tmpdir, so no workspace is registered under a
    // name. The refusal is the whole of what `workspaces` has to say, and it says the move.
    aTask();
    expect(run(["workspaces"])).toBe(1);
    expect(err.join("")).toContain("no workspaces yet");
    expect(err.join("")).toContain("wecode onboard");
  });

  it("says there are no lessons here yet, and refuses a lesson id that is not there", () => {
    aTask();
    expect(run(["lessons", "--project", "1"])).toBe(0);
    expect(said()).toContain("no lessons here yet");
    expect(run(["lesson", "drop", "9"])).toBe(1);
    expect(err.join("")).toContain("no lesson #9");
    expect(run(["lesson"])).toBe(1);
    expect(err.join("")).toContain("wecode lesson drop <id>");
  });

  it("answers an entity's own help off the machine table, and refuses one with no states", () => {
    aTask();
    expect(run(["task", "--help"])).toBe(0);
    expect(said()).toContain("states");
    expect(said()).toContain("wecode task <verb> <id>");
    expect(run(["role", "--help"])).toBe(0);
    // `role` is not stateful, so --help is the manual rather than a refusal.
    expect(said()).toContain("THE SHAPE OF THE WORK");
    out.length = 0;
    expect(run(["story", "restate", "--help"])).toBe(0);
    expect(said()).toContain("restate <id> --to");
    expect(said()).toContain("the slug does not move");
  });
});
