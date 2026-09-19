import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every file in this repository has a ceiling on its length.
 *
 *  A long file is the one defect that never shows up as a failing test: it grows a line at
 *  a time and nobody is ever the person who made it long. So the length is a number in
 *  configuration — `packages/core/config/project.yaml` — and this is the check that reads
 *  it back against the tree.
 *
 *  The files that were already over the ceiling the day it was set are not rewritten here.
 *  They are ratcheted: each has a row recording exactly how long it was, and the row is a
 *  cap that only ever comes down. Shorten such a file and its row must come down with it;
 *  take it under the ceiling and the row goes. That is what makes this a ratchet rather
 *  than a list of permanent exemptions — the tree can only get shorter.
 *
 *  Read by hand rather than through a yaml parser, the way `declaredSurface` reads the
 *  surface: the cli package depends on core and the explorer and on nothing else, and one
 *  scalar plus one flat mapping is the whole grammar this needs. */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONFIG = join(REPO, "packages", "core", "config", "project.yaml");
const EXTENSIONS = [".ts", ".tsx"] as const;

interface Ceilings {
  /** What a file may be, when the ratchet does not name it. */
  readonly ceiling: number;
  /** The ratchet: a file that was already longer, and how long it was. */
  readonly over: ReadonlyMap<string, number>;
}

function readCeilings(text: string): Ceilings {
  const lines = text.split("\n");
  const said = lines.find((l) => /^ceiling:/.test(l));
  const ceiling = said === undefined ? 0 : Number(said.slice("ceiling:".length).trim());
  const at = lines.findIndex((l) => l.trimEnd() === "over:");
  const over = new Map<string, number>();
  if (at !== -1) {
    for (const line of lines.slice(at + 1)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const row = /^\s+(\S+):\s*(\d+)\s*$/.exec(line);
      if (row === null) break;
      over.set((row[1] ?? "").replace(/^["']|["']$/g, ""), Number(row[2]));
    }
  }
  return { ceiling, over };
}

/** What is wrong with the tree, one sentence per file, empty when nothing is. Both
 *  directions are faults: a file over its cap, and a cap the file no longer needs. */
function overCeiling(lengths: ReadonlyMap<string, number>, ceilings: Ceilings): readonly string[] {
  const said: string[] = [];
  for (const [file, length] of [...lengths].sort()) {
    const capped = ceilings.over.get(file);
    if (capped === undefined) {
      if (length > ceilings.ceiling) said.push(`${file}: ${length} lines, over the ceiling of ${ceilings.ceiling}`);
      continue;
    }
    if (length > capped) said.push(`${file}: ${length} lines, over its ratchet of ${capped}`);
    else if (length <= ceilings.ceiling) said.push(`${file}: ${length} lines, under the ceiling — drop its ratchet row`);
    else if (length < capped) said.push(`${file}: ${length} lines — lower its ratchet row from ${capped}`);
  }
  for (const file of ceilings.over.keys()) {
    if (!lengths.has(file)) said.push(`${file}: ratcheted, but there is no such file`);
  }
  return said;
}

/** Every source and test module in the workspace, repository-relative, with its length.
 *  Length is counted the way `wc -l` counts it, so a row of the ratchet can be checked by
 *  hand against the same number the shell prints. */
function tree(): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  const packages = join(REPO, "packages");
  for (const pkg of readdirSync(packages)) {
    for (const kind of ["src", "test"]) {
      const dir = join(packages, pkg, kind);
      if (!exists(dir)) continue;
      walk(dir, (file) => found.set(relative(REPO, file).split("\\").join("/"), lines(readFileSync(file, "utf8"))));
    }
  }
  return found;
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

const lines = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

describe("the ceiling, declared in configuration", () => {
  const config = readFileSync(CONFIG, "utf8");

  it("is a number in packages/core/config/project.yaml, so shortening the tree is not a code change", () => {
    expect(readCeilings(config).ceiling).toBeGreaterThan(0);
  });

  it("reads a scalar and a flat mapping, comments allowed", () => {
    const text = ["# a ceiling", "ceiling: 40", "over:", "  # already long", "  a/long.ts: 90", '  "b/longer.ts": 120', "", "stack: pnpm"].join("\n");
    const read = readCeilings(text);
    expect(read.ceiling).toBe(40);
    expect([...read.over]).toEqual([
      ["a/long.ts", 90],
      ["b/longer.ts", 120],
    ]);
  });

  it("ratchets nothing when the key is absent, which reports drift rather than hiding it", () => {
    expect([...readCeilings("ceiling: 40\n").over]).toEqual([]);
  });
});

describe("what the ceiling refuses", () => {
  const ceilings: Ceilings = { ceiling: 40, over: new Map([["a/long.ts", 90]]) };

  /** A tree where the one ratcheted file sits at its recorded length, plus whatever the
   *  case is about. Stated whole each time: the check is about a tree, and a file missing
   *  from it is itself a fault. */
  const treeOf = (file: string, length: number): ReadonlyMap<string, number> =>
    new Map([
      ["a/long.ts", 90],
      [file, length],
    ]);

  it("passes a file under the ceiling", () => {
    expect(overCeiling(treeOf("a/short.ts", 40), ceilings)).toEqual([]);
  });

  it("refuses a file over the ceiling that nothing ratchets", () => {
    expect(overCeiling(treeOf("a/new.ts", 41), ceilings)).toEqual(["a/new.ts: 41 lines, over the ceiling of 40"]);
  });

  it("passes a ratcheted file at its recorded length", () => {
    expect(overCeiling(treeOf("a/long.ts", 90), ceilings)).toEqual([]);
  });

  it("refuses a ratcheted file that grew, so the ratchet only turns one way", () => {
    expect(overCeiling(treeOf("a/long.ts", 91), ceilings)).toEqual(["a/long.ts: 91 lines, over its ratchet of 90"]);
  });

  it("refuses a ratchet row left behind by a file that shrank", () => {
    expect(overCeiling(treeOf("a/long.ts", 80), ceilings)).toEqual(["a/long.ts: 80 lines — lower its ratchet row from 90"]);
  });

  it("refuses a ratchet row for a file that is now under the ceiling", () => {
    expect(overCeiling(treeOf("a/long.ts", 40), ceilings)).toEqual(["a/long.ts: 40 lines, under the ceiling — drop its ratchet row"]);
  });

  it("refuses a ratchet row for a file that is gone", () => {
    expect(overCeiling(new Map(), ceilings)).toEqual(["a/long.ts: ratcheted, but there is no such file"]);
  });
});

describe("this repository", () => {
  const ceilings = readCeilings(readFileSync(CONFIG, "utf8"));
  const lengths = tree();

  it("has a file to measure", () => {
    expect(lengths.size).toBeGreaterThan(50);
  });

  it("keeps every file at or under its ceiling, and every ratchet row tight", () => {
    expect(overCeiling(lengths, ceilings)).toEqual([]);
  });
});
