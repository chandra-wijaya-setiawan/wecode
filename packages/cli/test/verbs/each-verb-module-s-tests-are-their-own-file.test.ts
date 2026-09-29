import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The cli's tests are cut the way its source is: one file per verb module.
 *
 *  `run.test.ts` had grown to 924 lines proving nine modules at once, and a file that long
 *  is the defect that never fails — it grows a describe at a time. So the four describes
 *  that prove a `verbs/` module moved out, one file each, over the shared harness here.
 *
 *  This is the check that keeps that true: every test file of the cli is at or under the
 *  ceiling unless the ratchet names it, and a row that names one states the length the file
 *  actually is. Both halves matter — a row that is merely generous is a ceiling the tree
 *  stopped matching, which is how `run.test.ts` got to 924 against a row of 578. */

const REPO = resolve(new URL("../../../..", import.meta.url).pathname);
const TESTS = join(REPO, "packages", "cli", "test");
const CONFIG = join(REPO, "packages", "core", "config", "project.yaml");

const config = readFileSync(CONFIG, "utf8");
const ceiling = Number(/^ceiling:\s*(\d+)/m.exec(config)?.[1]);
const rows = new Map(
  config.split("\n").flatMap((l) => {
    const row = /^\s+(\S+):\s*(\d+)\s*$/.exec(l);
    return row === null ? [] : [[(row[1] as string).replace(/^["']|["']$/g, ""), Number(row[2])] as const];
  }),
);

/** Length the way `wc -l` counts it, so a row can be checked by hand against the shell. */
const lines = (file: string): number => {
  const text = readFileSync(file, "utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
};

/** Every `.ts` under `packages/cli/test`, repository-relative, with its length. */
function testFiles(dir: string = TESTS): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [f, n] of testFiles(path)) found.set(f, n);
    else if (entry.name.endsWith(".ts")) found.set(relative(REPO, path).split("\\").join("/"), lines(path));
  }
  return found;
}

describe("every cli test file", () => {
  const files = testFiles();

  it("is at or under the ceiling, unless the ratchet names it", () => {
    const over = [...files].filter(([f, n]) => n > ceiling && !rows.has(f)).map(([f, n]) => `${f}: ${n} over ${ceiling}`);
    expect(over.sort()).toEqual([]);
  });

  it("that the ratchet names is exactly as long as its row says", () => {
    const drift = [...files]
      .filter(([f]) => rows.has(f))
      .filter(([f, n]) => n !== rows.get(f))
      .map(([f, n]) => `${f}: ${n} lines against a row of ${rows.get(f) as number}`);
    expect(drift.sort()).toEqual([]);
  });

  it("has a row only while it is over the ceiling", () => {
    expect([...rows].filter(([f, n]) => files.has(f) && n <= ceiling)).toEqual([]);
  });
});

describe("the cut", () => {
  const files = testFiles();
  const runTest = readFileSync(join(TESTS, "run.test.ts"), "utf8");

  it("gives each verb module's tests their own file under test/verbs", () => {
    const own = ["run-and-see", "see", "tree", "work"].map((v) => `packages/cli/test/verbs/${v}.test.ts`);
    expect(own.filter((f) => !files.has(f))).toEqual([]);
  });

  it("leaves run.test.ts proving none of them, so no describe is cut twice", () => {
    expect(runTest).not.toMatch(/from "\.\.\/src\/verbs\//);
  });

  it("puts run.test.ts back on its row of 578", () => {
    expect(rows.get("packages/cli/test/run.test.ts")).toBe(578);
    expect(files.get("packages/cli/test/run.test.ts")).toBe(578);
  });

  it("states run.ts's row at the 515 the entity split left it", () => {
    expect(rows.get("packages/cli/src/run.ts")).toBe(515);
    expect(lines(join(REPO, "packages", "cli", "src", "run.ts"))).toBe(515);
  });
});
