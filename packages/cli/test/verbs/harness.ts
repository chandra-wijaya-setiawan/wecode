/** What every verb-module test needs and none of them should own: a database of its own,
 *  stdout and stderr captured into arrays, and the two readers that turn them back into
 *  text. Shared because the four files under `verbs/` are one suite cut four ways, not
 *  four suites that happen to look alike. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { tmp } from "../../../core/test/tmpdir.js";

export const out: string[] = [];
export const err: string[] = [];

/** What the cli printed, and what it complained. */
export const said = (): string => out.join("");
export const cried = (): string => err.join("");

/** A source file of the cli, read as text, for the tests that assert on what a module
 *  says rather than on what it does. */
export const source = (f: string): string =>
  readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

/** Call once at the top of a describe: a fresh database and clean pipes per test. */
export const freshCli = (): void => {
  beforeEach(() => {
    process.env["WECODE_DB"] = join(tmp("wecode-cli-"), "wecode.db");
    out.length = 0;
    err.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
  });
  afterEach(() => vi.restoreAllMocks());
};
