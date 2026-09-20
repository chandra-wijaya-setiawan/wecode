import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The tick's phases, one module each under `src/tick`.
 *
 *  What each phase *does* is pinned by the end-to-end ticks in `daemon.test.ts` and by the
 *  phase's own older test; what is pinned here is the shape of the move — that it happened,
 *  that it took the phase whole, and that nothing else went with it. That is a read of the
 *  source text and of nothing else, so this file needs no repository and no ledger. */

const src = (module: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${module}`, import.meta.url)), "utf8");

/** The source with its prose taken out. `daemon.ts` still talks about the phases it no
 *  longer holds, so every assertion below is made against the code. */
const code = (module: string): string =>
  src(module).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const exportsOf = (module: string): string[] =>
  [...code(module).matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

/** The reads a phase shares with the rest of the runner stay the runner's: they are handed
 *  in, not copied. A second copy of any of them in the new module is the defect. */
const borrows = (module: string, shared: readonly string[]): void => {
  const moved = code(module);
  for (const name of shared) {
    expect(moved, `${name} is declared again in ${module}`).not.toMatch(
      new RegExp(`(?:function|const)\\s+${name}\\b`),
    );
    expect(moved, `${name} is not handed in`).toContain(`host.${name}`);
  }
  // One definition of the columns, not two: the table descriptors are imported back.
  expect(moved).toMatch(/import \{ [\w, ]*tbl.*\} from "\.\.\/daemon\.js"/);
  expect(moved).not.toContain("table<");
};

/** Every phase the daemon still owns is still a private method on it. Each phase's own
 *  describe names the others, so a second phase leaving on the back of the first is red. */
const staysInTheDaemon = (phases: readonly string[]): void => {
  const left = code("daemon.ts");
  for (const phase of phases) {
    expect(left, `${phase} left daemon.ts`).toMatch(new RegExp(`private (?:async )?${phase}\\(`));
  }
};

describe("the red-at-base phase is a module of its own", () => {
  it("exports one function, and it is the phase", () => {
    expect(exportsOf("tick/red-at-base.ts")).toEqual(["proveRedAtBase"]);
    // The one function, and the two types that say what it answers and what it needs.
    expect([...code("tick/red-at-base.ts").matchAll(/^export /gm)]).toHaveLength(3);
  });

  it("took the two helpers whole, and left neither behind", () => {
    const moved = code("tick/red-at-base.ts");
    expect(moved).toMatch(/function mergeBase\(/);
    expect(moved).toMatch(/function runAtBase\(/);
    expect(moved).toContain(`exec("git", ["merge-base", a, b]`);
    expect(moved).toContain(`exec("git", ["checkout", "--detach", "-q", at.base]`);
    expect(moved).toContain(`exec("git", ["reset", "--hard", "-q", at.base]`);

    const left = code("daemon.ts");
    expect(left).not.toMatch(/\bmergeBase\b/);
    expect(left).not.toMatch(/\brunAtBase\b/);
    expect(left).not.toContain("--detach");
    expect(left).not.toContain(`"reset"`);
    // `contains` asks `merge-base --is-ancestor` for a different phase, and has since left
    // for `tick/refresh.ts`: the verb is shared, so neither helper took the other along.
    expect(left).not.toContain(`["merge-base", a, b]`);
    expect(code("tick/refresh.ts")).toContain(`["merge-base", "--is-ancestor", base, branch]`);
  });

  it("is called from the daemon where the daemon called it", () => {
    const left = code("daemon.ts");
    expect(left).toContain(`import { proveRedAtBase, type RedAtBase } from "./tick/red-at-base.js"`);
    // The one call site in `tick()` is untouched, and the one wrapper is what it now reaches.
    expect(left.match(/this\.proveRedAtBase\(\)/g)).toHaveLength(1);
    expect(left.match(/\breturn proveRedAtBase\(\{/g)).toHaveLength(1);
    expect(left).toMatch(/const redAtBase = await this\.proveRedAtBase\(\);/);
  });

  it("borrows the runner's ledger reads rather than copying them", () => {
    borrows("tick/red-at-base.ts", [
      "storyOfCriteria",
      "projectOf",
      "ranAtBase",
      "recordBaseRun",
      "treesFor",
      "worktreeRoot",
    ]);
  });

  it("moves no other phase", () => {
    staysInTheDaemon([
      "landDeliveredStories",
      "allocateOne",
      "settleEnded",
      "landDoneTasks",
      "storyChoresPass",
      "enforceRetryLimit",
      "ranAtBase",
      "recordBaseRun",
    ]);
  });
});

describe("the story-proving phase is a module of its own", () => {
  it("exports one function, and it is the phase", () => {
    expect(exportsOf("tick/prove-stories.ts")).toEqual(["proveStories"]);
    // The one function, and the two types that say what it answers and what it needs.
    expect([...code("tick/prove-stories.ts").matchAll(/^export /gm)]).toHaveLength(3);
  });

  it("took the two helpers whole, and left neither behind", () => {
    const moved = code("tick/prove-stories.ts");
    expect(moved).toMatch(/function refreshStoryTree\(/);
    expect(moved).toMatch(/function midMerge\(/);
    expect(moved).toContain(`"merge", "--no-ff", "-q"`);
    expect(moved).toContain(`exec("git", ["merge", "--abort"]`);
    expect(moved).toContain(`"MERGE_HEAD"`);
    // The refresh's own constant came with it; nothing else reads it.
    expect(moved).toContain("const REFRESH_OPEN");

    const left = code("daemon.ts");
    for (const gone of ["refreshStoryTree", "midMerge", "MERGE_HEAD", "REFRESH_OPEN", "--no-ff", "--abort"]) {
      expect(left, `${gone} stayed in daemon.ts`).not.toContain(gone);
    }
  });

  it("is called from the daemon where the daemon called it", () => {
    const left = code("daemon.ts");
    expect(left).toContain(`import { proveStories, type Proven } from "./tick/prove-stories.js"`);
    // The one call site in `tick()` is untouched in its place, and the one wrapper is what
    // it now reaches.
    expect(left.match(/\breturn proveStories\(\{/g)).toHaveLength(1);
    expect(left).toMatch(/const acceptance = await this\.storyProvingPass\(\);/);
    expect(left.match(/this\.storyProvingPass\(\)/g)).toHaveLength(1);
    // And the phases either side of it in `tick()` did not move with it.
    expect(left).toMatch(/const landings = await this\.landDoneTasks\(\);/);
    expect(left).toMatch(/await this\.storyChoresPass\(acceptance\.behind\)/);
  });

  it("borrows the runner's ledger, trees and graph reads rather than copying them", () => {
    borrows("tick/prove-stories.ts", [
      "storyOfCriteria",
      "projectOf",
      "treesFor",
      "worktreeRoot",
      "hasCommit",
      "contains",
      "runAcceptanceTests",
    ]);
    // One definition of the shapes the tick reports, not two.
    expect(code("tick/prove-stories.ts")).not.toMatch(/interface (?:Behind|Waiting)\b/);
  });
});

describe("the story-chores phase is a module of its own", () => {
  it("exports one function, and it is the phase", () => {
    expect(exportsOf("tick/story-chores.ts")).toEqual(["raiseStoryChores"]);
    // The one function, and the one type that says what it needs. What it answers is a
    // list of chore ids, which needs no shape of its own.
    expect([...code("tick/story-chores.ts").matchAll(/^export /gm)]).toHaveLength(2);
  });

  it("took the two helpers whole, and left neither behind", () => {
    const moved = code("tick/story-chores.ts");
    expect(moved).toMatch(/function followRefresh\(/);
    expect(moved).toMatch(/function isBehind\(/);
    // The rules those helpers carry came with them, not just their names.
    expect(moved).toContain(`"the base is an ancestor of the branch"`);
    expect(moved).toContain(`"the branch merges cleanly"`);
    expect(moved).toContain("is up to date with");

    const left = code("daemon.ts");
    for (const gone of ["followRefresh", "isBehind", "the base is an ancestor", "the branch merges cleanly"]) {
      expect(left, `${gone} stayed in daemon.ts`).not.toContain(gone);
    }
  });

  it("is called from the daemon where the daemon called it", () => {
    const left = code("daemon.ts");
    expect(left).toContain(`import { raiseStoryChores } from "./tick/story-chores.js"`);
    // The one call site in `tick()` is untouched in its place, and the one wrapper is what
    // it now reaches.
    expect(left.match(/\breturn raiseStoryChores\(/g)).toHaveLength(1);
    expect(left).toMatch(/const chores = await this\.storyChoresPass\(acceptance\.behind\);/);
    expect(left.match(/this\.storyChoresPass\(/g)).toHaveLength(1);
    // And the phases either side of it in `tick()` did not move with it.
    expect(left).toMatch(/const acceptance = await this\.storyProvingPass\(\);/);
    expect(left).toMatch(/const performed = await this\.performChores\(paused\);/);
  });

  it("borrows the runner's ledger, trees and graph reads rather than copying them", () => {
    // A second copy of `mergesCleanly` — which shells out to a trial merge in a scratch
    // tree — would be the defect this asserts against.
    borrows("tick/story-chores.ts", ["projectOf", "treesFor", "hasCommit", "contains", "mergesCleanly", "orphanedBy"]);
    expect(code("tick/story-chores.ts")).not.toMatch(/interface Behind\b/);
  });

  it("moves no other phase", () => {
    staysInTheDaemon([
      "landDeliveredStories",
      "allocateOne",
      "settleEnded",
      "landDoneTasks",
      "performChores",
      "enforceRetryLimit",
      "mergesCleanly",
      "orphanedBy",
    ]);
  });
});

describe("the attempt-judging phase is a module of its own", () => {
  it("exports one function, and it is the phase", () => {
    expect(exportsOf("tick/settle.ts")).toEqual(["settleEnded"]);
    // The one function, and the two types that say what it answers and what it needs.
    expect([...code("tick/settle.ts").matchAll(/^export /gm)]).toHaveLength(3);
  });

  it("took the refund rule whole, and left it behind nowhere", () => {
    const moved = code("tick/settle.ts");
    expect(moved).toMatch(/function refundAttempt\(/);
    // The rule the helper carries came with it, not just its name: the refund is owed once
    // per branch tip, which is the read of the assignments after the last committed one.
    expect(moved).toContain("findLastIndex");
    expect(moved).toContain(`set({ attempts: t.attempts - 1 })`);
    // And the pass's own two writes: the attempt's commit, and the sha on the assignment.
    expect(moved).toContain("commitAttempt");
    expect(moved).toContain(`set({ commit_sha: sha })`);

    const left = code("daemon.ts");
    for (const gone of ["refundAttempt", "commitAttempt", "findLastIndex", "attempts - 1"]) {
      expect(left, `${gone} stayed in daemon.ts`).not.toContain(gone);
    }
  });

  it("is called from the daemon where the daemon called it", () => {
    const left = code("daemon.ts");
    expect(left).toContain(`import { settleEnded, type Settled } from "./tick/settle.js"`);
    // The one call site in `tick()` is untouched in its place, and the one wrapper is what
    // it now reaches.
    expect(left.match(/\breturn settleEnded\(/g)).toHaveLength(1);
    expect(left).toMatch(/const settled = await this\.settleEnded\(\);/);
    expect(left.match(/this\.settleEnded\(/g)).toHaveLength(1);
    // And the phases either side of it in `tick()` did not move with it.
    expect(left).toMatch(/const settled2 = this\.engine\.settle\(\);/);
  });

  it("borrows the runner's ledger, trees and examiner rather than copying them", () => {
    // A second copy of `slugsFor` — which walks the ERD from a task up to its project's
    // repo — would be the defect this asserts against.
    borrows("tick/settle.ts", ["slugsFor", "treesFor", "runTaskTests"]);
    expect(code("tick/settle.ts")).not.toMatch(/interface ScriptReport\b/);
  });

  it("moves no other phase", () => {
    staysInTheDaemon([
      "landDeliveredStories",
      "allocateOne",
      "landDoneTasks",
      "performChores",
      "enforceRetryLimit",
      "storyChoresPass",
      "storyProvingPass",
      "proveRedAtBase",
      "slugsFor",
    ]);
  });
});
