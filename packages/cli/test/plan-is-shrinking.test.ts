import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  artefacts,
  collisions,
  files,
  needs,
  newModules,
  overlaps,
  OWNERS,
  owners,
  reach,
  runs,
  shared,
  touches,
  workspace,
} from "../src/plan/refusals.js";

/** `plan.ts` is one of the longest files in the tree, and the rules that refuse a plan for
 *  what its scopes and tests say are the largest thing in it that the ledger never touches.
 *  They moved to `plan/refusals.ts` whole. This proves both halves of that: the rules still
 *  refuse what they refused, and the file they left is shorter by the move. */

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (path: string): string => readFileSync(resolve(HERE, "..", path), "utf8");
const lines = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** What `plan.ts` may be. Below the 1281 lines it was before the refusals left it, so the
 *  move cannot be undone quietly; above what it is now, so tidying one more line here is
 *  not a test to edit. */
const BUDGET = 1150;

describe("the refusals left plan.ts", () => {
  it("is shorter than the 1281 lines it was, and under its budget", () => {
    expect(lines(source("src/plan.ts"))).toBeLessThanOrEqual(BUDGET);
  });

  it("puts them in plan/refusals.ts, which meets the ceiling every new file meets", () => {
    expect(lines(source("src/plan/refusals.ts"))).toBeLessThanOrEqual(400);
  });

  it("defines none of them any more, and imports them by name", () => {
    const plan = source("src/plan.ts");
    for (const rule of ["collisions", "owners", "newModules", "shared", "overlaps", "files", "artefacts", "needs", "workspace", "touches", "runs", "reach"]) {
      expect(plan, `plan.ts still defines ${rule}`).not.toContain(`function ${rule}(`);
    }
    expect(plan).toContain(`from "./plan/refusals.js"`);
  });

  it("keeps them out of the ledger — the module opens no database", () => {
    const refusals = source("src/plan/refusals.ts");
    expect(refusals).not.toContain("node:sqlite");
    expect(refusals).not.toContain("dist/db.js");
  });
});

/** The rules themselves, now that they can be called without a whole plan file. One case
 *  per refusal: what it says yes to, and the sentence it says no with. */

const task = (title: string, scope: readonly string[], given = true): { title: string; scope: readonly string[]; given: boolean } => ({ title, scope, given });

const story = (...tasks: readonly ReturnType<typeof task>[]): Parameters<typeof collisions>[0] => ({
  kind: "story",
  id: 1,
  name: "a story",
  children: [],
  requirements: [{ criteria: [{ tasks }] }],
});

describe("two tasks under one story share no path", () => {
  it("names the pair and the path", () => {
    const say: string[] = [];
    collisions(story(task("a", ["src/one.ts"]), task("b", ["src/**"])), say);
    expect(say).toEqual(["story a story: a and b both write src/one.ts and src/**; two tasks under one story share no path"]);
  });

  it("says nothing when the scopes are disjoint", () => {
    const say: string[] = [];
    collisions(story(task("a", ["src/one.ts"]), task("b", ["test/one.test.ts"])), say);
    expect(say).toEqual([]);
  });

  it("judges only the scopes a person wrote", () => {
    const say: string[] = [];
    collisions(story(task("a", ["src/**"], false), task("b", ["src/**"], false)), say);
    expect(say).toEqual([]);
  });
});

describe("which globs can write the same file", () => {
  it("reads a wildcard segment as reaching whatever a name there reaches", () => {
    expect(overlaps("packages/*/src/a.ts", "packages/cli/src/a.ts")).toBe(true);
    expect(overlaps("packages/**", "packages/cli/src/a.ts")).toBe(true);
    expect(overlaps("packages/cli/src/a.ts", "packages/core/src/a.ts")).toBe(false);
    expect(overlaps("packages/cli/src/a.ts", "packages/cli/src")).toBe(false);
  });

  it("names the pair as the file spells it, and one path once", () => {
    expect(shared(["src/a.ts"], ["src/a.ts"])).toBe("src/a.ts");
    expect(shared(["src/a.ts"], ["src/b.ts"])).toBe(null);
  });
});

