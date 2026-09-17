import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  openCodegraph,
  UnknownFile,
  UnknownSymbol,
  type Purpose,
  type Reading,
  type RepoIndex,
  type Use,
} from "../src/index.js";
import {
  isDeclaredExport,
  ownDeclarations,
  prose,
  refine,
} from "../src/adapters/codegraph.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Whether codegraph can be loaded here at all.
 *
 *  `@lzehrung/codegraph-core@2.3.27` imports `smol-toml` without declaring it, so under
 *  pnpm's strict node_modules every one of its entry points throws on load. The fix is a
 *  `packageExtensions` entry in `pnpm-workspace.yaml` — a file outside this package. Until
 *  it lands, the suites below that need a real index cannot run, and the ones that do not
 *  still hold: the port is proved against a second implementation, and the adapter's
 *  translation is proved against codegraph-shaped inputs.
 *
 *  This is a question asked of the installation, not a flag anyone sets. The moment the
 *  dependency resolves, every suite here runs for real. */
const UNAVAILABLE = await import("@lzehrung/codegraph-core").then(
  () => null,
  (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
);

/** The fixture repository: four modules, chosen so every question the port asks has a
 *  non-trivial answer. `greet.ts` exports three names and keeps a fourth to itself, imports
 *  one from inside the tree and one from outside it, and is imported by two files. */
const FIXTURE: Readonly<Record<string, string>> = {
  "package.json": `{ "name": "fixture", "version": "0.0.0", "type": "module" }\n`,
  "tsconfig.json": `{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }\n`,

  "src/locale.ts": `export const LOCALE = "en-GB";\n`,

  "src/greet.ts": `/** Greeting words, and the punctuation one ends with.
 *
 *  Everything a caller needs to say hello, and nothing about who is listening. */
import { LOCALE } from "./locale.js";

export interface Greeting {
  readonly text: string;
}

export const PUNCT = "!";

/** Greets by name, in the one locale this fixture has. */
export function greet(name: string): Greeting {
  return { text: \`\${decorate(name)} (\${LOCALE})\` };
}

/** Kept to itself: the shape of the words, which is nobody else's business. */
function decorate(name: string): string {
  return \`hello \${name}\`;
}
`,

  "src/shout.ts": `import { greet, PUNCT } from "./greet.js";

export function shout(name: string): string {
  return greet(name).text.toUpperCase() + PUNCT;
}
`,

  "src/app.ts": `import { greet } from "./greet.js";
import { shout } from "./shout.js";

export function main(): string {
  return [greet("world").text, shout("world")].join(" / ");
}
`,

  "src/index.ts": `/** What a client of the fixture may import. */
export * from "./greet.js";
export { shout } from "./shout.js";
`,
};

let root: string;

beforeAll(() => {
  root = tmp("wecode-explorer-");
  for (const [path, body] of Object.entries(FIXTURE)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
});

/** The line `use` points at, as the fixture wrote it. Every assertion about a use is made
 *  through this: a line number on its own says nothing a reader can check, and pinning the
 *  exact number would make the test about one index's counting rather than about the
 *  repository. */
const lineAt = (use: Use): string => {
  const lines = readFileSync(join(root, use.file), "utf8").split("\n");
  return lines[use.line - 1] ?? "";
};

const named = (reading: Reading, name: string) => reading.defines.find((d) => d.name === name);

/** A second implementation of the port, so the suite below proves the port rather than the
 *  adapter. It answers from what a reader of the fixture can see: the declarations typed
 *  out by hand, and — for uses — the identifier found in the source as a whole word.
 *
 *  Being cruder than codegraph is the point. If both satisfy the same assertions, the
 *  assertions are about the repository, and a caller written against them survives the
 *  index underneath being swapped. */
class Recited implements RepoIndex {
  constructor(readonly root: string) {}

  private static readonly READINGS: Readonly<Record<string, Reading>> = {
    "src/greet.ts": {
      file: "src/greet.ts",
      defines: [
        { name: "Greeting", kind: "interface", line: 6, exported: true, doc: null },
        { name: "PUNCT", kind: "variable", line: 10, exported: true, doc: null },
        {
          name: "decorate",
          kind: "function",
          line: 18,
          exported: false,
          doc: "Kept to itself: the shape of the words, which is nobody else's business.",
        },
        {
          name: "greet",
          kind: "function",
          line: 13,
          exported: true,
          doc: "Greets by name, in the one locale this fixture has.",
        },
      ],
      imports: [
        { name: "LOCALE", kind: "named", from: "./locale.js", resolved: "src/locale.ts" },
      ],
    },
  };

  private static readonly PURPOSES: Readonly<Record<string, Purpose>> = {
    "src/greet.ts": {
      file: "src/greet.ts",
      doc: "Greeting words, and the punctuation one ends with.\n\nEverything a caller needs to say hello, and nothing about who is listening.",
      exports: ["Greeting", "PUNCT", "greet"],
      dependents: ["src/app.ts", "src/index.ts", "src/shout.ts"],
    },
  };

  async read(file: string): Promise<Reading> {
    const reading = Recited.READINGS[file];
    if (reading === undefined) throw new UnknownFile(file, this.root);
    return reading;
  }

  async purposeOf(file: string): Promise<Purpose> {
    const purpose = Recited.PURPOSES[file];
    if (purpose === undefined) throw new UnknownFile(file, this.root);
    return purpose;
  }

  async usesOf(file: string, symbol: string): Promise<readonly Use[]> {
    const reading = await this.read(file);
    const declared = reading.defines.find((d) => d.name === symbol);
    if (declared === undefined) throw new UnknownSymbol(file, symbol);

    const uses: Use[] = [];
    for (const path of Object.keys(FIXTURE).filter((p) => p.endsWith(".ts"))) {
      const lines = readFileSync(join(this.root, path), "utf8").split("\n");
      lines.forEach((text, i) => {
        // The declaration is not a use of itself, and a non-exported name is only ever
        // used in the file that declares it.
        if (path === file && i + 1 === declared.line) return;
        if (!declared.exported && path !== file) return;
        // A specifier that happens to contain the name — `"./greet.js"` — is not a use of
        // it, so every quoted string comes out before the line is scanned.
        const at = new RegExp(`\\b${symbol}\\b`).exec(text.replace(/"[^"]*"|'[^']*'/g, ""));
        if (at !== null) uses.push({ file: path, line: i + 1, column: at.index + 1 });
      });
    }
    return uses;
  }
}

/** Both implementations, against the one fixture. The recital always runs; codegraph runs
 *  wherever it loads. */
const INDEXES: ReadonlyArray<readonly [string, () => RepoIndex]> = [
  ...(UNAVAILABLE === null
    ? ([["codegraph", () => openCodegraph(root)]] as const)
    : ([] as const)),
  ["a reader of the source", () => new Recited(root)],
];

describe.each(INDEXES)("the repository, asked by %s", (_label, open) => {
  let index: RepoIndex;
  beforeAll(() => {
    index = open();
  });

  describe("what a file defines and exports", () => {
    it("names every declaration, with the kind a reader would give it", async () => {
      const reading = await index.read("src/greet.ts");
      expect(reading.defines.map((d) => [d.name, d.kind])).toEqual([
        ["Greeting", "interface"],
        ["PUNCT", "variable"],
        ["decorate", "function"],
        ["greet", "function"],
      ]);
    });

    it("says of each whether the rest of the repository may name it", async () => {
      const reading = await index.read("src/greet.ts");
      expect(named(reading, "greet")?.exported).toBe(true);
      expect(named(reading, "decorate")?.exported).toBe(false);
    });

    it("carries the doc comment on a declaration, markers off", async () => {
      const reading = await index.read("src/greet.ts");
      expect(named(reading, "greet")?.doc).toBe(
        "Greets by name, in the one locale this fixture has.",
      );
    });

    it("puts a declaration on the line the fixture declares it on", async () => {
      const reading = await index.read("src/greet.ts");
      const line = named(reading, "greet")?.line ?? 0;
      expect(lineAt({ file: "src/greet.ts", line, column: 1 })).toContain("function greet");
    });

    it("refuses a file it does not hold, rather than reading nothing", async () => {
      await expect(index.read("src/nowhere.ts")).rejects.toThrow(UnknownFile);
    });
  });

  describe("what a file imports", () => {
    it("names the local name, the specifier as written, and the file it reaches", async () => {
      const reading = await index.read("src/greet.ts");
      expect(reading.imports).toEqual([
        { name: "LOCALE", kind: "named", from: "./locale.js", resolved: "src/locale.ts" },
      ]);
    });
  });

  describe("who references a symbol", () => {
    it("finds every file that uses an exported one", async () => {
      const uses = await index.usesOf("src/greet.ts", "greet");
      // Not `src/index.ts`: an `export *` re-exports the module without naming anything
      // in it, so it depends on greet.ts without ever referencing `greet`.
      expect([...new Set(uses.map((u) => u.file))].sort()).toEqual(["src/app.ts", "src/shout.ts"]);
    });

    it("points at a line that mentions the symbol", async () => {
      const uses = await index.usesOf("src/greet.ts", "greet");
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) expect(lineAt(use)).toContain("greet");
    });

    it("does not count the declaration as a use of itself", async () => {
      const reading = await index.read("src/greet.ts");
      const declared = named(reading, "decorate")?.line;
      const uses = await index.usesOf("src/greet.ts", "decorate");
      expect(uses.map((u) => u.file)).toEqual(["src/greet.ts"]);
      expect(uses.map((u) => u.line)).not.toContain(declared);
    });

    it("refuses a name the file does not declare, rather than answering none", async () => {
      await expect(index.usesOf("src/greet.ts", "farewell")).rejects.toThrow(UnknownSymbol);
    });
  });

  describe("the evidence of what a module is for", () => {
    it("carries what the module says about itself", async () => {
      const purpose = await index.purposeOf("src/greet.ts");
      expect(purpose.doc).toBe(
        "Greeting words, and the punctuation one ends with.\n\n" +
          "Everything a caller needs to say hello, and nothing about who is listening.",
      );
    });

    it("carries what it offers", async () => {
      const purpose = await index.purposeOf("src/greet.ts");
      expect(purpose.exports).toEqual(["Greeting", "PUNCT", "greet"]);
    });

    it("carries who took it up", async () => {
      const purpose = await index.purposeOf("src/greet.ts");
      expect(purpose.dependents).toEqual(["src/app.ts", "src/index.ts", "src/shout.ts"]);
    });
  });
});

/** What only the real index can be asked, because the recital above holds one file. */
describe.skipIf(UNAVAILABLE !== null)(`the codegraph index (${UNAVAILABLE ?? "loaded"})`, () => {
  it("resolves a specifier that leaves the repository to nothing", async () => {
    const reading = await openCodegraph(root).read("src/locale.ts");
    expect(reading.imports).toEqual([]);
  });

  it("follows an export * into the module it re-exports from", async () => {
    const purpose = await openCodegraph(root).purposeOf("src/index.ts");
    expect(purpose.exports).toEqual(["Greeting", "PUNCT", "greet", "shout"]);
  });

  it("reads a module with no doc comment as having none, not as having nothing", async () => {
    const purpose = await openCodegraph(root).purposeOf("src/shout.ts");
    expect(purpose.doc).toBeNull();
    expect(purpose.exports).toEqual(["shout"]);
  });

  it("answers about one build of the tree, not about the tree as it is now", async () => {
    const index = openCodegraph(root);
    const before = await index.read("src/locale.ts");
    writeFileSync(join(root, "src/locale.ts"), `export const LOCALE = "en-GB";\nexport const B = 1;\n`);
    try {
      expect((await index.read("src/locale.ts")).defines).toEqual(before.defines);
      expect((await openCodegraph(root).read("src/locale.ts")).defines.map((d) => d.name)).toEqual([
        "B",
        "LOCALE",
      ]);
    } finally {
      writeFileSync(join(root, "src/locale.ts"), FIXTURE["src/locale.ts"] ?? "");
    }
  });
});

/** The adapter's own work, on codegraph-shaped inputs.
 *
 *  These are the four places codegraph and the port disagree, and closing them is the only
 *  reason the adapter is a file rather than a re-export. They are asked of the translation
 *  directly because they must hold for a reading of any repository, not only the fixture —
 *  and because they go on holding in an installation where codegraph itself will not load. */
describe("what the adapter translates", () => {
  /** A codegraph local, as much of one as the translation reads. */
  const def = (fields: {
    name: string;
    line: number;
    column?: number;
    lineSpan?: number;
    isMember?: boolean;
  }) =>
    ({
      localName: fields.name,
      kind: "variable",
      isMember: fields.isMember,
      lineSpan: fields.lineSpan,
      range: { start: { line: fields.line, column: fields.column ?? 1 } },
    }) as unknown as Parameters<typeof ownDeclarations>[0][number];

  describe("an interface, which codegraph calls a type", () => {
    it("is an interface when the declaration's own line says interface", () => {
      expect(refine("type", "export interface ")).toBe("interface");
      expect(refine("type", "interface ")).toBe("interface");
    });

    it("stays a type when the line says type", () => {
      expect(refine("type", "export type ")).toBe("type");
    });

    it("leaves every other kind alone, whatever the line says", () => {
      expect(refine("function", "export interface ")).toBe("function");
      expect(refine("variable", "interface ")).toBe("variable");
    });
  });

  describe("a type-only export, which codegraph does not record at all", () => {
    it("is read off the declaration's own line", () => {
      expect(isDeclaredExport("export interface ")).toBe(true);
      expect(isDeclaredExport("export type ")).toBe(true);
      expect(isDeclaredExport("export declare interface ")).toBe(true);
    });

    it("is not claimed for a declaration that only mentions the word", () => {
      expect(isDeclaredExport("")).toBe(false);
      expect(isDeclaredExport("const exported: ")).toBe(false);
      expect(isDeclaredExport("  return export type ")).toBe(false);
    });
  });

  describe("a parameter, which codegraph counts among a file's locals", () => {
    it("is not a declaration the file makes", () => {
      const own = ownDeclarations([
        def({ name: "greet", line: 13, column: 17, lineSpan: 3 }),
        def({ name: "name", line: 13, column: 23 }),
        def({ name: "words", line: 14, column: 9 }),
        def({ name: "PUNCT", line: 10, column: 14 }),
      ]);
      expect(own.map((d) => d.localName)).toEqual(["greet", "PUNCT"]);
    });

    it("is judged by the declaration's line span, since its range is its name's alone", () => {
      // `after` sits one line past the function's three, so nothing encloses it.
      const own = ownDeclarations([
        def({ name: "greet", line: 13, column: 17, lineSpan: 3 }),
        def({ name: "after", line: 16, column: 7 }),
      ]);
      expect(own.map((d) => d.localName)).toEqual(["greet", "after"]);
    });

    it("drops a member, which says so itself", () => {
      const own = ownDeclarations([
        def({ name: "Greeting", line: 6, column: 18, lineSpan: 3 }),
        def({ name: "text", line: 7, column: 12, isMember: true }),
      ]);
      expect(own.map((d) => d.localName)).toEqual(["Greeting"]);
    });
  });

  describe("a doc comment, which arrives with its markers on", () => {
    it("comes out as the prose, hanging indent and all", () => {
      expect(prose("/** Greets by name.\n *\n *  In one locale. */")).toBe(
        "Greets by name.\n\nIn one locale.",
      );
    });

    it("comes out of a line comment too", () => {
      expect(prose("// Greets by name.\n// In one locale.")).toBe(
        "Greets by name.\nIn one locale.",
      );
    });

    it("is null when there is none, and when there is nothing in it", () => {
      expect(prose(null)).toBeNull();
      expect(prose(undefined)).toBeNull();
      expect(prose("/** */")).toBeNull();
    });
  });
});
