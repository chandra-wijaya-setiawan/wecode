import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModuleIndex, SymbolDef } from "@lzehrung/codegraph-core";
import { beforeAll, describe, expect, it } from "vitest";
import { CodegraphIndex, isTopLevel, openCodegraph, type Load } from "../src/adapters/codegraph.js";
import { UnknownSymbol } from "../src/ports.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Whether codegraph can be loaded here at all. `@lzehrung/codegraph-core@2.3.27` imports
 *  `smol-toml` without declaring it, so under pnpm's strict node_modules it throws on load
 *  until that dependency is declared — a change to a file outside this suite's scope. The
 *  suites below that hand the adapter an index of their own run either way; the one that
 *  asks the real library runs the moment it resolves. */
const UNAVAILABLE = await import("@lzehrung/codegraph-core").then(
  () => null,
  (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
);

/** One module, written so that every way a name can be bound below the top level is in it:
 *  a parameter, a body `const`, a loop variable, a field, a method, a method's `const`, a
 *  `const` in a bare `if` block, and a `catch` binding. Three declarations are top-level —
 *  `PUNCT`, `greet`, `Ledger` — and those three are the whole answer. */
const WORDS = `import { LOCALE } from "./locale.js";

export const PUNCT = "!";

export function greet(name: string): string {
  const words = \`hello \${name}\`;
  for (const part of words.split(" ")) {
    if (part !== "") return part + PUNCT;
  }
  return words;
}

export class Ledger {
  readonly rows: string[] = [];
  add(row: string): void {
    const trimmed = row.trim();
    this.rows.push(trimmed);
  }
}

if (LOCALE === "en-GB") {
  const british = true;
  void british;
}

try {
  void 0;
} catch (err) {
  void err;
}
`;

const FIXTURE: Readonly<Record<string, string>> = {
  "package.json": `{ "name": "fixture", "version": "0.0.0", "type": "module" }\n`,
  "tsconfig.json": `{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }\n`,
  "src/locale.ts": `export const LOCALE = "en-GB";\n`,
  "src/words.ts": WORDS,
};

/** The three names the module declares, in the order a reading sorts them. */
const TOP_LEVEL = ["Ledger", "PUNCT", "greet"];

/** Every other name the file binds, none of which a reading may report. */
const BOUND_BELOW = ["name", "words", "part", "rows", "add", "trimmed", "british", "err"];

let root: string;

beforeAll(() => {
  root = tmp("wecode-explorer-toplevel-");
  for (const [path, body] of Object.entries(FIXTURE)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
});

/** Where a name is written in the fixture, 1-based as codegraph counts. `nth` picks the
 *  occurrence that is the binding, since a name used after it is written again. */
const at = (name: string, nth = 1): { line: number; column: number } => {
  const pattern = new RegExp(`\\b${name}\\b`, "g");
  let seen = 0;
  const lines = WORDS.split("\n");
  for (const [i, text] of lines.entries()) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      if (++seen === nth) return { line: i + 1, column: m.index + 1 };
    }
  }
  throw new Error(`${name} #${nth} is not in the fixture`);
};

/** A codegraph local, as much of one as the adapter reads. */
const def = (
  name: string,
  kind: string,
  where: { line: number; column: number },
  extra: { lineSpan?: number; isMember?: boolean } = {},
): SymbolDef =>
  ({
    localName: name,
    kind,
    file: join(root, "src/words.ts"),
    isMember: extra.isMember,
    lineSpan: extra.lineSpan,
    range: { start: where },
  }) as unknown as SymbolDef;

/** The fixture as codegraph would hold it: every name it binds, at the place the source
 *  writes it, with a declaration's lineSpan covering the lines it occupies.
 *
 *  Typed out rather than parsed, because the point of the suite is what the adapter does
 *  with an index that lists a file's locals — and it lists all of them. */
const moduleOfWords = (): ModuleIndex =>
  ({
    file: join(root, "src/words.ts"),
    locals: [
      def("PUNCT", "variable", at("PUNCT")),
      def("greet", "function", at("greet"), { lineSpan: 7 }),
      def("name", "variable", at("name")),
      def("words", "variable", at("words")),
      def("part", "variable", at("part")),
      def("Ledger", "class", at("Ledger"), { lineSpan: 7 }),
      def("rows", "variable", at("rows"), { isMember: true }),
      def("add", "function", at("add"), { lineSpan: 4, isMember: true }),
      def("trimmed", "variable", at("trimmed")),
      def("british", "variable", at("british")),
      def("err", "variable", at("err")),
    ],
    exports: [
      { type: "local", exportedAs: "PUNCT", target: { localName: "PUNCT" } },
      { type: "local", exportedAs: "greet", target: { localName: "greet" } },
      { type: "local", exportedAs: "Ledger", target: { localName: "Ledger" } },
    ],
    imports: [],
  }) as unknown as ModuleIndex;

