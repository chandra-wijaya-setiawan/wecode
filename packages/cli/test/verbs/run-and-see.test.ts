import { describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { run } from "../../src/run.js";
import * as act from "../../src/verbs/run-and-see.js";
import { tmp } from "../../../core/test/tmpdir.js";
import { cried, freshCli, out, said, source } from "./harness.js";

freshCli();

/** The six verbs that act live in `verbs/run-and-see.ts`, one exported function each, and
 *  run.ts is the dispatch that calls them. Proved from three sides: the module exports
 *  exactly those six names, run.ts no longer holds their bodies, and the command an
 *  operator types still answers the way it did before the move. */
describe("the run-and-see verbs", () => {
  /** The shallowest tree with something to hang a question or a landing on. */
  const aStory = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    run(["release", "create", "--parent", "1", "1.0.0"]);
    run(["epic", "create", "--parent", "1", "recovery"]);
    run(["story", "create", "--parent", "1", "password reset"]);
  };

  it("exports one function per verb, and nothing else", () => {
    expect(Object.keys(act).sort()).toEqual([
      "answer", "ask", "land", "onboard", "plan", "worker",
    ]);
  });

  it("leaves run.ts with the dispatch and not the bodies", () => {
    const run_ts = source("run.ts");
    for (const gone of [
      "function showBoard(", "function ask(", "function answer(", "function land(",
      "function onboard(", "function recordLanding(", "function hire(", "function rolesFor(",
    ]) {
      expect(run_ts).not.toContain(gone);
    }
    for (const dispatched of [
      "act.plan(", "act.land(", "act.ask(", "act.answer(", "act.onboard(", "act.worker(",
    ]) {
      expect(run_ts).toContain(dispatched);
    }
  });

  it("makes a worker when called directly, the way `wecode worker create` does", () => {
    run(["init"]);
    const make = new Maker(open(process.env["WECODE_DB"] as string));
    expect(act.worker({ make, text: "ada", role: "operator", kind: "human" })).toBe(1);
    expect(run(["worker", "create", "grace", "--role", "engineer"])).toBe(0);
    expect(said()).toContain("worker #2");
  });

  it("asks a named person and answers them, both through the module", () => {
    aStory();
    run(["worker", "create", "ada", "--role", "operator", "--kind", "human"]);
    out.length = 0;
    expect(run(["ask", "story", "1", "ship it?", "--option", "yes=a week", "--option", "no"])).toBe(0);
    expect(said()).toContain("approval #1 waits on ada");
    out.length = 0;
    expect(run(["answer", "1", "yes"])).toBe(0);
    expect(said()).toContain("approval #1 answered yes by ada");
  });

  it("says who could be asked when no operator is named and there is no single one", () => {
    aStory();
    expect(run(["ask", "story", "1", "ship it?"])).toBe(1);
    expect(cried()).toContain("nobody to ask: wecode worker create");
  });

  it("refuses to land a story that is not delivered, by its state", () => {
    aStory();
    expect(run(["land", "1"])).toBe(1);
    expect(cried()).toContain("story #1 is planned. Only a delivered story lands.");
    expect(run(["land", "9"])).toBe(1);
    expect(cried()).toContain("no story #9");
  });

  it("refuses to onboard a directory that is not a git repository", () => {
    const bare = tmp("wecode-bare-");
    const was = process.cwd();
    process.chdir(bare);
    try {
      expect(run(["onboard"])).toBe(1);
      expect(cried()).toContain("this is not a git repository");
    } finally {
      process.chdir(was);
    }
  });

  it("keeps run.ts's own words out of the new module: it parses no argv it was not given", () => {
    // The context is what run.ts lends; the module reads `at.args` and never process.argv.
    expect(source("verbs/run-and-see.ts")).not.toContain("process.argv");
  });

  it("has lost the reading verbs' lines, bodies and re-exports alike", () => {
    const acting = source("verbs/run-and-see.ts");
    // `board`'s body went: the only call of core's board query is see.ts's.
    expect(acting).not.toContain("boardOf");
    expect(acting).not.toContain("export function board(");
    // And the four names it used to forward for the modules of their own.
    for (const gone of ['from "../doctor.js"', 'from "../delivered.js"', 'from "../explore.js"', 'from "../ui.js"']) {
      expect(acting).not.toContain(gone);
    }
  });
});
