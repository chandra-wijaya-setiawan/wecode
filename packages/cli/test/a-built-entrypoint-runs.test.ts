import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** A `bin` entry is a promise that the file can be run, not merely imported. `tsc` writes
 *  its output 0644, so the shebang in the source is a comment and the promise is broken
 *  until the build hands the file its exec bit back. This proves it for the cockpit, whose
 *  build is the one that was missing the step. */
const pkg = fileURLToPath(new URL("../../tui", import.meta.url));

const declared = (): Record<string, string> =>
  JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).bin;

/** The path the package.json promises, resolved against the package. */
const entrypoint = (): string => join(pkg, declared()["wecode-tui"]);

describe("the cockpit's built entrypoint", () => {
  it("is declared as a bin, so something will try to run it", () => {
    expect(declared()).toEqual({ "wecode-tui": "./dist/bin.js" });
  });

  it("carries a shebang, which only an exec bit makes meaningful", () => {
    expect(readFileSync(entrypoint(), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("is executable after a build", () => {
    // Every class that can reach it — owner, group, other — or a `pnpm link` leaves a bin
    // one of them cannot start.
    expect(statSync(entrypoint()).mode & 0o111).toBe(0o111);
  });

  it("runs when spawned as itself, with no node in front of it", () => {
    // Asked for a workspace that is not there, the cockpit says so and exits 1. Reaching
    // that sentence at all means the kernel honoured the shebang.
    const r = spawnSync(entrypoint(), ["--db", join(pkg, "does-not-exist.db")], {
      encoding: "utf8",
    });
    expect(r.error).toBeUndefined();
    expect(r.stderr).toContain("no wecode workspace at");
    expect(r.status).toBe(1);
  });

  it("keeps the exec bit in the build script, not in whoever last ran chmod", () => {
    const build = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).scripts.build;
    expect(build).toContain("chmod +x ./dist/bin.js");
  });
});
