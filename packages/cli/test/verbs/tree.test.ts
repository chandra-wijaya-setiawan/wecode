import { describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { run } from "../../src/run.js";
import * as rungs from "../../src/verbs/tree.js";
import { cried, freshCli, out, said } from "./harness.js";

freshCli();

/** The five rungs that exist to hold other rungs live in `verbs/tree.ts`, one exported
 *  function each, and `create` is the dispatch that calls them. Proved from both ends: the
 *  module answers when called directly with a `Rung`, and the command an operator types
 *  reaches the same function and reports the same row. */
describe("the tree verbs", () => {
  const maker = (): Maker => new Maker(open(process.env["WECODE_DB"] as string));

  const rung = (parent: number, text: string): rungs.Rung => ({
    make: maker(),
    text,
    parent: () => parent,
    path: "/tmp/somewhere",
  });

  it("exports one function per rung", () => {
    expect(Object.keys(rungs).sort()).toEqual(["epic", "project", "release", "story", "workspace"]);
  });

  it("makes each rung under the one above it", () => {
    run(["init"]);
    const make = maker();
    expect(rungs.workspace({ make, text: "acme", parent: () => 0, path: "/tmp/acme" })).toBe(1);
    expect(rungs.project(rung(1, "storefront"))).toBe(1);
    expect(rungs.release(rung(1, "1.0.0"))).toBe(1);
    expect(rungs.epic(rung(1, "recovery"))).toBe(1);
    expect(rungs.story(rung(1, "password reset"))).toBe(1);
  });

  it("asks a workspace for no parent, so --parent stays a flag of the rungs that hang", () => {
    run(["init"]);
    const make = maker();
    const absent = (): number => {
      throw new Error("asked for a parent");
    };
    expect(rungs.workspace({ make, text: "acme", parent: absent, path: "/tmp/acme" })).toBe(1);
    expect(() => rungs.story({ make, text: "s", parent: absent, path: "" })).toThrow("asked for a parent");
  });

  it("is what `wecode <rung> create` dispatches to, and says what it joined", () => {
    run(["init"]);
    for (const [entity, text] of [
      ["workspace", "acme"],
      ["project", "storefront"],
      ["release", "1.0.0"],
      ["epic", "recovery"],
      ["story", "password reset"],
    ] as const) {
      out.length = 0;
      const args = entity === "workspace" ? [entity, "create", text] : [entity, "create", "--parent", "1", text];
      expect(run(args)).toBe(0);
      expect(said()).toContain(`${entity} #1`);
    }
    expect(said()).toContain("under epic #1  recovery");
  });

  it("passes --path through to the two rungs that point at a directory", () => {
    run(["init"]);
    expect(run(["workspace", "create", "acme", "--path", "/tmp/acme"])).toBe(0);
    expect(run(["project", "create", "--parent", "1", "storefront", "--path", "/tmp/store"])).toBe(0);
    const db = open(process.env["WECODE_DB"] as string);
    expect((db.prepare("SELECT path FROM workspace WHERE id = 1").get() as { path: string }).path).toBe("/tmp/acme");
    expect((db.prepare("SELECT repo FROM project WHERE id = 1").get() as { repo: string }).repo).toBe("/tmp/store");
    db.close();
  });

  it("refuses a rung with no --parent, by naming the flag", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    expect(run(["epic", "create", "recovery"])).toBe(1);
    expect(cried()).toContain('wecode epic create --parent <id> "<text>"');
  });
});
