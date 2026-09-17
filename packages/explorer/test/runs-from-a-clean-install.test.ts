import { builtinModules, createRequire } from "node:module";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { openCodegraph } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** That the explorer works in the installation it is actually installed into.
 *
 *  `@lzehrung/codegraph-core@2.3.27` imports `smol-toml` from
 *  `dist/util/resolution/cargo-targets.js` without declaring it. Under pnpm's strict
 *  node_modules an undeclared import is unresolvable from the package that made it, so
 *  every codegraph entry point threw on load and every question about a real repository
 *  was skipped. Declaring `smol-toml` here puts it in the workspace, and pnpm's hoisted
 *  fallback — `node_modules/.pnpm/node_modules` — is what codegraph then resolves it
 *  through.
 *
 *  So the dependency is declared by the package that suffers the omission, not by the one
 *  that made it. That is the only place in this workspace that can declare it: the
 *  explorer is the sole importer of codegraph, and a dependency it needs to load at all
 *  is its dependency whoever forgot to write it down.
 *
 *  The first suite is the one that survives a version bump: it asks the installed
 *  codegraph what it imports and does not declare, and holds the explorer to declaring
 *  every one. The second asks the questions, against a repository on disk, with nothing
 *  skipped — because a suite that skips itself when the install is broken cannot be the
 *  proof that the install is not. */

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

/** The package a specifier names, subpath and all removed: `smol-toml/x` is `smol-toml`,
 *  `@lzehrung/codegraph-native/y` is `@lzehrung/codegraph-native`. */
const packageOf = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
};

const BUILTIN = new Set(builtinModules);
/** What npm will accept as a package name. The scan below reads source with a regex, so it
 *  also catches things that are not specifiers at all — a JSON key, a sentence containing
 *  the word `import`. Anything that could not be a package is not one. */
const NAME = /^(?:@[a-z0-9~][a-z0-9._-]*\/)?[a-z0-9~][a-z0-9._-]*$/;
const isBare = (specifier: string) =>
  !specifier.startsWith(".") &&
  !specifier.startsWith("#") &&
  !specifier.startsWith("node:") &&
  NAME.test(packageOf(specifier)) &&
  !BUILTIN.has(packageOf(specifier));

/** Every bare package the installed codegraph's own code imports. */
const importedBy = (root: string): ReadonlySet<string> => {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
        const source = readFileSync(path, "utf8");
        for (const [, specifier] of source.matchAll(
          /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g,
        )) {
          if (specifier !== undefined && isBare(specifier)) found.add(packageOf(specifier));
        }
      }
    }
  };
  walk(join(root, "dist"));
  return found;
};

describe("the dependency codegraph omits", () => {
  // Resolved rather than guessed at: the point is to interrogate the codegraph this
  // package actually loads, wherever pnpm put it.
  const root = join(
    dirname(createRequire(import.meta.url).resolve("@lzehrung/codegraph-core")),
    "..",
  );
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  /** What codegraph imports and never wrote down. `smol-toml` today; the test is about the
   *  gap, not about the name, so a version that closes it leaves this empty and the
   *  suite still passes. */
  const undeclared = () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      "@lzehrung/codegraph-core",
    ]);
    return [...importedBy(root)].filter((name) => !declared.has(name)).sort();
  };

  it("is imported by codegraph's own code", () => {
    // If this ever finds nothing, the omission is fixed upstream and the declaration
    // below is merely redundant — which the next assertion tolerates.
    expect(undeclared()).toContain("smol-toml");
  });

  it("is declared here, so the install resolves it", () => {
    for (const name of undeclared()) expect(MANIFEST.dependencies).toHaveProperty([name]);
  });

  it("loads, which is the whole of what declaring it buys", async () => {
    await expect(import("@lzehrung/codegraph-core")).resolves.toBeDefined();
  });

  it("loads from the entry point the adapter actually opens an index through", async () => {
    await expect(import("@lzehrung/codegraph-core/indexer")).resolves.toBeDefined();
  });
});

/** A repository, small enough to read and big enough that no verb answers trivially:
 *  `greet.ts` imports a name from inside the tree, declares one it exports and one it
 *  keeps, carries a doc comment, and is imported by one other file. */
const FIXTURE: Readonly<Record<string, string>> = {
  "package.json": `{ "name": "clean-install-fixture", "version": "0.0.0", "type": "module" }\n`,
  "tsconfig.json": `{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }\n`,
  "src/locale.ts": `export const LOCALE = "en-GB";\n`,
  "src/greet.ts": `/** Greeting words, and nothing about who is listening. */
import { LOCALE } from "./locale.js";

/** Greets by name. */
export function greet(name: string): string {
  return \`\${decorate(name)} (\${LOCALE})\`;
}

function decorate(name: string): string {
  return \`hello \${name}\`;
}
`,
  "src/app.ts": `import { greet } from "./greet.js";

export function main(): string {
  return greet("world");
}
`,
};

describe("every explore verb, against a repository on disk", () => {
  let root: string;

  beforeAll(() => {
    root = tmp("wecode-clean-install-");
    for (const [path, body] of Object.entries(FIXTURE)) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
  });

  it("reads what a file defines and what it brings in", async () => {
    const reading = await openCodegraph(root).read("src/greet.ts");
    expect(reading.file).toBe("src/greet.ts");
    expect(reading.defines.map((d) => [d.name, d.kind, d.exported])).toEqual([
      ["decorate", "function", false],
      ["greet", "function", true],
    ]);
    expect(reading.defines.find((d) => d.name === "greet")?.doc).toBe("Greets by name.");
    expect(reading.imports).toEqual([
      { name: "LOCALE", kind: "named", from: "./locale.js", resolved: "src/locale.ts" },
    ]);
  });

  it("finds who references a symbol, and not the declaration itself", async () => {
    const uses = await openCodegraph(root).usesOf("src/greet.ts", "greet");
    expect(uses.length).toBeGreaterThan(0);
    expect([...new Set(uses.map((u) => u.file))]).toContain("src/app.ts");
    for (const use of uses) {
      const lines = readFileSync(join(root, use.file), "utf8").split("\n");
      expect(lines[use.line - 1] ?? "").toContain("greet");
      if (use.file === "src/greet.ts") expect(lines[use.line - 1] ?? "").not.toContain("export");
    }
  });

  it("carries the evidence of what a module is for", async () => {
    const purpose = await openCodegraph(root).purposeOf("src/greet.ts");
    expect(purpose.doc).toBe("Greeting words, and nothing about who is listening.");
    expect(purpose.exports).toEqual(["greet"]);
    expect(purpose.dependents).toEqual(["src/app.ts"]);
  });

  it("refuses a file the repository does not hold", async () => {
    await expect(openCodegraph(root).read("src/nowhere.ts")).rejects.toThrow(
      /does not hold it/,
    );
  });
});
