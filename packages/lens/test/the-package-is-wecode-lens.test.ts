import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The package is `@wecode/lens`, everywhere and only.
 *
 *  A rename is only finished when the old name is unreachable. Half a rename is worse than
 *  none: a manifest saying `lens` beside an import saying `ui` resolves through whatever
 *  stale symlink the last install left behind, and the day that link is gone the build
 *  fails somewhere unrelated to the file that lied. So what is asserted here is not that
 *  the new name works — every other suite in the repository proves that by importing it —
 *  but that the old one is gone: no directory, no manifest name, no dependency, no
 *  specifier, no path, in any file a human wrote.
 *
 *  The map is asserted for the same reason and in the same breath: `package:` in
 *  components.yaml is a directory name, checked against the tree by
 *  components-cover-the-tree.test.ts, so a row still saying `ui` is a map pointing at
 *  nothing. */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGES = join(ROOT, "packages");

const SKIP = new Set(["node_modules", ".git", "dist", ".wecode", "coverage"]);
const READABLE = [".ts", ".tsx", ".json", ".yaml", ".yml", ".md"];

/** Every file in the repository a person maintains — no build output, no lockfile, which
 *  is generated and names the old package only as long as nobody has installed since. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const at = join(dir, entry.name);
    if (entry.isDirectory()) sources(at, found);
    else if (entry.name !== "pnpm-lock.yaml" && READABLE.some((e) => entry.name.endsWith(e))) {
      found.push(at);
    }
  }
  return found;
}

// Assembled rather than written out, because this file is one of the files it reads: a
// literal here would be the one hit every search below is looking for.
const OLD_PACKAGE = ["@wecode", "ui"].join("/");
const OLD_DIRECTORY = ["packages", "ui", ""].join("/");

const naming = (needle: string): string[] =>
  sources(ROOT)
    .filter((f) => readFileSync(f, "utf8").includes(needle))
    .map((f) => f.slice(ROOT.length));

describe("@wecode/lens", () => {
  it("is the directory the package lives in", () => {
    expect(statSync(join(PACKAGES, "lens")).isDirectory()).toBe(true);
    expect(existsSync(join(PACKAGES, "ui"))).toBe(false);
  });

  it("is the name its manifest declares", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGES, "lens", "package.json"), "utf8"));
    expect(manifest.name).toBe("@wecode/lens");
  });

  it("is the name every dependant declares", () => {
    const dependants: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const at = join(PACKAGES, pkg, "package.json");
      if (!existsSync(at)) continue;
      const manifest = JSON.parse(readFileSync(at, "utf8"));
      const all = { ...manifest.dependencies, ...manifest.devDependencies };
      if ("@wecode/lens" in all) dependants.push(pkg);
      expect(Object.keys(all), `${pkg} still depends on the old name`).not.toContain(OLD_PACKAGE);
    }
    // The gate over the cockpit's design is the reason the package exists; if nothing
    // reaches it, this test is passing by naming nobody.
    expect(dependants).toContain("tui");
  });

  it("is the only specifier any file names", () => {
    expect(naming(OLD_PACKAGE), "files still importing the old package").toEqual([]);
  });

  // Source and config only, and deliberately not tests: a test may write `packages/ui/...`
  // into a temporary tree as a fixture, where the string is a made-up path and not a
  // reference to this package at all. In `src/` and in `config/` there is no such reading —
  // the path either resolves or the file is wrong about the repository.
  it("is the only path the source and the config name", () => {
    const real = sources(PACKAGES)
      .filter((f) => f.includes("/src/") || f.includes("/config/"))
      .filter((f) => readFileSync(f, "utf8").includes(OLD_DIRECTORY))
      .map((f) => f.slice(ROOT.length));
    expect(real, "files still pointing at the old directory").toEqual([]);
  });

  // The specifier a sibling package reaches this one by when it does not declare it —
  // `../../lens/...`. It is the one form the other two searches cannot see: it names
  // neither the package nor a path beginning `packages/`, and it fails at collection time
  // rather than at an assertion, so the suite that misses it reports no tests rather than
  // a red one.
  it("is the only directory a sibling climbs into", () => {
    const climbing = new RegExp("\\.\\./ui/");
    const stale = sources(PACKAGES)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .filter((f) => climbing.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length));
    expect(stale, "files still reaching the old directory by path").toEqual([]);
  });

  it("is the package the component map claims the view-index in", () => {
    const map = readFileSync(join(PACKAGES, "core", "config", "components.yaml"), "utf8");
    const row = map.slice(map.indexOf("\n  view-index:"));
    expect(row.slice(0, row.indexOf("\n  owns:"))).toContain("package: lens");
  });
});
