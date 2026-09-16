import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readExports, type ExportedSymbol } from "../src/ast.js";
import { tmp } from "./tmpdir.js";

/** Writes `files` into a fresh directory and returns the path of the first one, which is
 *  the module under test. */
function module(files: Record<string, string>): string {
  const dir = tmp("wecode-ast-js-");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const first = Object.keys(files)[0];
  return join(dir, first as string);
}

const kinds = (exports: ExportedSymbol[]): Record<string, string> =>
  Object.fromEntries(exports.map((e) => [e.name, e.kind]));

describe("readExports of JavaScript", () => {
  it("names each exported declaration of a .js module and its kind", () => {
    const file = module({
      "a.js": `
        export function fn() {}
        export class Cls {}
        export const value = 1;
        export const go = () => 1;
      `,
    });

    expect(kinds(readExports(file))).toEqual({
      fn: "function",
      Cls: "class",
      value: "variable",
      go: "variable",
    });
  });

  it("reads .mjs, .cjs and .jsx by the same rules", () => {
    expect(readExports(module({ "a.mjs": `export function fn() {}` }))).toEqual([
      { name: "fn", kind: "function" },
    ]);
    expect(readExports(module({ "a.cjs": `export const value = 1;` }))).toEqual([
      { name: "value", kind: "variable" },
    ]);
    expect(readExports(module({ "a.jsx": `export default function View() { return null; }` }))).toEqual(
      [{ name: "default", kind: "function" }],
    );
  });

  it("follows an export list and a star re-export across JavaScript files", () => {
    const file = module({
      "a.js": `function impl() {}\nexport { impl as renamed };\nexport * from "./other.js";`,
      "other.js": `export class Borrowed {}`,
    });

    expect(kinds(readExports(file))).toEqual({ renamed: "function", Borrowed: "class" });
  });

  it("has nothing to report for a JavaScript script with no exports", () => {
    expect(readExports(module({ "a.js": `const x = 1;` }))).toEqual([]);
  });
});

describe("readExports of a file that does not parse", () => {
  it("refuses a TypeScript file it cannot parse rather than reporting a guess", () => {
    const file = module({ "a.ts": `export const good = 1;\nfunction broken( {` });
    expect(() => readExports(file)).toThrow(/does not parse/);
  });

  it("refuses a JavaScript file it cannot parse", () => {
    const file = module({ "a.js": `export const good = 1;\nfunction broken( {` });
    expect(() => readExports(file)).toThrow(/does not parse/);
  });

  it("names the file and the line the syntax error is on", () => {
    const file = module({ "a.ts": `export const good = 1;\n\nclass Broken {` });
    expect(() => readExports(file)).toThrow(new RegExp(`cannot read .*${"a.ts"}.*line 3`, "s"));
  });

  it("reads a file whose only fault is a type error, because parsing is what it needs", () => {
    const file = module({ "a.ts": `export const value: number = "not a number";` });
    expect(readExports(file)).toEqual([{ name: "value", kind: "variable" }]);
  });

  it("still has no exports, rather than a refusal, for a file that is not there", () => {
    expect(readExports(join(tmp("wecode-ast-js-"), "missing.ts"))).toEqual([]);
  });
});
