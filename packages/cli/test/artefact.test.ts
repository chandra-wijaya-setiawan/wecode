import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { recordRed } from "../../core/test/helpers.js";

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
const complained = (): string => err.join("");

/** One of everything, both tests carrying a mistyped artefact — which is the situation:
 *  the command was wrong when it was planned and nothing has run it. */
const tree = (): void => {
  expect(run(["init"])).toBe(0);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront", "--path", process.cwd()]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "recovery"]);
  run(["story", "create", "--parent", "1", "password reset"]);
  run(["requirement", "create", "--parent", "1", "one change per link"]);
  run(["acceptance_criteria", "create", "--parent", "1", "emailed in 60s"]);
  run(["acceptance_test", "create", "--parent", "1", "mail arrives", "--artefact", "bash maul.sh"]);
  run(["task", "create", "--parent", "1", "send the mail", "--role", "engineer"]);
  run(["task_test", "create", "--parent", "1", "mailer called", "--artefact", "vitest run maler"]);
  out.length = 0;
};

const artefactOf = (table: string, id: number): { artefact: string; script_path: string | null } =>
  open(process.env["WECODE_DB"] as string)
    .prepare(`SELECT artefact, script_path FROM ${table} WHERE id = ?`)
    .get(id) as { artefact: string; script_path: string | null };

const redOf = (id: number): { red_at_base_sha: string | null; red_at_base_at: string | null } =>
  open(process.env["WECODE_DB"] as string)
    .prepare("SELECT red_at_base_sha, red_at_base_at FROM acceptance_test WHERE id = ?")
    .get(id) as { red_at_base_sha: string | null; red_at_base_at: string | null };

describe("wecode <test> artefact", () => {
  it("retypes an acceptance_test's command without dropping the test", () => {
    tree();
    expect(run(["acceptance_test", "artefact", "1", "--set", "bash test/mail.sh"])).toBe(0);
    expect(said()).toContain("acceptance_test #1 artefact bash test/mail.sh");
    expect(artefactOf("acceptance_test", 1).artefact).toBe("bash test/mail.sh");

    // The test is still there to be delivered and passed, which is the whole point.
    expect(run(["acceptance_test", "deliver", "1"])).toBe(0);
  });

  it("retypes a task_test's command", () => {
    tree();
    expect(run(["task_test", "artefact", "1", "--set", "vitest run mailer"])).toBe(0);
    expect(said()).toContain("task_test #1 artefact vitest run mailer");
    expect(artefactOf("task_test", 1).artefact).toBe("vitest run mailer");
  });

  it("sets and clears a script path on either entity", () => {
    tree();
    expect(run(["acceptance_test", "artefact", "1", "--script-path", "test/mail.sh"])).toBe(0);
    expect(run(["task_test", "artefact", "1", "--script-path", "test/mailer.test.ts"])).toBe(0);
    expect(artefactOf("acceptance_test", 1).script_path).toBe("test/mail.sh");
    expect(artefactOf("task_test", 1).script_path).toBe("test/mailer.test.ts");

    out.length = 0;
    expect(run(["acceptance_test", "artefact", "1", "--script-path", ""])).toBe(0);
    expect(said()).toContain("script path cleared");
    expect(artefactOf("acceptance_test", 1).script_path).toBeNull();
  });

  it("refuses an empty command in the words the artefact_resolves guard uses", () => {
    tree();
    // What the guard says, read off the guard rather than copied: deliver is guarded by
    // artefact_resolves, so a test with nothing to run is refused in these words.
    run(["acceptance_test", "create", "--parent", "1", "nothing to run", "--artefact", " "]);
    expect(run(["acceptance_test", "deliver", "2"])).toBe(1);
    const guardSaid = complained();
    expect(guardSaid).toContain("no artefact");

    const words = "it has no artefact — there is nothing to run or to follow";
    expect(guardSaid).toContain(words);

    for (const entity of ["acceptance_test", "task_test"]) {
      err.length = 0;
      expect(run([entity, "artefact", "1", "--set", "   "])).toBe(1);
      expect(complained()).toContain(words);
    }
    // And the old command is still the command: nothing was written.
    expect(artefactOf("acceptance_test", 1).artefact).toBe("bash maul.sh");
    expect(artefactOf("task_test", 1).artefact).toBe("vitest run maler");
  });

  it("clears a recorded red-at-base verdict, because it was about the old command", () => {
    tree();
    recordRed(open(process.env["WECODE_DB"] as string), 1);
    expect(redOf(1).red_at_base_sha).toBe("base0000");

    expect(run(["acceptance_test", "artefact", "1", "--set", "bash test/mail.sh"])).toBe(0);
    expect(redOf(1)).toEqual({ red_at_base_sha: null, red_at_base_at: null });

    // So the test cannot pass on the strength of the old command's red run.
    run(["acceptance_test", "deliver", "1"]);
    err.length = 0;
    expect(run(["acceptance_test", "pass", "1"])).toBe(1);
    expect(complained()).toContain("has never been seen to fail");
  });

  it("leaves the red record alone when only the script path moves", () => {
    tree();
    recordRed(open(process.env["WECODE_DB"] as string), 1);
    expect(run(["acceptance_test", "artefact", "1", "--script-path", "test/mail.sh"])).toBe(0);
    expect(redOf(1).red_at_base_sha).toBe("base0000");
  });

  it("names the flags when neither is given, and refuses entities with no artefact", () => {
    tree();
    expect(run(["acceptance_test", "artefact", "1"])).toBe(1);
    expect(complained()).toContain('--set "<cmd>"');

    err.length = 0;
    expect(run(["task", "artefact", "1", "--set", "x"])).toBe(1);
    expect(complained()).toContain("only an acceptance_test or a task_test carries an artefact");
  });
});
