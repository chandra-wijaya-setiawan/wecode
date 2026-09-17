import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { UnknownFile, UnknownSymbol, type Purpose, type Reading, type RepoIndex, type Use } from "@wecode/explorer";
import { plan, proposedScope } from "../src/plan.js";
import { promised, proposeScope } from "../src/scope-proposal.js";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The fixture repository these promises are asked about.
 *
 *  Three modules, arranged so a proposal has something to be wrong about: `greet` is
 *  declared in `src/greet.ts` and named by two other files, `decorate` is declared there
 *  and named by nobody outside it, and `LOCALE` is declared in a module of its own with one
 *  dependent. A promise about any of them has a different right answer. */
const FIXTURE: Readonly<Record<string, string>> = {
  "src/locale.ts": `export const LOCALE = "en-GB";\n`,

  "src/greet.ts": `import { LOCALE } from "./locale.js";

export function greet(name: string): string {
  return \`\${decorate(name)} (\${LOCALE})\`;
}

function decorate(name: string): string {
  return \`hello \${name}\`;
}
`,

  "src/shout.ts": `import { greet } from "./greet.js";

export function shout(name: string): string {
  return greet(name).toUpperCase();
}
`,

  "src/app.ts": `import { greet } from "./greet.js";
import { shout } from "./shout.js";

export function main(): string {
  return [greet("world"), shout("world")].join(" / ");
}
`,
};

let fixture: string;

beforeAll(() => {
  fixture = tmp("wecode-scope-proposal-");
  for (const [path, body] of Object.entries(FIXTURE)) {
    const file = join(fixture, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
});

/** A reader of the source, as the repository index.
 *
 *  Not codegraph: `@lzehrung/codegraph-core@2.3.27` does not declare its own `smol-toml`
 *  dependency and will not load in this workspace at all. That is one reason the command
 *  takes the index as an argument, and not the interesting one — a proposal is about the
 *  port's answers, and proving it against a second implementation is what says so. If
 *  these assertions held only for codegraph they would be about codegraph.
 *
 *  Crude on purpose: it finds declarations and uses by reading the lines, the way a person
 *  with grep would, so every answer below can be checked against the fixture by eye. */
class Reader implements RepoIndex {
  constructor(readonly root: string) {}

  private files(): readonly string[] {
    return Object.keys(FIXTURE);
  }

  private lines(file: string): readonly string[] {
    if (!this.files().includes(file)) throw new UnknownFile(file, this.root);
    return readFileSync(join(this.root, file), "utf8").split("\n");
  }

  async read(file: string): Promise<Reading> {
    const lines = this.lines(file);
    return {
      file,
      defines: lines.flatMap((text, i) => {
        const declared = /^(export\s+)?(function|const)\s+([A-Za-z_$][\w$]*)/.exec(text);
        if (declared === null) return [];
        const [, exported, keyword, name = ""] = declared;
        return [
          {
            name,
            kind: keyword === "function" ? ("function" as const) : ("variable" as const),
            line: i + 1,
            exported: exported !== undefined,
            doc: null,
          },
        ];
      }),
      imports: lines.flatMap((text) => {
        const line = /^import\s+\{\s*([^}]+?)\s*\}\s+from\s+"([^"]+)"/.exec(text);
        if (line === null) return [];
        const [, clause = "", from = ""] = line;
        const reached = posix.join(posix.dirname(file), from.replace(/\.js$/, ".ts"));
        const resolved = existsSync(join(this.root, reached)) ? reached : null;
        return clause.split(",").map((name) => ({ name: name.trim(), kind: "named" as const, from, resolved }));
      }),
    };
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
        if (path === file && i + 1 === declared.line) return;
        const at = new RegExp(`\\b${symbol}\\b`).exec(text.replace(/"[^"]*"/g, ""));
        if (at !== null) uses.push({ file: path, line: i + 1, column: at.index + 1 });
      });
    }
    return uses.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  async purposeOf(file: string): Promise<Purpose> {
    const reading = await this.read(file);
    return {
      file,
      doc: null,
      exports: reading.defines.filter((d) => d.exported).map((d) => d.name),
      dependents: [],
    };
  }
}

const index = (): RepoIndex => new Reader(fixture);

const at = (path: string, why: string): { path: string; why: string } => ({ path, why });

describe("a promise, as written", () => {
  it("is a module and a symbol", () => {
    expect(promised("packages/tui/src/list.ts:renderList")).toEqual({
      file: "packages/tui/src/list.ts",
      symbol: "renderList",
    });
  });

  it("is refused when it names no module", () => {
    expect(promised("renderList")).toBeNull();
    expect(promised(":renderList")).toBeNull();
    expect(promised("src/list.ts:")).toBeNull();
    expect(promised("")).toBeNull();
  });
});

