import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
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
import { doctor, examined } from "../src/doctor.js";
import { checkTree, UNIMPORTED_EXPORT, unimportedExports } from "../src/unimported.js";
import { recordRed, seed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The fixture repository the invariant is proved against.
 *
 *  Six modules and a README, written so that every way an export can be taken up has one
 *  module demonstrating it, and every way it can fail to be has another. Nothing here is
 *  incidental:
 *
 *    src/index.ts    the outward surface — exports `boot`, which nothing inside imports
 *    src/app.ts      the one importer, bringing names in by name, by alias and whole
 *    src/greet.ts    `greet` is imported; `GREETING` is used only at home
 *    src/bye.ts      `farewell` is imported, but under another name
 *    src/options.ts  taken entire by a namespace import, so both its names are spoken for
 *    src/dead.ts     `orphan`, which nobody anywhere mentions
 *    README.md       not a module at all, and not the check's business
 *
 *  Small enough that every expectation below can be checked against it by eye, which is
 *  the point of a fixture: an assertion nobody can verify by reading proves nothing. */
const FIXTURE: Readonly<Record<string, string>> = {
  "README.md": `# a fixture\n`,

  "src/options.ts": `export const DEFAULTS = { loud: false };\nexport const VERBOSE = "verbose";\n`,

  "src/greet.ts": `export const GREETING = "hello";

export function greet(name: string): string {
  return \`\${GREETING} \${name}\`;
}
`,

  "src/bye.ts": `export function farewell(name: string): string {
  return \`bye \${name}\`;
}
`,

  "src/dead.ts": `export function orphan(): string {
  return "nobody calls me";
}
`,

  "src/app.ts": `import { greet } from "./greet.js";
import { farewell as bye } from "./bye.js";
import * as options from "./options.js";

export function run(name: string): string {
  return [greet(name), bye(name), String(options.DEFAULTS.loud)].join(" ");
}
`,

  "src/index.ts": `import { run } from "./app.js";

export function boot(): string {
  return run("world");
}
`,
};

const FILES = Object.keys(FIXTURE);
const SURFACE = new Set(["src/index.ts"]);

let root: string;

beforeAll(() => {
  root = tmp("wecode-unimported-");
  for (const [path, body] of Object.entries(FIXTURE)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  // The doctor asks git which files there are, so the fixture has to be a repository that
  // tracks them. Staged rather than committed: `ls-files` reads the index.
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
});

/** A reader of the source, as the repository index.
 *
 *  Not codegraph — `@lzehrung/codegraph-core@2.3.27` does not declare its own `smol-toml`
 *  and will not load in this workspace — but that is not the only reason. The invariant is
 *  a claim about the port's four questions, and proving it against a second implementation
 *  of the port is what makes it a claim about the port rather than about codegraph. If
 *  swapping the index changed a single violation, the port would not be the boundary it
 *  says it is.
 *
 *  Crude on purpose: it finds declarations and uses by reading lines, the way a person
 *  with grep would. */
class Reader implements RepoIndex {
  constructor(readonly root: string) {}

  private lines(file: string): readonly string[] {
    // Only a `.ts` file is a module this index holds; anything else it has never read.
    if (!file.endsWith(".ts") || !existsSync(join(this.root, file))) throw new UnknownFile(file, this.root);
    return readFileSync(join(this.root, file), "utf8").split("\n");
  }

  async read(file: string): Promise<Reading> {
    const lines = this.lines(file);
    const defines: Definition[] = [];
    const imports: Imported[] = [];
    lines.forEach((text, i) => {
      const declared = /^(export\s+)?(function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(text);
      if (declared !== null) {
        const [, exported, keyword, name] = declared;
        defines.push({
          name: name ?? "",
          kind: keyword === "const" ? "variable" : ((keyword ?? "unknown") as Definition["kind"]),
          line: i + 1,
          exported: exported !== undefined,
          doc: null,
        });
      }
      const brought = this.bindings(file, text);
      imports.push(...brought);
    });
    return { file, defines: defines.sort(byName), imports: imports.sort(byName) };
  }

  async usesOf(file: string, symbol: string): Promise<readonly Use[]> {
    const declared = (await this.read(file)).defines.find((d) => d.name === symbol);
    if (declared === undefined) throw new UnknownSymbol(file, symbol);
    const uses: Use[] = [];
    for (const path of FILES.filter((p) => p.endsWith(".ts"))) {
      this.lines(path).forEach((text, i) => {
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
    for (const path of FILES.filter((p) => p.endsWith(".ts"))) {
      if ((await this.read(path)).imports.some((i) => i.resolved === file)) dependents.push(path);
    }
    return {
      file,
      doc: null,
      exports: reading.defines.filter((d) => d.exported).map((d) => d.name).sort(),
      dependents: dependents.sort(),
    };
  }

  private bindings(file: string, text: string): readonly Imported[] {
    const line = /^import\s+(.+?)\s+from\s+["']([^"']+)["']/.exec(text);
    if (line === null) return [];
    const [, clause = "", from = ""] = line;
    const resolved = this.resolve(file, from);
    const star = /^\*\s+as\s+([\w$]+)$/.exec(clause);
    if (star !== null) return [{ name: star[1] ?? "*", kind: "namespace", from, resolved }];
    const braced = /\{([^}]*)\}/.exec(clause);
    return (braced?.[1] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "")
      // The local name, as the port specifies: `farewell as bye` is brought in as `bye`.
      .map((p) => ({ name: (p.split(/\s+as\s+/).pop() ?? p).trim(), kind: "named" as const, from, resolved }));
  }

  private resolve(file: string, from: string): string | null {
    if (!from.startsWith(".")) return null;
    const reached = posix.join(posix.dirname(file), from.replace(/\.js$/, ".ts"));
    return existsSync(join(this.root, reached)) ? reached : null;
  }
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

const tree = (surface: ReadonlySet<string> = SURFACE) => ({ index: new Reader(root), files: FILES, surface });

const named = (found: readonly { slug: string; detail: string }[]): readonly string[] =>
  found.map((v) => `${v.slug} ${v.detail}`);

describe("the unimported-export invariant", () => {
  it("names the export nothing in the repository imports", async () => {
    const found = await unimportedExports(tree());
    expect(named(found)).toContain("src/dead.ts exports orphan, which nothing in the repository imports");
  });

  it("names an export used only inside its own file, because at home is not imported", async () => {
    const found = await unimportedExports(tree());
    expect(named(found)).toContain("src/greet.ts exports GREETING, which nothing in the repository imports");
  });

  it("finds those two and nothing else — every other export is spoken for", async () => {
    const found = await unimportedExports(tree());
    expect(named(found)).toEqual([
      "src/dead.ts exports orphan, which nothing in the repository imports",
      "src/greet.ts exports GREETING, which nothing in the repository imports",
    ]);
  });

  it("leaves alone a name another file imports", async () => {
    const found = await unimportedExports(tree());
    expect(named(found).join("\n")).not.toContain("greet,");
  });

  it("leaves alone a name imported under an alias, which the port reports by its local name", async () => {
    // The evidence for `farewell` is not an import called `farewell` — there is none. It
    // is that another file references the name, which is the question the port's third
    // answer settles. Without it this check would convict every renamed import.
    const uses = await new Reader(root).usesOf("src/bye.ts", "farewell");
    expect(uses.map((u) => u.file)).toContain("src/app.ts");
    expect(named(await unimportedExports(tree())).join("\n")).not.toContain("src/bye.ts");
  });

  it("leaves alone every name in a module some file takes whole", async () => {
    // `import * as options` names nothing, so it speaks for DEFAULTS and VERBOSE alike —
    // including VERBOSE, which no line anywhere mentions.
    expect(named(await unimportedExports(tree())).join("\n")).not.toContain("VERBOSE");
  });

  it("says nothing about a file the index does not hold, rather than failing on it", async () => {
    await expect(new Reader(root).read("README.md")).rejects.toBeInstanceOf(UnknownFile);
    expect(named(await unimportedExports(tree())).join("\n")).not.toContain("README.md");
  });

  describe("the outward surface", () => {
    it("is exempt, because nothing inside a repository imports its entry point", async () => {
      expect(named(await unimportedExports(tree())).join("\n")).not.toContain("src/index.ts");
    });

    it("is exempt only where it was declared to be", async () => {
      const found = await unimportedExports(tree(new Set()));
      expect(named(found)).toContain("src/index.ts exports boot, which nothing in the repository imports");
    });
  });

  describe("the pass", () => {
    it("reports every violation under the invariant's own name", async () => {
      const found = await checkTree(tree());
      expect(found.length).toBe(2);
      for (const v of found) {
        expect(v.invariant).toBe(UNIMPORTED_EXPORT);
        expect(v.entity).toBe("module");
        expect(v.id).toBeNull();
      }
    });

    it("turns a check that could not be run into a violation naming itself", async () => {
      const broken: RepoIndex = {
        root,
        read: () => Promise.reject(new Error("the index is not built")),
        usesOf: () => Promise.reject(new Error("the index is not built")),
        purposeOf: () => Promise.reject(new Error("the index is not built")),
      };
      const found = await checkTree({ index: broken, files: FILES, surface: SURFACE });
      expect(found).toEqual([
        {
          invariant: UNIMPORTED_EXPORT,
          entity: "invariant",
          id: null,
          slug: UNIMPORTED_EXPORT,
          detail: "the check itself failed: the index is not built",
        },
      ]);
    });
  });
});

let out: string[];
let err: string[];
let db: DatabaseSync;
let dbPath: string;
let exitCode: number | string | undefined;

beforeEach(() => {
  dbPath = join(tmp("wecode-unimported-db-"), "wecode.db");
  db = open(dbPath);
  const ids = seed(db);
  recordRed(db, ids.acceptance);
  // The doctor asks the record which repository it is about, and the tree half reads that
  // checkout. The seed names `/repo`, which is nowhere.
  db.prepare("UPDATE project SET repo = ?").run(root);
  out = [];
  err = [];
  exitCode = process.exitCode;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => {
  db.close();
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

const said = (): string => out.join("");

/** The command, over the fixture repository, with the reader as its index. */
const ask = (...args: string[]): number => doctor([dbPath, ...args], (r) => new Reader(r));

describe("wecode doctor --tree", () => {
  it("reports the tree's drift, asking git which files there are", async () => {
    ask("--tree", "--entry=src/index.ts");
    await examined();
    expect(said()).toContain(UNIMPORTED_EXPORT);
    expect(said()).toContain("module src/dead.ts — exports orphan, which nothing in the repository imports");
  });

  it("settles a non-zero exit code the returning call was too early for", async () => {
    process.exitCode = 0;
    ask("--tree", "--entry=src/index.ts");
    expect(process.exitCode).toBe(0);
    expect((await examined()).length).toBe(2);
    expect(process.exitCode).toBe(1);
  });

  it("takes each exempt entry point as --entry, and takes more than one", async () => {
    ask("--tree", "--entry=src/index.ts", "--entry=src/dead.ts");
    const found = await examined();
    expect(found.map((v) => v.slug)).toEqual(["src/greet.ts"]);
  });

  it("asks nothing of the tree without the flag, because indexing a repository costs", async () => {
    const opened: string[] = [];
    doctor([dbPath], (r) => (opened.push(r), new Reader(r)));
    expect(opened).toEqual([]);
    expect(said()).not.toContain(UNIMPORTED_EXPORT);
  });

  it("opens the index at the repository the record names", async () => {
    const opened: string[] = [];
    doctor([dbPath, "--tree"], (r) => (opened.push(r), new Reader(r)));
    await examined();
    expect(opened).toEqual([root]);
  });

  it("leaves the record's own invariants exactly as they were", async () => {
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = (SELECT MIN(id) FROM story)").run();
    expect(ask("--tree", "--entry=src/index.ts")).toBe(1);
    await examined();
    // Two reports, two passes: the record's drift is answered synchronously and the tree's
    // arrives after. Neither is mixed into the other's tally.
    expect(said()).toContain("delivered_story_has_landed");
    expect(said()).toContain("2 entities breaking 1 invariant");
  });

  it("says nothing about git having been unavailable, which the tree half never asked", async () => {
    ask("--tree", "--entry=src/index.ts");
    await examined();
    expect(said()).not.toContain("no repository to ask");
  });
});
