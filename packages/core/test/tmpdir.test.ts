import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tmp } from "./tmpdir.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const leaked = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("wecode-"));

/** Runs the one-test fixture in a nested vitest and hands back the directory it made.
 *  The run fails, which is what it is for, so a non-zero exit is expected. */
function runFailingFixture(): string {
  const record = join(tmp("wecode-record-"), "dir");
  try {
    execFileSync("npx", ["vitest", "run", "--config", "packages/core/test/fixtures/tmpdir-throws.config.ts"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, WECODE_TMPDIR_RECORD: record, CI: "1" },
    });
    throw new Error("the fixture was supposed to fail");
  } catch (e) {
    if (!existsSync(record)) throw e;
  }
  return readFileSync(record, "utf8").trim();
}

describe("the shared temp directory helper", () => {
  let made: string;

  it("makes a directory under the system temp directory", () => {
    made = tmp("wecode-gone-");
    expect(existsSync(made)).toBe(true);
    expect(dirname(made)).toBe(tmpdir());
  });

  it("has removed the directory the test before it made", () => {
    expect(existsSync(made)).toBe(false);
  });

  it("removes the directory even when the test that made it fails", () => {
    const dir = runFailingFixture();
    expect(dir).toMatch(/wecode-throws-/);
    expect(existsSync(dir)).toBe(false);
  }, 120_000);

  it("removes a tree that still has files in it", () => {
    const dir = tmp("wecode-full-");
    writeFileSync(join(dir, "a"), "a");
    const seen = leaked();
    expect(seen).toContain(dir.slice(tmpdir().length + 1));
  });

  it("has removed that non-empty tree too", () => {
    expect(leaked().filter((n) => n.startsWith("wecode-full-"))).toEqual([]);
  });
});
