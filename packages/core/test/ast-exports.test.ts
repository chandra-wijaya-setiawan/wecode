import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readExports, type ExportedSymbol } from "../src/ast.js";
import { tmp } from "./tmpdir.js";
import { spawn } from "node:child_process";

/** Runs `body` with the host deliberately busy, so a verdict reached here is the verdict the
 *  test means rather than one that only holds on an idle machine. */
async function underLoad<T>(body: () => Promise<T> | T): Promise<T> {
  const spin = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ["-e", "for (;;) Math.sqrt(Math.random());"], { stdio: "ignore" }),
  );
  try {
    return await body();
  } finally {
    for (const p of spin) p.kill("SIGKILL");
  }
}

/** Nothing here means a duration: every assertion is about what the parse says, so the test
 *  waits for the parse to finish however loaded the host is. A deadline would only turn a
 *  busy machine into a failure. */
vi.setConfig({ testTimeout: 0, hookTimeout: 0 });

/** Writes `files` into a fresh directory and returns the path of the first one, which is
 *  the module under test. */
function module(files: Record<string, string>): string {
  const dir = tmp("wecode-ast-");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const first = Object.keys(files)[0];
  return join(dir, first as string);
}

const kinds = (exports: ExportedSymbol[]): Record<string, string> =>
  Object.fromEntries(exports.map((e) => [e.name, e.kind]));

describe("readExports", () => {
  it("names each exported declaration and its kind", () => {
    const file = module({
      "a.ts": `
        export function fn(): void {}
        export class Cls {}
        export interface Iface { a: number }
        export type Alias = string;
        export enum Colour { Red }
        export const value = 1;
        export namespace Space { export const x = 1; }
      `,
    });

    expect(kinds(readExports(file))).toEqual({
      fn: "function",
      Cls: "class",
      Iface: "interface",
      Alias: "type",
      Colour: "enum",
      value: "variable",
      Space: "namespace",
    });
  });

  it("leaves what is not exported out", () => {
    const file = module({ "a.ts": `const hidden = 1; export const shown = 2;` });
    expect(readExports(file)).toEqual([{ name: "shown", kind: "variable" }]);
  });

  it("reports an export list under the name it is exported by, with the kind of the declaration", () => {
    const file = module({ "a.ts": `function impl() {} export { impl as renamed };` });
    expect(readExports(file)).toEqual([{ name: "renamed", kind: "function" }]);
  });

  it("calls a default export `default`", () => {
    const file = module({ "a.ts": `export default class Thing {}` });
    expect(readExports(file)).toEqual([{ name: "default", kind: "class" }]);
  });

  it("follows a star re-export to the kinds in the other file", () => {
    const file = module({
      "a.ts": `export * from "./other.js";\nexport const own = 1;`,
      "other.ts": `export function borrowed(): void {}\nexport interface Shape { a: number }`,
    });

    expect(kinds(readExports(file))).toEqual({
      own: "variable",
      borrowed: "function",
      Shape: "interface",
    });
  });

  it("calls an arrow held in a const a variable, because that is the declaration", () => {
    const file = module({ "a.ts": `export const go = () => 1;` });
    expect(readExports(file)).toEqual([{ name: "go", kind: "variable" }]);
  });

  it("sorts by name, so two reads of the same file agree", () => {
    const file = module({ "a.ts": `export const b = 1; export const a = 2; export const c = 3;` });
    expect(readExports(file).map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("has nothing to report for a script with no exports, and for a file that is not there", () => {
    expect(readExports(module({ "a.ts": `const x = 1;` }))).toEqual([]);
    expect(readExports(join(tmp("wecode-ast-"), "missing.ts"))).toEqual([]);
  });

  it("refuses a file that does not parse rather than reporting the exports it can see", () => {
    const file = module({ "a.ts": `export const good = 1;\nfunction broken( {` });
    expect(() => readExports(file)).toThrow(/does not parse/);
  });

  it("reaches the same verdicts with the host under load, because it waits for the parse", async () => {
    const good = module({
      "a.ts": `export * from "./other.js";\nexport const own = 1;`,
      "other.ts": `export function borrowed(): void {}`,
    });
    const bad = module({ "a.ts": `export const good = 1;\nfunction broken( {` });

    await underLoad(() => {
      expect(kinds(readExports(good))).toEqual({ own: "variable", borrowed: "function" });
      expect(() => readExports(bad)).toThrow(/does not parse/);
    });
  });
});
