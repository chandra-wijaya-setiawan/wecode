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

/** Every case here builds at least one TypeScript program, and the dearest builds three.
 *  Measured on a quiet machine the cases cost 0.2s to 1.1s each — near enough vitest's 5s
 *  default that a busy machine fails them for load rather than for the code. Ten seconds is
 *  roughly ten times the dearest measured case, and matches the sibling `ast-exports`. */
const TIMEOUT = 10_000;

/** The dearest case measured on a quiet machine, in milliseconds: the `.mjs`/`.cjs`/`.jsx`
 *  case, which pays for three programs. `TIMEOUT` is sized against this. */
const DEAREST_CASE = 1_100;

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
  }, TIMEOUT);

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
  }, TIMEOUT);

  it("follows an export list and a star re-export across JavaScript files", () => {
    const file = module({
      "a.js": `function impl() {}\nexport { impl as renamed };\nexport * from "./other.js";`,
      "other.js": `export class Borrowed {}`,
    });

    expect(kinds(readExports(file))).toEqual({ renamed: "function", Borrowed: "class" });
  }, TIMEOUT);

  it("has nothing to report for a JavaScript script with no exports", () => {
    expect(readExports(module({ "a.js": `const x = 1;` }))).toEqual([]);
  }, TIMEOUT);
});

describe("readExports of a file that does not parse", () => {
  it("refuses a TypeScript file it cannot parse rather than reporting a guess", () => {
    const file = module({ "a.ts": `export const good = 1;\nfunction broken( {` });
    expect(() => readExports(file)).toThrow(/does not parse/);
  }, TIMEOUT);

  it("refuses a JavaScript file it cannot parse", () => {
    const file = module({ "a.js": `export const good = 1;\nfunction broken( {` });
    expect(() => readExports(file)).toThrow(/does not parse/);
  }, TIMEOUT);

  it("names the file and the line the syntax error is on", () => {
    const file = module({ "a.ts": `export const good = 1;\n\nclass Broken {` });
    expect(() => readExports(file)).toThrow(new RegExp(`cannot read .*${"a.ts"}.*line 3`, "s"));
  }, TIMEOUT);

  it("reads a file whose only fault is a type error, because parsing is what it needs", () => {
    const file = module({ "a.ts": `export const value: number = "not a number";` });
    expect(readExports(file)).toEqual([{ name: "value", kind: "variable" }]);
  }, TIMEOUT);

  it("still has no exports, rather than a refusal, for a file that is not there", () => {
    expect(readExports(join(tmp("wecode-ast-js-"), "missing.ts"))).toEqual([]);
  }, TIMEOUT);
});

describe("the cost of reading JavaScript", () => {
  /** A case left on vitest's default goes red on a busy machine for load rather than for the
   *  code, and the reader cannot tell the two apart. So the timeout is asserted, not just
   *  written: a case added later without one fails here instead of failing at random. */
  it("gives every case in this file a timeout its own cost fits inside", (ctx) => {
    const cases = tests(ctx.task.file);

    expect(cases.length).toBeGreaterThan(1); // The walk found them, rather than finding nothing.
    expect(cases.filter(({ timeout }) => timeout !== TIMEOUT)).toEqual([]);
    expect(TIMEOUT).toBeGreaterThanOrEqual(DEAREST_CASE * 5);
  }, TIMEOUT);
});

/** Every test under `suite`, however deeply nested, with the timeout it will be run under. */
function tests(suite: { tasks?: unknown[] }): Array<{ name: string; timeout: number }> {
  return (suite.tasks ?? []).flatMap((task) => {
    const t = task as { type: string; name: string; timeout?: number; tasks?: unknown[] };
    return t.type === "test" ? [{ name: t.name, timeout: t.timeout ?? 0 }] : tests(t);
  });
}
