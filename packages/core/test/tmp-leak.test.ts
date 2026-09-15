import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { open, sweepTempDatabases } from "../src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../dist/store.js");

const dbDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("wecode-db-"));

describe("the database directory open() makes under test", () => {
  it("is swept away with the rest of the run's temp directories", () => {
    const before = dbDirs();
    const db = open();
    db.close();
    const made = dbDirs().filter((n) => !before.includes(n));
    expect(made).toHaveLength(1);

    sweepTempDatabases();
    expect(existsSync(join(tmpdir(), made[0] as string))).toBe(false);
  });

  it("sweeps every directory the process made, not only the last", () => {
    const before = dbDirs();
    for (const db of [open(), open(), open()]) db.close();
    const made = dbDirs().filter((n) => !before.includes(n));
    expect(made).toHaveLength(3);

    sweepTempDatabases();
    expect(dbDirs().filter((n) => !before.includes(n))).toEqual([]);
  });

  it("is gone once the process that asked for it exits", () => {
    const script = `
      const { open } = await import(${JSON.stringify(dist)});
      const db = open();
      console.log(db.prepare("PRAGMA database_list").get().file);
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, VITEST: "1" },
    }).trim();

    expect(dirname(out)).toMatch(/wecode-db-/);
    expect(existsSync(dirname(out))).toBe(false);
  }, 30_000);
});
