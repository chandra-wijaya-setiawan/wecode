import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** How long a file may be is one number, and it lives in one place.
 *
 *  `packages/core/config/project.yaml` carries the ceiling every file meets and the ratchet
 *  row for every file that was already longer. A test that writes its own number for a
 *  source file — `const BUDGET = 1150` — is a second copy of that policy: it goes stale the
 *  day the row moves, and the person who owns the tree has to open a `.ts` to change what
 *  the tree may be.
 *
 *  So this check does two things. It reads every bar out of the configuration and holds the
 *  named files to it, counting the way `a-file-has-a-ceiling` counts. And it refuses a test
 *  that sets a bar of its own: a test may measure a source module against a number only
 *  when it got the number from `project.yaml`. */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONFIG = join(REPO, "packages", "core", "config", "project.yaml");
const CONFIG_PATH = "packages/core/config/project.yaml";
const EXTENSIONS = [".ts", ".tsx"] as const;

const lines = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

interface Bars {
  /** What a file may be, when no row names it. */
  readonly ceiling: number;
  /** One row per file that was already longer, and how long it was. */
  readonly over: ReadonlyMap<string, number>;
}

/** Read by hand, the same scalar-plus-flat-mapping grammar `a-file-has-a-ceiling` reads. */
function readBars(text: string): Bars {
  const rows = text.split("\n");
  const said = rows.find((l) => /^ceiling:/.test(l));
  const ceiling = said === undefined ? 0 : Number(said.slice("ceiling:".length).trim());
  const at = rows.findIndex((l) => l.trimEnd() === "over:");
  const over = new Map<string, number>();
  if (at !== -1) {
    for (const line of rows.slice(at + 1)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const row = /^\s+(\S+):\s*(\d+)\s*$/.exec(line);
      if (row === null) break;
      over.set((row[1] ?? "").replace(/^["']|["']$/g, ""), Number(row[2]));
    }
  }
  return { ceiling, over };
}

/** What each named file may be: its row when it has one, the ceiling otherwise. */
const barFor = (file: string, bars: Bars): number => bars.over.get(file) ?? bars.ceiling;

/** Which named files are over the bar configuration sets for them, one sentence each. */
function overTheirBars(lengths: ReadonlyMap<string, number>, bars: Bars): readonly string[] {
  const said: string[] = [];
  for (const [file, length] of [...lengths].sort()) {
    const bar = barFor(file, bars);
    if (length > bar) said.push(`${file}: ${length} lines, over the ${bar} ${CONFIG_PATH} allows it`);
  }
  return said;
}

/** A size bar a test set for itself: a number this file compares a source module's length
 *  against. Nothing is a bar unless the file both counts the lines of a `src/` module and
 *  measures that count against a number it wrote down of ten or more — a count of rows, an
 *  exit code or a handful of anything is not a size bar. A number the file read out of
 *  `project.yaml` is not one either; that is the policy, not a copy of it. */
function ownBars(text: string): readonly string[] {
  if (text.includes(CONFIG_PATH)) return [];
  if (!/\.split\(["'`]\\n["'`]\)/.test(text)) return [];
  if (!/["'`][^"'`]*src\/[^"'`]*\.tsx?["'`]/.test(text)) return [];
  const found: string[] = [];
  for (const match of text.matchAll(/\.toBe(?:Less|Greater)Than(?:OrEqual)?\(\s*([A-Za-z_$][\w$]*|\d+)\s*\)/g)) {
    const said = match[1] ?? "";
    if (/^\d+$/.test(said)) {
      if (Number(said) >= 10) found.push(said);
      continue;
    }
    const declared = new RegExp(`\\b(?:const|let|var)\\s+${said}\\s*(?::[^=\\n]*)?=\\s*(\\d+)`).exec(text);
    if (declared !== null && Number(declared[1]) >= 10) found.push(`${said} = ${declared[1] ?? ""}`);
  }
  return found;
}

/** Every test module in the workspace, repository-relative. */
function tests(): readonly string[] {
  const found: string[] = [];
  const packages = join(REPO, "packages");
  for (const pkg of readdirSync(packages)) {
    const dir = join(packages, pkg, "test");
    if (!exists(dir)) continue;
    walk(dir, (file) => found.push(relative(REPO, file).split("\\").join("/")));
  }
  return found.sort();
}

const exists = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

function walk(dir: string, seen: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, seen);
    else if (EXTENSIONS.some((e) => entry.name.endsWith(e))) seen(path);
  }
}

describe("the bars, read out of configuration", () => {
  const text = ["ceiling: 40", "over:", "  a/long.ts: 90", '  "b/longer.ts": 120', "", "stack: pnpm"].join("\n");

  it("is a ceiling and a row per file that was already longer", () => {
    const bars = readBars(text);
    expect(bars.ceiling).toBe(40);
    expect([...bars.over]).toEqual([
      ["a/long.ts", 90],
      ["b/longer.ts", 120],
    ]);
  });

  it("gives a named file its row, and every other file the ceiling", () => {
    const bars = readBars(text);
    expect(barFor("a/long.ts", bars)).toBe(90);
    expect(barFor("a/short.ts", bars)).toBe(40);
  });

  it("holds a file to the bar configuration sets for it", () => {
    const bars = readBars(text);
    expect(overTheirBars(new Map([["a/long.ts", 90]]), bars)).toEqual([]);
    expect(overTheirBars(new Map([["a/long.ts", 91]]), bars)).toEqual([
      `a/long.ts: 91 lines, over the 90 ${CONFIG_PATH} allows it`,
    ]);
    expect(overTheirBars(new Map([["a/short.ts", 41]]), bars)).toEqual([
      `a/short.ts: 41 lines, over the 40 ${CONFIG_PATH} allows it`,
    ]);
  });

  it("counts the way wc -l counts, so a row can be checked by hand", () => {
    expect(lines("a\nb\n")).toBe(2);
    expect(lines("a\nb")).toBe(2);
  });
});

describe("a test that sets its own size bar", () => {
  /** The shape the old `plan-is-shrinking` had: read a module, count it, hold it to a
   *  number written here. */
  const shrinking = (bar: string): string =>
    [
      `const source = readFileSync("packages/one/src/long.ts", "utf8");`,
      `const count = (t: string): number => t.split("\\n").length;`,
      `const BUDGET = 1150;`,
      `it("is short", () => { expect(count(source)).toBeLessThanOrEqual(${bar}); });`,
    ].join("\n");

  it("names the number when it is written in the assertion", () => {
    expect(ownBars(shrinking("1150"))).toEqual(["1150"]);
  });

  it("names the number when the assertion hides it behind a constant", () => {
    expect(ownBars(shrinking("BUDGET"))).toEqual(["BUDGET = 1150"]);
  });

  it("says nothing when the number came out of the configuration", () => {
    const reading = [`const bar = readBars(readFileSync("${CONFIG_PATH}", "utf8"));`, shrinking("bar")].join("\n");
    expect(ownBars(reading)).toEqual([]);
  });

  it("says nothing about a handful, which is a count and not a bar", () => {
    expect(ownBars(shrinking("2"))).toEqual([]);
  });

  it("says nothing when the number is not a length", () => {
    const counting = [
      `const rows = readFileSync("packages/one/src/long.ts", "utf8").split("|");`,
      `it("has rows", () => { expect(rows.length).toBeGreaterThan(3); });`,
    ].join("\n");
    expect(ownBars(counting)).toEqual([]);
  });

  it("says nothing when the count is not of a source module", () => {
    const output = [
      `const said = run("wecode plan").split("\\n");`,
      `it("says a lot", () => { expect(said.length).toBeGreaterThan(10); });`,
    ].join("\n");
    expect(ownBars(output)).toEqual([]);
  });
});

describe("this repository", () => {
  const bars = readBars(readFileSync(CONFIG, "utf8"));
  const files = tests();

  it("has tests to read", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("keeps every file configuration names at or under the bar it sets", () => {
    const lengths = new Map([...bars.over.keys()].map((file) => [file, lines(readFileSync(join(REPO, file), "utf8"))]));
    expect(overTheirBars(lengths, bars)).toEqual([]);
  });

  it("has no test that sets a size bar of its own", () => {
    const said = files
      .map((file) => ({ file, own: ownBars(readFileSync(join(REPO, file), "utf8")) }))
      .filter(({ own }) => own.length > 0)
      .map(({ file, own }) => `${file}: sets its own size bar (${own.join(", ")}); put it in ${CONFIG_PATH}`);
    expect(said).toEqual([]);
  });
});
