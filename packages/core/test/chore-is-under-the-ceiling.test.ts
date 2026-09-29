import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `chore.ts` is judged by the ceiling, not by a row of its own.
 *
 *  It was one of the files that were already long the day the ceiling was set, so it had a
 *  ratchet row in `packages/core/config/project.yaml` recording how long it was. The row is
 *  a cap that only comes down; taking the file under the ceiling is what retires it. This
 *  holds both halves of that: the file is at or under the ceiling, and no row is left
 *  quietly permitting it to grow back.
 *
 *  The modules the split moved the consumers into are held to the same number, because a
 *  split that only moves the length somewhere else has not taken anything under the
 *  ceiling — and none of them is ratcheted, so the ceiling is all there is to meet.
 *
 *  No number is written here. The ceiling is the project's to change, and a copy of it in a
 *  test is a second definition somebody has to keep in agreement with the first — so the
 *  number is read out of the same configuration `a-file-has-a-ceiling.test.ts` reads. */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONFIG = join(REPO, "packages", "core", "config", "project.yaml");
const CHORE = "packages/core/src/chore.ts";
const UNDER = [
  "packages/core/src/chore/allocation.ts",
  "packages/core/src/chore/raise.ts",
  "packages/core/src/chore/reads.ts",
  "packages/core/src/chore/record.ts",
  "packages/core/src/chore/refusal.ts",
  "packages/core/src/chore/rows.ts",
  "packages/core/src/chore/view.ts",
];

/** The same flat grammar `a-file-has-a-ceiling.test.ts` reads by hand: one scalar and one
 *  mapping of file to length. */
function ceilings(text: string): { ceiling: number; over: ReadonlyMap<string, number> } {
  const lines = text.split("\n");
  const said = lines.find((l) => /^ceiling:/.test(l));
  const ceiling = said === undefined ? 0 : Number(said.slice("ceiling:".length).trim());
  const at = lines.findIndex((l) => l.trimEnd() === "over:");
  const over = new Map<string, number>();
  for (const line of at === -1 ? [] : lines.slice(at + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const row = /^\s+(\S+):\s*(\d+)\s*$/.exec(line);
    if (row === null) break;
    over.set((row[1] ?? "").replace(/^["']|["']$/g, ""), Number(row[2]));
  }
  return { ceiling, over };
}

const config = ceilings(readFileSync(CONFIG, "utf8"));
const lengthOf = (path: string): number => readFileSync(join(REPO, path), "utf8").split("\n").length - 1;

describe("chore.ts is under the ceiling the project declares", () => {
  it("has no ratchet row of its own", () => {
    expect(config.over.has(CHORE)).toBe(false);
  });

  it("is at or under the ceiling", () => {
    expect(config.ceiling).toBeGreaterThan(0);
    expect(lengthOf(CHORE)).toBeLessThanOrEqual(config.ceiling);
  });

  it("put the consumers in modules that are under it too, and ratcheted none of them", () => {
    expect(config.ceiling).toBeGreaterThan(0);
    for (const path of UNDER) {
      expect(config.over.has(path), `${path} has a ratchet row`).toBe(false);
      expect(lengthOf(path), path).toBeLessThanOrEqual(config.ceiling);
    }
  });
});
