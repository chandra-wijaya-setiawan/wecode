import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

/** `delivered` is a story state before it is a command, so the one thing worth pinning is
 *  that dispatch reads it as the command: fall through to verb() and `wecode delivered`
 *  answers "delivered has no states", which is the shape of every earlier miss. */

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(tmp("wecode-delivered-"), "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");
const complained = (): string => err.join("");

/** A story delivered with one accepted criteria under it. The states are set on the record
 *  rather than walked through the machine: what is under test is the dispatch, not the
 *  transitions, which run.test.ts already drives. */
function fixture(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "recovery"]);
  run(["story", "create", "--parent", "1", "password reset"]);
  run(["requirement", "create", "--parent", "1", "one change per link"]);
  run(["acceptance_criteria", "create", "--parent", "1", "a reset link arrives in 60s"]);

  const db = open(process.env["WECODE_DB"] as string);
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = 1").run();
  db.prepare("UPDATE acceptance_criteria SET state = 'accepted' WHERE id = 1").run();
  out.length = 0;
  err.length = 0;
}

describe("wecode delivered", () => {
  it("reaches the delivered module rather than the entity verbs", () => {
    fixture();

    expect(run(["delivered"])).toBe(0);
    expect(said()).toContain("#1 password reset");
    expect(said()).toContain("a reset link arrives in 60s");
    expect(said()).toContain("1 delivered");
    expect(complained()).toBe("");
  });

  it("does not read delivered as an entity with no states", () => {
    fixture();

    run(["delivered"]);
    expect(complained()).not.toContain("has no states");
    expect(said()).not.toContain("wecode delivered <verb>");
  });

  it("passes its flags through, so --json is the module's answer", () => {
    fixture();

    expect(run(["delivered", "--json"])).toBe(0);
    const parsed = JSON.parse(said()) as { id: number; title: string; criteria: { statement: string }[] }[];
    expect(parsed.map((s) => s.title)).toEqual(["password reset"]);
    expect(parsed[0]?.criteria.map((c) => c.statement)).toEqual(["a reset link arrives in 60s"]);
  });

  it("answers the empty workspace from the module, not from a failed verb", () => {
    run(["init"]);
    out.length = 0;

    expect(run(["delivered"])).toBe(0);
    expect(said()).toContain("nothing delivered yet.");
  });

  it("refuses a --project that is not a number with the command's own usage line", () => {
    fixture();

    expect(run(["delivered", "--project", "storefront"])).toBe(1);
    expect(complained()).toContain("wecode delivered --project <id>");
  });

  it("names delivered under LOOKING in the usage", () => {
    expect(run([])).toBe(0);
    expect(said()).toContain("wecode delivered");
  });
});
