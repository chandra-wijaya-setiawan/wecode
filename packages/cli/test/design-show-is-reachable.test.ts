import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answered, run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

/** `wecode design …` is two commands under one word.
 *
 *  The projector is proved in `a-design-is-projected.test.ts`, which calls `design()`
 *  directly; the ledger's verbs are proved wherever their entity is. What neither proves is
 *  that the word on the command line reaches the right one of them — before this, `design
 *  show` fell through to the entity path and was answered "design has no states", and the
 *  projector could only be run by importing it.
 *
 *  So these assertions are about the fork and nothing else: `show` draws, every other verb
 *  is the row. */

/** A design file with one screen, and the path an operator would type. */
function designOf(): string {
  const at = join(tmp("wecode-route-"), "design.yaml");
  writeFileSync(
    at,
    JSON.stringify({
      screens: {
        cockpit: {
          name: "Cockpit",
          width: 80,
          height: 24,
          parts: [{ name: "Needs you", width: 80, height: 10, at: { x: 0, y: 0 }, key: "n", rows: ["one"] }],
        },
      },
    }),
  );
  return at;
}

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const printed = (): string => out.join("");
const complained = (): string => err.join("");

/** The command line, awaited: the projector answers later than dispatch returns. */
async function wecode(...argv: readonly string[]): Promise<number> {
  const immediate = run(argv);
  const settled = await answered();
  return immediate === 0 ? settled : immediate;
}

describe("wecode design show", () => {
  it("reaches the projector, which answers about the screen it was asked for", async () => {
    // Either outcome is the projector's, and which one it is depends on a dependency this
    // scope cannot declare: `packages/cli` does not depend on `@wecode/ui` yet, so the
    // ports fail to load and the command says it could not draw. What is asserted here is
    // the only thing the routing decides — that the projector is what answered.
    const at = join(tmp("wecode-route-"), "cockpit.svg");
    await wecode("design", "show", "cockpit", "--from", designOf(), "--out", at);
    if (existsSync(at)) {
      const svg = readFileSync(at, "utf8");
      expect(svg).toContain('width="80" height="24"');
      expect(svg).toContain(">Cockpit<");
      expect(printed()).toBe(`${at}\n`);
    } else {
      expect(complained()).toContain("cannot draw cockpit");
    }
  });

  it("is not answered by the entity path — no talk of states, no id", async () => {
    const at = join(tmp("wecode-route-"), "states.svg");
    await wecode("design", "show", "cockpit", "--from", designOf(), "--out", at);
    expect(complained()).not.toContain("has no states");
    expect(complained()).not.toContain("wecode design show <id>");
  });

  it("passes the projector's refusal on, and its exit code with it", async () => {
    const at = join(tmp("wecode-route-"), "missing.svg");
    expect(await wecode("design", "show", "outline", "--from", designOf(), "--out", at)).toBe(2);
    expect(complained()).toContain("declares no screen outline");
    expect(existsSync(at)).toBe(false);
  });

  it("settles a non-zero exit code on the process, the way explore does", async () => {
    const at = join(tmp("wecode-route-"), "exit.svg");
    run(["design", "show", "outline", "--from", designOf(), "--out", at]);
    await answered();
    expect(process.exitCode).toBe(2);
  });

  it("asks for a screen when none was named, rather than reading it as an id", async () => {
    expect(await wecode("design", "show")).toBe(2);
    expect(complained()).toContain("wecode design show <screen>");
    expect(complained()).not.toContain("wecode design show <id>");
  });
});

describe("wecode design <any other verb>", () => {
  it("sends create to the entity, not to the projector", async () => {
    await wecode("design", "create", "--parent", "1", "the cockpit");
    expect(complained()).not.toContain("no such question: create");
    expect(printed()).not.toContain("write a wireframe of the declared screen");
  });

  it("does not let create write a drawing", async () => {
    const at = join(tmp("wecode-route-"), "created.svg");
    await wecode("design", "create", "cockpit", "--from", designOf(), "--out", at);
    expect(existsSync(at)).toBe(false);
  });

  it("sends a verb that is neither to the entity, which knows what design is not", async () => {
    await wecode("design", "sign", "1");
    expect(complained()).not.toContain("no such question: sign");
    expect(printed()).not.toContain("Exit: 0 written, 2 the screen could not be drawn.");
  });

  it("answers `wecode design` with nothing at all by asking for a verb", async () => {
    expect(await wecode("design")).toBe(1);
    expect(complained()).toContain("wecode design <verb>");
  });
});
