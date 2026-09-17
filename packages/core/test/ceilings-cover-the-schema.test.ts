import { readdirSync } from "node:fs";
import { dirname, join, matchesGlob, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRoles, type Scope } from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGES = join(ROOT, "packages");

/** Not source: installed, built or cached. Everything else under `packages/` is work a
 *  story can be given, so a ceiling that cannot reach it is a ceiling that blocks work. */
const NOT_SOURCE = ["node_modules", "dist", "coverage", ".turbo"];

/** Build leavings that `tsc -b` drops beside a manifest. */
const BUILT = /\.tsbuildinfo$/;

/** A package root holds only its manifests, which name the package rather than implement
 *  it — changing one changes what the workspace *is*, so the engineer ceiling stops short
 *  of them on purpose. This is the only exemption the test below allows. */
const MANIFESTS = ["package.json", "tsconfig.json"];

/** Every file under `packages/`, as a repo-relative posix path — the shape a scope glob is
 *  written against. */
function sources(): readonly string[] {
  const found: string[] = [];
  walk(PACKAGES, "packages", (p) => found.push(p));
  return found.sort();
}

function walk(dir: string, prefix: string, seen: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || NOT_SOURCE.includes(entry.name)) continue;
    const path = posix.join(prefix, entry.name);
    if (entry.isDirectory()) walk(join(dir, entry.name), path, seen);
    else if (!BUILT.test(entry.name)) seen(path);
  }
}

const config = loadRoles(join(ROOT, "config", "roles.yaml"));
const engineer: Scope = config.roles.engineer?.scope ?? { write: [], tools: [] };

/** Real glob semantics, not `withinCeiling`'s glob-covers-glob approximation: that one
 *  compares stems, so `packages/` alone would answer yes for every path under it and the
 *  question would prove nothing. */
const reaches = (path: string): boolean => engineer.write.some((g) => matchesGlob(path, g));

describe("the engineer ceiling", () => {
  it("reaches the schema", () => {
    const schema = sources().filter((p) => p.startsWith("packages/core/sql/"));
    expect(schema.length).toBeGreaterThan(0);
    expect(schema.filter((p) => !reaches(p))).toEqual([]);
  });

  it("names the schema directory once, as a glob over every package", () => {
    expect(engineer.write).toContain("packages/*/sql/**");
  });

  it("leaves no source directory unreachable", () => {
    const missed = sources().filter((p) => !reaches(p));
    expect(missed.filter((p) => !MANIFESTS.includes(posix.basename(p)))).toEqual([]);
  });

  it("misses nothing below a package root", () => {
    const missed = sources().filter((p) => !reaches(p));
    expect(missed.filter((p) => !/^packages\/[^/]+$/.test(dirname(p)))).toEqual([]);
  });

  it("still loads with the schema admitted", () => {
    expect(() => loadRoles(join(ROOT, "config", "roles.yaml"))).not.toThrow();
  });
});
