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
