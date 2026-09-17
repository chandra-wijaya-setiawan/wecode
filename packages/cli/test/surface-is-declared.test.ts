import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UnknownFile, UnknownSymbol, type Purpose, type Reading, type RepoIndex, type Use } from "@wecode/explorer";
import { declaredSurface, unimportedExports } from "../src/unimported.js";

/** This repository's own root — the checkout carrying the `config/project.yaml` under test.
 *  Found from this file rather than from `process.cwd()`, which is the vitest root and not
 *  the same directory when a package runs its own suite. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROJECT = readFileSync(join(REPO, "config", "project.yaml"), "utf8");

describe("the surface, declared in configuration", () => {
  it("is in config/project.yaml, so adding an entry point is not a code change", () => {
    expect(PROJECT).toContain("\nsurface:\n");
    expect(declaredSurface(PROJECT).size).toBeGreaterThan(0);
  });

  it("names a module that is really there, for every entry it declares", () => {
    const missing = [...declaredSurface(PROJECT)].filter((f) => !existsSync(join(REPO, f)));
    expect(missing).toEqual([]);
  });

  it("covers every package the workspace publishes, entry point and binary alike", () => {
    const surface = declaredSurface(PROJECT);
    for (const pkg of ["core", "explorer", "runner", "cli", "tui"]) {
      const declared = [...surface].filter((f) => f.startsWith(`packages/${pkg}/src/`));
      expect(declared, `packages/${pkg} declares no surface`).not.toEqual([]);
    }
  });

  it("reads a flat sequence and stops at the next key, quotes and comments allowed", () => {
    const text = ["tests:\n  - test/**", "surface:", "  # the entry point", '  - "a/index.ts"', "  - b/bin.ts", "", "stack: pnpm"].join("\n");
    expect([...declaredSurface(text)]).toEqual(["a/index.ts", "b/bin.ts"]);
  });

  it("declares nothing when the key is absent, which reports drift rather than hiding it", () => {
    expect([...declaredSurface("stack: pnpm\n")]).toEqual([]);
  });
});

/** A fixture repository, as the port answers about it.
 *
 *  No files and no parser: the check asks the port three questions and this is the port's
 *  three answers, written down. That is the point of the port — the invariant is a claim
 *  about the answers, not about a language.
 *
 *    src/index.ts     the declared surface. Publishes `boot` and, through `export * from
 *                     "./part.js"`, `PART` and `SPARE`. A star re-export is not an import
 *                     statement, so `read()` reports only the one import it has.
 *    src/assemble.ts  imported by the surface, and the one importer of `PART` by name
 *    src/part.ts      `PART` is imported; `SPARE` is published by the surface and by
 *                     nothing else at all
 *    src/greet.ts     behind the surface, but `HELPER` is not published by it
 *    src/dead.ts      unreachable from the surface, and exports a `SPARE` of its own
 */
const READINGS: Readonly<Record<string, Reading>> = {
  "src/index.ts": {
    file: "src/index.ts",
    defines: [{ name: "boot", kind: "function", line: 3, exported: true, doc: null }],
    imports: [{ name: "assemble", kind: "named", from: "./assemble.js", resolved: "src/assemble.ts" }],
  },
  "src/assemble.ts": {
    file: "src/assemble.ts",
    defines: [{ name: "assemble", kind: "function", line: 3, exported: true, doc: null }],
    imports: [
      { name: "PART", kind: "named", from: "./part.js", resolved: "src/part.ts" },
      { name: "greet", kind: "named", from: "./greet.js", resolved: "src/greet.ts" },
    ],
  },
  "src/part.ts": {
    file: "src/part.ts",
    defines: [
      { name: "PART", kind: "variable", line: 1, exported: true, doc: null },
      { name: "SPARE", kind: "variable", line: 2, exported: true, doc: null },
    ],
    imports: [],
  },
  "src/greet.ts": {
    file: "src/greet.ts",
    defines: [
      { name: "HELPER", kind: "variable", line: 1, exported: true, doc: null },
      { name: "greet", kind: "function", line: 2, exported: true, doc: null },
    ],
    imports: [],
  },
  "src/dead.ts": {
    file: "src/dead.ts",
    defines: [{ name: "SPARE", kind: "variable", line: 1, exported: true, doc: null }],
    imports: [],
  },
};