describe("the scope a promise asks for", () => {
  it("is the promised module, and every file that uses the symbol", async () => {
    const proposal = await proposeScope(index(), [{ file: "src/greet.ts", symbol: "greet" }]);

    expect(proposal.write).toEqual(["src/app.ts", "src/greet.ts", "src/shout.ts"]);
    expect(proposal.because).toEqual([
      at("src/app.ts", "uses greet"),
      at("src/greet.ts", "promises greet"),
      at("src/shout.ts", "uses greet"),
    ]);
  });

  it("is the promised module alone when nothing outside it uses the symbol", async () => {
    const proposal = await proposeScope(index(), [{ file: "src/greet.ts", symbol: "decorate" }]);

    expect(proposal.write).toEqual(["src/greet.ts"]);
    expect(proposal.because).toEqual([at("src/greet.ts", "promises decorate")]);
  });

  it("says so when the index does not hold the promised module yet", async () => {
    const proposal = await proposeScope(index(), [{ file: "src/wave.ts", symbol: "wave" }]);

    expect(proposal.write).toEqual(["src/wave.ts"]);
    expect(proposal.because).toEqual([at("src/wave.ts", "promises wave, in a module the index does not hold yet")]);
  });

  it("lets nobody else in for a symbol the module does not declare yet", async () => {
    const proposal = await proposeScope(index(), [{ file: "src/greet.ts", symbol: "farewell" }]);

    expect(proposal.write).toEqual(["src/greet.ts"]);
    expect(proposal.because).toEqual([at("src/greet.ts", "promises farewell")]);
  });

  it("gathers several promises into one scope, each path said once", async () => {
    const proposal = await proposeScope(index(), [
      { file: "src/greet.ts", symbol: "greet" },
      { file: "src/greet.ts", symbol: "decorate" },
      { file: "src/locale.ts", symbol: "LOCALE" },
    ]);

    expect(proposal.write).toEqual(["src/app.ts", "src/greet.ts", "src/locale.ts", "src/shout.ts"]);
    expect(proposal.because).toEqual([
      at("src/app.ts", "uses greet"),
      // Promised for two of its names, and a user of a third — both halves are said.
      at("src/greet.ts", "promises decorate, greet; uses LOCALE"),
      at("src/locale.ts", "promises LOCALE"),
      at("src/shout.ts", "uses greet"),
    ]);
  });

  it("proposes nothing at all from no promises", async () => {
    expect(await proposeScope(index(), [])).toEqual({ write: [], because: [] });
  });

  it("does not swallow a broken index", async () => {
    const broken: RepoIndex = {
      root: fixture,
      read: () => Promise.reject(new Error("the index is a directory")),
      usesOf: () => Promise.reject(new Error("the index is a directory")),
      purposeOf: () => Promise.reject(new Error("the index is a directory")),
    };
    await expect(proposeScope(broken, [{ file: "src/greet.ts", symbol: "greet" }])).rejects.toThrow(
      "the index is a directory",
    );
  });
});

// ── the command ──────────────────────────────────────────────────────────────────────────

let out: string[];
let err: string[];
let repo: string;

const PROJECT = `stack: node
test: pnpm test
typecheck: tsc -b
source: ["src/**"]
tests: ["test/**"]
`;

beforeEach(() => {
  repo = tmp("wecode-plan-propose-");
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));

  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "0.0.1"]);
  run(["epic", "create", "--parent", "1", "the cockpit"]);
  run(["epic", "start", "1"]);
  out.length = 0;
});

afterEach(() => {
  delete process.env["WECODE_DB"];
  vi.restoreAllMocks();
});

const said = (): string => out.join("");
const complained = (): string => err.join("");

function file(body: string): string {
  const path = join(repo, "plan.yaml");
  writeFileSync(path, body);
  return path;
}

const PROMISING = `story: greeting is one function
epic: 1

requirements:
  - statement: one function greets
    criteria:
      - statement: it greets by name
        test: pnpm test
        tasks:
          - title: rewrite greet
            scope: ["src/**"]
            promises: ["src/greet.ts:greet", "src/wave.ts:wave"]
            role: engineer
`;

function count(table: string): number {
  const db = open(process.env["WECODE_DB"] as string);
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("wecode plan --propose-scope", () => {
  it("prints the scope each promising task asks for, and creates nothing", async () => {
    expect(plan([file(PROMISING), "--propose-scope", "--root", fixture], index)).toBe(0);
    expect(await proposedScope()).toBe(0);

    const text = said();
    expect(text).toContain("rewrite greet");
    // The line a person pastes into the plan file, and the reason for each path of it.
    expect(text).toContain('scope: ["src/app.ts", "src/greet.ts", "src/shout.ts", "src/wave.ts"]');
    expect(text).toMatch(/src\/greet\.ts\s+promises greet/);
    expect(text).toMatch(/src\/app\.ts\s+uses greet/);
    expect(text).toMatch(/src\/wave\.ts\s+promises wave, in a module the index does not hold yet/);

    expect(count("story")).toBe(0);
    expect(count("task")).toBe(0);
  });

  it("refuses a plan whose tasks promise nothing, and says what to write", async () => {
    const path = file(PROMISING.replace('            promises: ["src/greet.ts:greet", "src/wave.ts:wave"]\n', ""));
    expect(plan([path, "--propose-scope", "--root", fixture], index)).toBe(1);

    expect(complained()).toContain("no task in this plan promises a symbol");
    expect(complained()).toContain("promises:");
    expect(count("story")).toBe(0);
  });

  it("refuses a promise that is not file:symbol, before it asks the tree anything", () => {
    const path = file(PROMISING.replace('"src/greet.ts:greet"', '"greet"'));
    expect(plan([path, "--propose-scope", "--root", fixture], index)).toBe(1);

    expect(complained()).toContain("greet is not file:symbol");
    expect(count("story")).toBe(0);
  });

  it("documents the flag and the key in --help", () => {
    expect(plan(["--help"])).toBe(0);
    expect(said()).toContain("--propose-scope");
    expect(said()).toContain("promises");
  });

  it("leaves a promise out of what it creates — a scope is still written by a person", () => {
    expect(plan([file(PROMISING)], index)).toBe(0);
    expect(count("task")).toBe(1);

    const db = open(process.env["WECODE_DB"] as string);
    const task = db.prepare("SELECT scope FROM task WHERE id = 1").get() as { scope: string };
    expect(JSON.parse(task.scope).write).toEqual(["src/**"]);
  });
});
