/** The cockpit, proved the way it is used: the built binary in a terminal of its own. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { open } from "@wecode/core";
import { Cockpit, text } from "./pty.js";
import { seed } from "./seed.js";

/** The glyph each head opens with is read out of the config the board reads it out of, so
 *  a mark this file looks for cannot be a transcription of one — it is the same character,
 *  from the same line, and an edit to the design moves the screen and this file at once.
 *  `proposal.marks` is the design's answer for the seven boxes; the lead section is not one
 *  of them — no filter, no letter, no glyph in the proposal — so it keeps views.yaml's. */
const config = <T,>(name: string): T =>
  parse(readFileSync(fileURLToPath(new URL(`../config/${name}`, import.meta.url)), "utf8")) as T;

const marks = config<{ proposal: { marks: Record<string, string> } }>("design.yaml").proposal.marks;
const lead = config<{ services: { mark: string } }>("views.yaml").services.mark;

/** A section the design forgot would spell its head `undefined NAME`, which is still a
 *  string a head can be looked for by — so a missing glyph is a red here and not a silent
 *  pass over a head nobody drew. */
const mark = (section: string): string => {
  const glyph = marks[section];
  expect(glyph, `the design marks no ${section}`).toHaveLength(1);
  return glyph as string;
};

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

/** Every cockpit this file opens, so the one a failing assertion skipped past is still
 *  closed. `Cockpit.open` can also throw after spawning — a pty that never draws — and
 *  then there is no cockpit to register at all, so the kill cannot stop at the handles. */
const opened: Cockpit[] = [];

const start = async (cols = 100): Promise<Cockpit> => {
  const cockpit = await Cockpit.open({ db, cols });
  opened.push(cockpit);
  return cockpit;
};

/** A cockpit is two processes — `script` and the node it wrapped — and only the outer one
 *  has a handle, so after the handles are closed the process table is asked whether the
 *  workspace this file made is still open anywhere. `a-test-leaves-no-process-behind.test.ts`
 *  is the proof that this leaves nothing. */
const alive = (): string[] =>
  execFileSync("ps", ["-e", "-o", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(dir))
    .map((line) => line.trim());

afterEach(async () => {
  for (const cockpit of opened.splice(0)) await cockpit.close();
  const started = Date.now();
  for (let left = alive(); left.length > 0; left = alive()) {
    for (const line of left) {
      try {
        process.kill(Number(line.split(/\s+/)[0]), "SIGKILL");
      } catch {
        /* it left between the listing and the signal, which is the outcome wanted */
      }
    }
    if (Date.now() - started > 15_000) throw new Error(`still alive:\n${left.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
});

const drive = async (run: (c: Cockpit) => Promise<void>, cols = 100): Promise<void> => {
  const cockpit = await start(cols);
  await run(cockpit);
};

describe("the built cockpit, driven in a terminal", () => {
  it("draws the board it was pointed at", async () => {
    await drive(async (cockpit) => {
      const frame = cockpit.frame();
      // A head is a mark and a name now, with its count at the far right of the same line,
      // so the head is matched by its mark and name and the count is looked for on that
      // line rather than pinned to the padding between them. The count carries the letter
      // that opens the box, raised — plain on Queue, which is the one key Unicode has no
      // superscript for.
      const heads = [
        [`${lead} SERVICES`, ""],
        [`${mark("needs_you")} NEEDS YOU`, "0ⁿ"],
        [`${mark("running")} RUNNING`, "0ʳ"],
        [`${mark("queue")} QUEUE`, "1q"],
        [`${mark("cooking")} COOKING`, "0ᶜ"],
        [`${mark("planned")} PLANNED`, "0ᵖ"],
        [`${mark("delivered")} DELIVERED`, "0ᵈ"],
        [`${mark("dropped")} DROPPED`, "0ˣ"],
      ];
      const lines = frame.split("\n");
      for (const [head, count] of heads) {
        const line = lines.find((l) => l.trimStart().startsWith(head ?? ""));
        expect(line, `no ${head} head in:\n${frame}`).toBeDefined();
        expect(line).toContain(count);
      }
      // In order, top to bottom, so a box that moved is a red and not a pass by accident.
      const at = (head: string): number => lines.findIndex((l) => l.trimStart().startsWith(head));
      const order = heads.map(([head]) => at(head ?? ""));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // The seed's one ready task, in Queue.
      expect(frame).toContain("send the reset mail");
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
    const cockpit = await start();
    expect(await cockpit.quit()).toBe(0);
  }, 30_000);
});

describe("the frame as text", () => {
  it("is what a reader sees and nothing a terminal was told", () => {
    expect(text("[7m[31mrunner[39m[27m   \r\n  ok  ")).toBe("runner\n  ok");
  });
});
