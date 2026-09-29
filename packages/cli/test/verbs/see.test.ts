import { describe, expect, it } from "vitest";
import { run } from "../../src/run.js";
import * as see from "../../src/verbs/see.js";
import { cried, freshCli, out, said, source } from "./harness.js";

freshCli();

/** The six verbs that only look — `standup`, `board`, `doctor`, `delivered`, `explore`,
 *  `design` — live in `verbs/see.ts`, one exported name each, and run.ts's dispatch calls
 *  them there. Proved the same three ways: the module exports exactly those six, run.ts
 *  holds the dispatch lines and not the bodies, and each command still answers as it did.
 *
 *  `standup` is pinned here with the rest because the list is what says a verb only looks.
 *  A reading verb that is not on it is a verb nothing stops from growing a write. */
describe("the reading verbs", () => {
  it("exports one name per reading verb, and nothing else", () => {
    expect(Object.keys(see).sort()).toEqual([
      "board", "delivered", "design", "doctor", "explore", "standup",
    ]);
  });

  it("is what run.ts dispatches the reading verbs through", () => {
    const run_ts = source("run.ts");
    for (const dispatched of [
      "see.standup(", "see.board(", "see.doctor(", "see.delivered(", "see.explore(", "see.design(",
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

  it("holds the standup's body too, so the two verbs with no module of their own are here", () => {
    const see_ts = source("verbs/see.ts");
    expect(see_ts).toContain("export function standup(at: See): number {");
    // Not a re-export dressed up as a body: nothing upstream is named `standup`.
    expect(see_ts).not.toContain("export { standup }");
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

  it("shows the standup through the module, ordered groups and the next step", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    out.length = 0;
    expect(run(["standup", "--all"])).toBe(0);
    expect(said()).toContain("STANDUP  all 1 projects in this workspace");
    for (const group of [
      "1 RUNNER",
      "2 RUNNING (",
      "3 READY (",
      "4 FAILED (",
      "5 DELIVERED, NOT LANDED (",
      "6 WAITING ON A PERSON (",
      "7 RED ACCEPTANCE TESTS (",
      "8 DOCTOR, OPEN ACROSS THE WORKSPACE (",
    ]) {
      expect(said()).toContain(group);
    }
    // The ranking is the point of the verb, so the digest ends in one move and not a list.
    expect(said().trimEnd().split("\n").at(-1)).toContain("NEXT  ");
  });

  it("refuses a standup narrowed to a project that is not there, the way the board does", () => {
    run(["init"]);
    expect(run(["standup", "--project", "9"])).toBe(1);
    expect(cried()).toContain("no project #9");
  });

  it("only looks: a standup leaves the board saying exactly what it said before", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    out.length = 0;
    run(["board", "--all"]);
    const before = said();
    out.length = 0;
    expect(run(["standup", "--all"])).toBe(0);
    out.length = 0;
    run(["board", "--all"]);
    expect(said()).toBe(before);
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
