import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as runner from "../src/index.js";
import { Examiner } from "../src/examiner.js";

const src = (name: string): string => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

/** The design gives the examiner a row of its own: it administers a proof, and the gate
 *  judges it. The old name said "scripts", which is the artefact, not the part. A rename
 *  is only done when nothing still answers to the old name. */
describe("the runner names its examiner", () => {
  it("carries the examiner where the scripts module used to be", () => {
    expect(existsSync(src("examiner.ts"))).toBe(true);
    expect(existsSync(src("scripts.ts"))).toBe(false);
  });

  it("exports Examiner and nothing called Scripts", () => {
    expect(runner.Examiner).toBe(Examiner);
    expect("Scripts" in runner).toBe(false);
  });

  it("keeps the examiner's two ways of administering a proof", () => {
    const proto = Examiner.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.runTaskTests).toBe("function");
    expect(typeof proto.runAcceptanceTests).toBe("function");
  });
});