describe("a new module brings its owner", () => {
  it("counts a literal src file that is not there, and nothing else", () => {
    expect(newModules(["packages/cli/src/plan/new.ts", "packages/cli/src/*.ts", "packages/cli/src/plan.ts", "packages/cli/test/x.test.ts"])).toEqual([
      "packages/cli/src/plan/new.ts",
    ]);
  });

  it("refuses the story when no task under it may write the component map", () => {
    const say: string[] = [];
    owners(story(task("a", ["packages/cli/src/plan/new.ts"])), say);
    expect(say).toEqual([`story a story: a adds packages/cli/src/plan/new.ts, and no task here may write ${OWNERS}`]);
  });

  it("says nothing when some task under it may", () => {
    const say: string[] = [];
    owners(story(task("a", ["packages/cli/src/plan/new.ts"]), task("b", [OWNERS])), say);
    expect(say).toEqual([]);
  });
});

describe("the files a test command names", () => {
  it("is a word with a slash whose last segment has an extension", () => {
    expect(files("pnpm vitest run packages/cli/test/plan.test.ts packages/tui --filter=x")).toEqual(["packages/cli/test/plan.test.ts"]);
  });

  it("refuses one that is not there and that nobody writes", () => {
    const say: string[] = [];
    artefacts("vitest run packages/cli/test/no-such.test.ts", [], "criteria 1", say);
    expect(say).toEqual(["criteria 1: test: no file matches packages/cli/test/no-such.test.ts"]);
  });

  it("allows one some task is scoped to write", () => {
    const say: string[] = [];
    artefacts("vitest run packages/cli/test/no-such.test.ts", ["packages/cli/test/**"], "criteria 1", say);
    expect(say).toEqual([]);
  });

  it("refuses a gate this scope cannot write and that does not carry the statement yet", () => {
    const say: string[] = [];
    artefacts("vitest run packages/cli/test/plan.test.ts", [], "criteria 1", say, ["a statement", "nothing carries"].join(" "));
    expect(say).toEqual(["criteria 1: test: packages/cli/test/plan.test.ts is a gate this scope cannot write"]);
  });

  it("allows a gate already carrying the statement, which is red at base and wants no edit", () => {
    const say: string[] = [];
    artefacts("vitest run packages/cli/test/plan.test.ts", [], "criteria 1", say, "refuses an unknown key, and creates nothing");
    expect(say).toEqual([]);
  });
});

describe("a gate red for another story's reason", () => {
  it("passes a gate whose imports are all on disk", () => {
    const say: string[] = [];
    needs("vitest run packages/cli/test/plan.test.ts", [], "criteria 1", say);
    expect(say).toEqual([]);
  });
});

describe("a task that cannot change its own verdict", () => {
  it("knows the workspace's packages from pnpm-workspace.yaml", () => {
    const found = workspace(process.cwd());
    expect(found.map((p) => p.dir)).toContain("packages/cli");
    expect(found.find((p) => p.dir === "packages/cli")?.name).toBe("@wecode/cli");
  });

  it("reads the packages a command runs, by path and by --filter", () => {
    const packages = [
      { dir: "packages/cli", name: "@wecode/cli" },
      { dir: "packages/core", name: "@wecode/core" },
    ];
    expect(runs("vitest run packages/cli/test/plan.test.ts", packages)).toEqual(["packages/cli"]);
    expect(runs("pnpm --filter @wecode/core test", packages)).toEqual(["packages/core"]);
  });

  it("asks whether a scope glob reaches into a directory at all", () => {
    expect(touches("packages/**", "packages/cli")).toBe(true);
    expect(touches("packages/cli/src/**", "packages/cli")).toBe(true);
    expect(touches("packages/core/src/**", "packages/cli")).toBe(false);
  });

  it("refuses a test that runs a package this scope cannot reach", () => {
    const say: string[] = [];
    reach("vitest run packages/core/test/board.test.ts", ["packages/cli/src/**"], "task 1", say);
    expect(say).toEqual(["task 1: test: runs packages/core, which this scope cannot reach"]);
  });

  it("says nothing when it can", () => {
    const say: string[] = [];
    reach("vitest run packages/cli/test/plan.test.ts", ["packages/cli/**"], "task 1", say);
    expect(say).toEqual([]);
  });
});
