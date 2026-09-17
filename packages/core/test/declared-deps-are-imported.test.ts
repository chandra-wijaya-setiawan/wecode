import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `.ts` file the package ships or tests with. A dependency earns its place in
 *  package.json by being imported from one of these. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The package names imported anywhere in the package — the specifier's first segment, or
 *  its first two when it is scoped, so `yaml/util` counts as `yaml`. Relative and `node:`
 *  specifiers are nobody's dependency. */
function imported(): Set<string> {
  const names = new Set<string>();
  const specifier = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (const file of [...sources(join(pkgRoot, "src")), ...sources(join(pkgRoot, "test"))]) {
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(specifier)) {
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const parts = (spec as string).split("/");
      names.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string));
    }
  }
  return names;
}

const declared = (): string[] =>
  Object.keys(
    (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    }).dependencies ?? {},
  );

describe("the manifest of @wecode/core", () => {
  it("declares nothing the package does not import", () => {
    const used = imported();
    expect(declared().filter((name) => !used.has(name))).toEqual([]);
  });

  it("no longer declares the query builders", () => {
    expect(declared()).not.toContain("kysely");
    expect(declared()).not.toContain("kysely-node-sqlite");
  });

  it("still declares yaml, which the config loaders import", () => {
    expect(declared()).toContain("yaml");
    expect(imported()).toContain("yaml");
  });

  it("notices a dependency nothing imports", () => {
    // The check is only worth having if it fails on the shape it is meant to catch.
    const used = imported();
    expect(["yaml", "kysely"].filter((name) => !used.has(name))).toEqual(["kysely"]);
  });
});
