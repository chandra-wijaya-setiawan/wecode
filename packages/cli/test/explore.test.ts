import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UnknownFile,
  UnknownSymbol,
  type Definition,
  type Imported,
  type Purpose,
  type Reading,
  type RepoIndex,
  type Use,
} from "@wecode/explorer";
import { explore } from "../src/explore.js";
import { answered, run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The fixture repository these questions are asked of.
 *
 *  Four modules, written so every question has an answer worth printing: `greet.ts`
 *  exports three names and keeps a fourth to itself, documents itself and two of its
 *  declarations, brings in one name from inside the tree and one from outside it, and is
 *  taken up by two files. `locale.ts` is the plain case at the other end — no doc, one
 *  export, one dependent. */
const FIXTURE: Readonly<Record<string, string>> = {
  "src/locale.ts": `export const LOCALE = "en-GB";\n`,

  "src/greet.ts": `/** Greeting words, and the punctuation one ends with.
 *
 *  Everything a caller needs to say hello, and nothing about who is listening. */
import { LOCALE } from "./locale.js";
import { inspect } from "node:util";

export interface Greeting {
  readonly text: string;
}

export const PUNCT = "!";

/** Greets by name, in the one locale this fixture has. */
export function greet(name: string): Greeting {
  return { text: \`\${decorate(name)} (\${LOCALE}) \${inspect(PUNCT)}\` };
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
};

let root: string;

beforeAll(() => {
  root = tmp("wecode-cli-explore-");
  for (const [path, body] of Object.entries(FIXTURE)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
});

/** A reader of the source, as the repository index.
 *
 *  Not codegraph: `@lzehrung/codegraph-core@2.3.27` does not declare its own `smol-toml`
 *  dependency and will not load in this workspace at all. That is the reason the command
 *  takes the index as an argument, but it is not the only one — the command is about the
 *  three questions and the shape of the answers, and proving it against a second
 *  implementation is what says so. If these assertions held only for codegraph they would
 *  be about codegraph.
 *
 *  Crude on purpose: it finds declarations and uses by reading the lines, the way a person
 *  with grep would. Everything it answers can be checked against the fixture above by
 *  eye. */
class Reader implements RepoIndex {
  constructor(readonly root: string) {}

  private files(): readonly string[] {
    return Object.keys(FIXTURE).filter((p) => p.endsWith(".ts"));
  }

  private lines(file: string): readonly string[] {
    if (!existsSync(join(this.root, file))) throw new UnknownFile(file, this.root);
    return readFileSync(join(this.root, file), "utf8").split("\n");
  }

  async read(file: string): Promise<Reading> {
    const lines = this.lines(file);
    const defines: Definition[] = [];
    const imports: Imported[] = [];

    lines.forEach((text, i) => {
      const declared = /^(export\s+)?(?:declare\s+)?(function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(text);
      if (declared !== null) {
        const [, exported, keyword, name] = declared;
        defines.push({
          name: name ?? "",
          kind: KINDS[keyword ?? ""] ?? "unknown",
          line: i + 1,
          exported: exported !== undefined,
          doc: docAbove(lines, i),
        });
      }
      for (const binding of bindings(text)) imports.push(this.resolveFrom(file, binding));
    });

    return { file, defines: defines.sort(byName), imports: imports.sort(byName) };
  }

  async usesOf(file: string, symbol: string): Promise<readonly Use[]> {
    const reading = await this.read(file);
    const declared = reading.defines.find((d) => d.name === symbol);
    if (declared === undefined) throw new UnknownSymbol(file, symbol);

    const uses: Use[] = [];
    for (const path of this.files()) {
      // A name the file keeps to itself can only be used where it is declared.
      if (!declared.exported && path !== file) continue;
      this.lines(path).forEach((text, i) => {
        // The declaration is not a use of itself, and a specifier that happens to spell
        // the name — "./greet.js" — is not one either.
        if (path === file && i + 1 === declared.line) return;
        const at = new RegExp(`\\b${symbol}\\b`).exec(text.replace(/"[^"]*"|'[^']*'/g, ""));
        if (at !== null) uses.push({ file: path, line: i + 1, column: at.index + 1 });
      });
    }
    return uses.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  }

  async purposeOf(file: string): Promise<Purpose> {
    const reading = await this.read(file);
    const dependents: string[] = [];
    for (const path of this.files()) {
      const brought = await this.read(path);
      if (brought.imports.some((i) => i.resolved === file)) dependents.push(path);
    }
    return {
      file,
      doc: docAbove(this.lines(file), first(this.lines(file))),
      exports: reading.defines.filter((d) => d.exported).map((d) => d.name).sort(),
      dependents: dependents.sort(),
    };
  }

  private resolveFrom(file: string, binding: Omit<Imported, "resolved">): Imported {
    if (!binding.from.startsWith(".")) return { ...binding, resolved: null };
    const reached = posix.join(posix.dirname(file), binding.from.replace(/\.js$/, ".ts"));
    return { ...binding, resolved: existsSync(join(this.root, reached)) ? reached : null };
  }
}

const KINDS: Readonly<Record<string, Definition["kind"]>> = {
  function: "function",
  class: "class",
  interface: "interface",
  type: "type",
  const: "variable",
  let: "variable",
  var: "variable",
};

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** The first line of code, so a module's leading comment can be told from a declaration's. */
const first = (lines: readonly string[]): number =>
  lines.findIndex((l) => /^(import|export|const|function|interface|class|type)\b/.test(l));

/** The doc comment immediately above line `i`, markers stripped, or null. */
function docAbove(lines: readonly string[], i: number): string | null {
  if (!(lines[i - 1] ?? "").trimEnd().endsWith("*/")) return null;
  let start = i - 1;
  while (start >= 0 && !(lines[start] ?? "").trimStart().startsWith("/**")) start -= 1;
  if (start < 0) return null;
  return lines
    .slice(start, i)
    .map((l) => l.replace(/^\s*\/\*\*/, "").replace(/\s*\*\/\s*$/, "").replace(/^\s*\*/, "").trim())
    .join("\n")
    .trim();
}

/** The names one import line brings in, as the port reports them. */
function bindings(text: string): ReadonlyArray<Omit<Imported, "resolved">> {
  const line = /^import\s+(.+?)\s+from\s+["']([^"']+)["']/.exec(text);
  if (line === null) return [];
  const [, clause = "", from = ""] = line;
  const star = /^\*\s+as\s+([\w$]+)$/.exec(clause);
  if (star !== null) return [{ name: star[1] ?? "*", kind: "namespace", from }];
  const braced = /\{([^}]*)\}/.exec(clause);
  const named = (braced?.[1] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => ({ name: (p.split(/\s+as\s+/).pop() ?? p).trim(), kind: "named" as const, from }));
  const fallback = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
  return fallback === "" ? named : [{ name: fallback, kind: "default" as const, from }, ...named];
}

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");
const complained = (): string => err.join("");

/** The command, against the fixture, with the reader as its index. */
const ask = (...args: string[]): Promise<number> => explore([...args, "--root", root], (r) => new Reader(r));

describe("wecode explore", () => {
  describe("read — what a file defines and brings in", () => {
    it("names every declaration, with the kind and the line a reader would give it", async () => {
      expect(await ask("read", "src/greet.ts")).toBe(0);
      expect(said()).toContain("Greeting");
      expect(said()).toMatch(/interface\s+Greeting\s+:7/);
      expect(said()).toMatch(/function\s+greet\s+:14/);
      expect(said()).toMatch(/variable\s+PUNCT\s+:11/);
    });

    it("says of each whether the rest of the repository may name it", async () => {
      await ask("read", "src/greet.ts");
      const lines = said().split("\n");
      expect(lines.find((l) => l.includes("greet "))).toMatch(/^\s+export\b/);
      expect(lines.find((l) => l.includes("decorate"))).not.toMatch(/^\s+export\b/);
    });

    it("carries the first line of a declaration's doc comment", async () => {
      await ask("read", "src/greet.ts");
      expect(said()).toContain("Greets by name, in the one locale this fixture has.");
    });

    it("says where an import lands, and says so when it leaves the repository", async () => {
      await ask("read", "src/greet.ts");
      expect(said()).toContain("./locale.js → src/locale.ts");
      expect(said()).toContain("node:util → outside the repository");
    });

    it("hands back the port's own answer under --json, unreshaped", async () => {
      expect(await ask("read", "src/greet.ts", "--json")).toBe(0);
      expect(JSON.parse(said())).toEqual(await new Reader(root).read("src/greet.ts"));
    });

    it("refuses a file the index does not hold, and says which tree it looked in", async () => {
      expect(await ask("read", "src/nowhere.ts")).toBe(1);
      expect(complained()).toContain("no reading of src/nowhere.ts");
      expect(complained()).toContain(root);
      expect(said()).toBe("");
    });
  });

  describe("uses — who references a symbol", () => {
    it("points at every place, as a file, a line and a column", async () => {
      expect(await ask("uses", "src/greet.ts", "greet")).toBe(0);
      expect(said()).toContain("src/app.ts:1:10");
      expect(said()).toContain("src/shout.ts:4:10");
    });

    it("counts them, because the count is the answer to may I change this", async () => {
      await ask("uses", "src/greet.ts", "greet");
      const uses = await new Reader(root).usesOf("src/greet.ts", "greet");
      expect(said()).toContain(`used in ${uses.length} places`);
    });

    it("does not count the declaration as a use of itself", async () => {
      await ask("uses", "src/greet.ts", "decorate");
      expect(said()).not.toContain("src/greet.ts:19:");
      expect(said()).toContain("src/greet.ts:15:");
    });

    it("refuses a name the file does not declare, rather than answering none", async () => {
      expect(await ask("uses", "src/greet.ts", "farewell")).toBe(1);
      expect(complained()).toContain("no uses of farewell: src/greet.ts does not declare it");
    });

    it("wants the symbol before it asks anything", async () => {
      expect(await ask("uses", "src/greet.ts")).toBe(1);
      expect(complained()).toContain("wecode explore uses <file> <symbol>");
    });
  });

  describe("purpose — the evidence of what a module is for", () => {
    it("carries what the module says about itself, whole", async () => {
      expect(await ask("purpose", "src/greet.ts")).toBe(0);
      expect(said()).toContain("Greeting words, and the punctuation one ends with.");
      expect(said()).toContain("Everything a caller needs to say hello, and nothing about who is listening.");
    });

    it("carries what it offers and who took it up", async () => {
      await ask("purpose", "src/greet.ts");
      expect(said()).toContain("offers      Greeting, PUNCT, greet");
      expect(said()).toContain("taken up by src/app.ts, src/shout.ts");
    });

    it("says a module documents nothing rather than printing nothing", async () => {
      await ask("purpose", "src/locale.ts");
      expect(said()).toContain("says nothing about itself");
      expect(said()).toContain("offers      LOCALE");
    });
  });

  describe("the command itself", () => {
    it("asks about the directory it was run in when no root is given", async () => {
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      try {
        expect(await explore(["purpose", "src/locale.ts"], (r) => new Reader(r))).toBe(0);
        expect(said()).toContain("offers      LOCALE");
      } finally {
        cwd.mockRestore();
      }
    });

    it("opens the index at the root as an absolute path, whatever it was given", async () => {
      const opened: string[] = [];
      await explore(["read", "src/locale.ts", "--root", root], (r) => (opened.push(r), new Reader(r)));
      expect(opened).toEqual([resolve(root)]);
    });

    it("lists its three questions when asked nothing", async () => {
      expect(await explore([], () => new Reader(root))).toBe(0);
      for (const q of ["read", "uses", "purpose"]) expect(said()).toContain(`wecode explore ${q}`);
    });

    it("refuses a question it does not ask, and says which it does", async () => {
      expect(await explore(["rewrite", "src/greet.ts"], () => new Reader(root))).toBe(1);
      expect(complained()).toContain("no such question: rewrite");
      expect(said()).toContain("wecode explore purpose <file>");
    });
  });

  describe("the dispatch", () => {
    // Through run() the index is the real one, codegraph, which does not load in this
    // workspace — so the arguments here are ones the command answers before it opens an
    // index. What is being proved is the wiring: that `explore` is reached with the words
    // after it, and that its answer arrives even though run() returned before it.
    it("reaches explore from `wecode explore`, with the words after it", async () => {
      expect(run(["explore", "uses", "src/greet.ts"])).toBe(0);
      expect(await answered()).toBe(1);
      expect(complained()).toContain("wecode explore uses <file> <symbol>");
    });

    it("settles a non-zero answer onto the exit code, which run() returned too early for", async () => {
      const before = process.exitCode;
      try {
        expect(run(["explore", "rewrite", "src/greet.ts"])).toBe(0);
        expect(process.exitCode).toBe(before);
        expect(await answered()).toBe(1);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = before;
      }
    });

    it("answers zero when nothing has been explored", async () => {
      expect(run(["explore"])).toBe(0);
      expect(await answered()).toBe(0);
      expect(said()).toContain("wecode explore read <file>");
    });

    it("is listed in the manual, so an agent reading --help finds it", () => {
      expect(run(["--help"])).toBe(0);
      expect(said()).toContain("wecode explore read|uses|purpose <file>");
    });
  });
});