/** Codegraph itself, answering with the module above and nothing else. The three calls the
 *  adapter makes on the library are stubbed at their narrowest: an id is the declaration,
 *  a reference search finds none, and nothing depends on the fixture. */
const load = (): Load => {
  const module = moduleOfWords();
  const index = { modules: new Map([[module.file, module]]), graph: {} };
  return () =>
    Promise.resolve({
      buildProjectIndex: () => Promise.resolve(index),
      symbolId: (d: SymbolDef) => d,
      findReferencesById: () => Promise.resolve({ status: "ok", references: [] }),
      getReverseDependencies: () => [],
    } as unknown as Awaited<ReturnType<Load>>);
};

const open = (): CodegraphIndex => new CodegraphIndex(root, load());

describe("a reading reports what the file declares, and only that", () => {
  it("names the top-level declarations", async () => {
    const reading = await open().read("src/words.ts");
    expect(reading.defines.map((d) => d.name)).toEqual(TOP_LEVEL);
  });

  it("names none of what the file binds below its top level", async () => {
    const reading = await open().read("src/words.ts");
    const reported = new Set(reading.defines.map((d) => d.name));
    expect(BOUND_BELOW.filter((name) => reported.has(name))).toEqual([]);
  });

  it("keeps a declaration the index never listed as exported out of nothing", async () => {
    const reading = await open().read("src/words.ts");
    expect(reading.defines.map((d) => [d.name, d.kind, d.exported])).toEqual([
      ["Ledger", "class", true],
      ["PUNCT", "variable", true],
      ["greet", "function", true],
    ]);
  });

  it("offers no local name among what the module exports", async () => {
    const purpose = await open().purposeOf("src/words.ts");
    expect(purpose.exports.filter((name) => BOUND_BELOW.includes(name))).toEqual([]);
    expect([...purpose.exports].sort()).toEqual(TOP_LEVEL);
  });

  it("refuses a local name as a symbol the file declares", async () => {
    // `british` is bound in a bare block, `name` is a parameter: the file has neither to
    // answer about, and answering "no uses" would read as "declared and unused".
    await expect(open().usesOf("src/words.ts", "british")).rejects.toThrow(UnknownSymbol);
    await expect(open().usesOf("src/words.ts", "name")).rejects.toThrow(UnknownSymbol);
  });

  it("still answers about one a top-level declaration does have", async () => {
    await expect(open().usesOf("src/words.ts", "greet")).resolves.toEqual([]);
  });
});

/** The rule that catches what no enclosing declaration does, asked directly, because it
 *  must hold for source the fixture does not contain. */
describe("what the source writes in front of a declaration's name", () => {
  it("is all a top-level statement writes, for a declaration the file makes", () => {
    for (const prefix of [
      "",
      "const ",
      "let ",
      "export const ",
      "export function ",
      "export async function ",
      "export default class ",
      "export declare interface ",
      "type ",
      "enum ",
      "export const { ",
      "export const [",
    ]) {
      expect(isTopLevel(prefix), prefix).toBe(true);
    }
  });

  it("is something else for a name bound inside a block, a call or a pattern", () => {
    for (const prefix of [
      "  const ",
      "\tlet ",
      "  for (const ",
      "} catch (",
      "if (x) { const ",
      "export function greet(",
      "const f = (",
      "return function ",
      "  readonly ",
    ]) {
      expect(isTopLevel(prefix), prefix).toBe(false);
    }
  });
});

/** The same question of the real library, wherever it loads. The hand-built index above is
 *  the adapter's contract; this is the check that codegraph is the shape it assumes. */
describe.skipIf(UNAVAILABLE !== null)(`codegraph itself (${UNAVAILABLE ?? "loaded"})`, () => {
  it("lists the three declarations and none of the locals", async () => {
    const reading = await openCodegraph(root).read("src/words.ts");
    expect(reading.defines.map((d) => d.name)).toEqual(TOP_LEVEL);
  });
});
