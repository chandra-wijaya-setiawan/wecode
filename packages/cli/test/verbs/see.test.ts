import { describe, expect, it } from "vitest";
import { run } from "../../src/run.js";
import * as see from "../../src/verbs/see.js";
import { cried, freshCli, out, said, source } from "./harness.js";

freshCli();

/** The five verbs that only look — `board`, `doctor`, `delivered`, `explore`, `design` —
 *  live in `verbs/see.ts`, one exported name each, and run.ts's dispatch calls them
 *  there. Proved the same three ways: the module exports exactly those five, run.ts holds
 *  the dispatch lines and not the bodies, and each command still answers as it did. */
describe("the reading verbs", () => {
  it("exports one name per reading verb, and nothing else", () => {
    expect(Object.keys(see).sort()).toEqual(["board", "delivered", "design", "doctor", "explore"]);
  });

  it("is what run.ts dispatches the reading verbs through", () => {
    const run_ts = source("run.ts");
    for (const dispatched of [
      "see.board(", "see.doctor(", "see.delivered(", "see.explore(", "see.design(",
    ]) {
      expect(run_ts).toContain(dispatched);
    }
    // The bodies went with them: run.ts prints no board of its own.
    expect(run_ts).not.toContain("function showBoard(");
    expect(run_ts).not.toContain("boardOf(");
  });

  it("holds the board's body rather than reaching for another module's", () => {
    expect(source("verbs/see.ts")).toContain("boardOf(at.conn(), chosen)");
  });

  it("is a file a person can read in one sitting: under the 400-line ceiling", () => {
    expect(source("verbs/see.ts").split("\n").length).toBeLessThan(400);
  });

  it("shows the board through the module, groups and all", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    out.length = 0;
    expect(run(["board", "--all"])).toBe(0);
    expect(said()).toContain("all 1 projects in this workspace");
    for (const group of ["RUNNING", "NEEDS YOU", "STALE", "QUEUE", "FAILED", "OPEN"]) {
      expect(said()).toContain(`${group} (`);
    }
  });

  it("refuses a board narrowed to a project that is not there", () => {
    run(["init"]);
    expect(run(["board", "--project", "9"])).toBe(1);
    expect(cried()).toContain("no project #9");
  });

  it("answers `delivered` through the module: nothing delivered is still an answer", () => {
    run(["init"]);
    out.length = 0;
    expect(run(["delivered"])).toBe(0);
    expect(said()).not.toBe("");
  });

  it("names the four verbs that keep a module of their own, and nothing in between", async () => {
    // `doctor`, `explore` and `design` each already had a file; what see.ts adds is the
    // one name run.ts reaches them by, so the name must be that module's own function and
    // not a wrapper that could drift from it.
    const [doctor, explore, ui] = await Promise.all([
      import("../../src/doctor.js"), import("../../src/explore.js"), import("../../src/ui.js"),
    ]);
    expect(see.doctor).toBe(doctor.doctor);
    expect(see.explore).toBe(explore.explore);
    expect(see.design).toBe(ui.design);
  });
});
