import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ui, type Finding, type Rules } from "../src/ui.js";
import { tmp } from "../../core/test/tmpdir.js";

/** What a tester gets from `wecode ui check`.
 *
 *  The four rules are proved where they live, against captures, in `packages/lens`. What is
 *  unproven until here is the thing a gate actually consumes: that pointing the command at
 *  a capture with a fault in it makes the process fail, that a clean capture does not, and
 *  that a capture it could not read is neither of those. So the rules are a stub whose
 *  answer the test decides, and every assertion below is about the command. */

const CLEAN: unknown = { name: "Board", at: { x: 0, y: 0, width: 10, height: 3 }, rows: ["one"] };

const CLIPPED: Finding = {
  rule: "clipped",
  node: "Board > Queue",
  says: "drawn at 0,0 20x3, outside its parent at 0,0 10x3",
};

/** A capture on disk, and the path a tester would type. */
function captureOf(tree: unknown, name = "capture.json"): string {
  const at = join(tmp("wecode-lens-"), name);
  writeFileSync(at, JSON.stringify(tree));
  return at;
}

/** Rules that answer what the test says, and record the tree they were handed. */
function saying(...found: Finding[]): { rules: () => Rules; seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    rules: () => (capture: unknown) => {
      seen.push(capture);
      return found;
    },
  };
}

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});
afterEach(() => vi.restoreAllMocks());

const printed = (): string => out.join("");
const complained = (): string => err.join("");

describe("wecode ui check", () => {
  it("exits non-zero when the rules report a finding", async () => {
    const { rules } = saying(CLIPPED);
    expect(await ui(["check", captureOf(CLEAN)], rules)).toBe(1);
  });

  it("says which rule broke, in which box, and why", async () => {
    const { rules } = saying(CLIPPED);
    await ui(["check", captureOf(CLEAN)], rules);
    expect(printed()).toContain("1 finding");
    expect(printed()).toContain("clipped: Board > Queue — drawn at 0,0 20x3, outside its parent at 0,0 10x3");
  });

  it("exits zero on a capture with nothing against it, and says it is clean", async () => {
    const { rules } = saying();
    expect(await ui(["check", captureOf(CLEAN)], rules)).toBe(0);
    expect(printed()).toContain("clean");
  });

  it("hands the rules the capture as written, unreshaped", async () => {
    const { rules, seen } = saying();
    await ui(["check", captureOf(CLEAN)], rules);
    expect(seen).toEqual([CLEAN]);
  });

  it("gives every finding as the rules gave it under --json", async () => {
    const second: Finding = { rule: "empty box", node: "Board > Detail", says: "holds no rows and no empty line" };
    const { rules } = saying(CLIPPED, second);
    expect(await ui(["check", captureOf(CLEAN), "--json"], rules)).toBe(1);
    expect(JSON.parse(printed())).toEqual([CLIPPED, second]);
  });

  it("tells a capture it could not read apart from a screen that is wrong", async () => {
    const missing = join(tmp("wecode-lens-"), "nothing.json");
    const { rules } = saying();
    expect(await ui(["check", missing], rules)).toBe(2);
    expect(complained()).toContain("cannot read the capture");
  });

  it("refuses a capture that is not json, rather than calling it clean", async () => {
    const at = join(tmp("wecode-lens-"), "capture.json");
    writeFileSync(at, "not json at all");
    const { rules, seen } = saying();
    expect(await ui(["check", at], rules)).toBe(2);
    expect(seen).toEqual([]);
  });

  it("exits 2 when the rules themselves cannot answer", async () => {
    const broken = (): Rules => {
      throw new Error("@wecode/lens exports no check — packages/cli does not depend on it yet");
    };
    expect(await ui(["check", captureOf(CLEAN)], broken)).toBe(2);
    expect(complained()).toContain("does not depend on it yet");
  });

  it("asks for a capture when none was named", async () => {
    const { rules } = saying();
    expect(await ui(["check"], rules)).toBe(2);
    expect(complained()).toContain("wecode ui check <capture.json>");
  });

  it("answers a question it does not have with the manual, and fails", async () => {
    const { rules } = saying();
    expect(await ui(["lint", "x.json"], rules)).toBe(2);
    expect(complained()).toContain("no such question: lint");
    expect(printed()).toContain("wecode ui check <capture.json>");
  });

  it("prints the manual and succeeds when asked nothing", async () => {
    const { rules } = saying();
    expect(await ui([], rules)).toBe(0);
    expect(printed()).toContain("Exit: 0 clean, 1 at least one finding, 2 the capture could not be checked.");
  });
});
