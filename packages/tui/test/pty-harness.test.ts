/** The cockpit, proved the way it is used: the built binary in a terminal of its own. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { open } from "@wecode/core";
import { Cockpit, text } from "./pty.js";
import { seed } from "./seed.js";

let dir: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wecode-pty-"));
  db = join(dir, "wecode.db");
  const handle = open(db);
  seed(handle);
  handle.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const drive = async (run: (c: Cockpit) => Promise<void>, cols = 100): Promise<void> => {
  const cockpit = await Cockpit.open({ db, cols });
  try {
    await run(cockpit);
  } finally {
    await cockpit.close();
  }
};

describe("the built cockpit, driven in a terminal", () => {
  it("draws the board it was pointed at", async () => {
    await drive(async (cockpit) => {
      const frame = cockpit.frame();
      // The seven boxes the page draws now, in order: no Projects box — the outline is the
      // way out to the workspace — and the seed's ready task in Queue, which is a box of its
      // own again rather than a row folded in with what has given up.
      expect(frame).toContain("Needs you (0) [n]");
      expect(frame).toContain("Running (0) [r]");
      expect(frame).toContain("Queue (1) [q]");
      expect(frame).toContain("send the reset mail");
      expect(frame).toContain("Cooking (0) [c]");
      expect(frame).toContain("Planned (0) [p]");
      expect(frame).toContain("Delivered (0) [d]");
      expect(frame).toContain("Dropped (0) [x]");
      expect(frame).toContain("j/k move");
    });
  }, 30_000);

  it("draws to the width of the terminal it was given", async () => {
    await drive(async (cockpit) => {
      const widths = new Set(cockpit.frame().split("\n").map((line) => [...line].length));
      expect(Math.max(...widths)).toBe(60);
    }, 60);
  }, 30_000);

  /** Raw mode is the half no in-process test reaches: a key read by the terminal, not by a
   *  pipe. The status line is the cockpit saying it heard one. */
  it("answers a keystroke with a new frame", async () => {
    await drive(async (cockpit) => {
      expect(cockpit.frame()).toContain("workspace ");
      // The first key replaces the workspace line, so the frame says it was heard.
      expect(await cockpit.press("t")).toContain("t e steps the outline in");
      expect(cockpit.drawn).toBe(2);
      // And a chord is two keys, both read raw, one frame apart.
      await cockpit.press("v");
      expect(await cockpit.press("t")).toContain("Outline");
    });
  }, 30_000);

  it("leaves when it is told to, and gives the terminal back", async () => {
    const cockpit = await Cockpit.open({ db });
    expect(await cockpit.quit()).toBe(0);
  }, 30_000);
});

describe("the frame as text", () => {
  it("is what a reader sees and nothing a terminal was told", () => {
    expect(text("[7m[31mrunner[39m[27m   \r\n  ok  ")).toBe("runner\n  ok");
  });
});