/** What each module offers, re-exports included — the surface publishes `part.ts`'s names
 *  as its own, which is what `export * from` means and what `purposeOf` reports. */
const EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/index.ts": ["PART", "SPARE", "boot"],
  "src/assemble.ts": ["assemble"],
  "src/part.ts": ["PART", "SPARE"],
  "src/greet.ts": ["HELPER", "greet"],
  "src/dead.ts": ["SPARE"],
};

const FILES = [...Object.keys(READINGS), "README.md"];

class Written implements RepoIndex {
  readonly root = "/fixture";

  async read(file: string): Promise<Reading> {
    const reading = READINGS[file];
    if (reading === undefined) throw new UnknownFile(file, this.root);
    return reading;
  }

  async purposeOf(file: string): Promise<Purpose> {
    const exports = EXPORTS[file];
    if (exports === undefined) throw new UnknownFile(file, this.root);
    const dependents = Object.values(READINGS)
      .filter((r) => r.imports.some((i) => i.resolved === file))
      .map((r) => r.file);
    return { file, doc: null, exports, dependents: dependents.sort() };
  }

  /** Where a name is written, other than where it is declared. Nothing in this fixture
   *  mentions a name it does not import, so the only uses are the import sites — which is
   *  what makes the surface the only thing that can acquit `SPARE`. */
  async usesOf(file: string, symbol: string): Promise<readonly Use[]> {
    const declared = READINGS[file]?.defines.find((d) => d.name === symbol);
    if (declared === undefined) throw new UnknownSymbol(file, symbol);
    return Object.values(READINGS)
      .filter((r) => r.imports.some((i) => i.resolved === file && i.name === symbol))
      .map((r) => ({ file: r.file, line: 1, column: 1 }));
  }
}

const tree = (surface: readonly string[]) => ({ index: new Written(), files: FILES, surface: new Set(surface) });

const named = async (surface: readonly string[]): Promise<readonly string[]> =>
  (await unimportedExports(tree(surface))).map((v) => `${v.slug} ${v.detail}`);

const SURFACE = ["src/index.ts"];

describe("exports reachable from the declared surface", () => {
  it("are not reported, because a name the surface publishes is published", async () => {
    expect((await named(SURFACE)).join("\n")).not.toContain("src/part.ts");
  });

  it("are reported when the surface does not declare them, which is the same check as before", async () => {
    expect(await named([])).toContain("src/part.ts exports SPARE, which nothing in the repository imports");
  });

  it("do not acquit a namesake the surface cannot reach", async () => {
    // `dead.ts` exports a `SPARE` too. Publishing a name says nothing about a module the
    // surface never reaches, or every unreachable file could hide behind the barrel.
    expect(await named(SURFACE)).toContain("src/dead.ts exports SPARE, which nothing in the repository imports");
  });

  it("do not acquit an unpublished name in a module the surface reaches", async () => {
    // `greet.ts` is behind the entry point, but `HELPER` is not on the surface and nothing
    // imports it. Reachability alone would exempt every internal helper in the tree.
    expect(await named(SURFACE)).toContain("src/greet.ts exports HELPER, which nothing in the repository imports");
  });

  it("finds those two and nothing else, the surface itself included", async () => {
    expect(await named(SURFACE)).toEqual([
      "src/dead.ts exports SPARE, which nothing in the repository imports",
      "src/greet.ts exports HELPER, which nothing in the repository imports",
    ]);
  });

  it("says nothing about a file the index does not hold", async () => {
    expect((await named(SURFACE)).join("\n")).not.toContain("README.md");
  });
});
