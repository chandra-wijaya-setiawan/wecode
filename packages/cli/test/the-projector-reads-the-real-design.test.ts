import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { design, type Ports } from "../src/ui.js";
import { expected } from "../../ui/src/expected.js";
import { wireframe } from "../../ui/src/wireframe.js";
import { tmp } from "../../core/test/tmpdir.js";

/** That `wecode design show` reads a design file the way the gate reads one.
 *
 *  A design is written as yaml and the gate over the cockpit's design parses it with
 *  `yaml` (packages/tui/src/views.ts). The command used to fall back to `JSON.parse` when
 *  `yaml` did not resolve, which made the set of documents that count as a design depend on
 *  which dependency happened to be installed: a file with a comment in it — which is every
 *  design anyone has actually written — passed the gate and failed to draw.
 *
 *  So these run the command with its own default reader, never a stub, against yaml that
 *  is not also json. a-design-is-projected.test.ts proves what the command does with a
 *  design; this proves which files reach it at all.
 *
 *  The reader is still the command's, because `packages/cli` is the package that declares
 *  `yaml`. What the reader hands back is now read by `@wecode/ui`'s loader, the same one the
 *  gate reads its design file with — which is why the last case below can say "exactly as
 *  the gate reads it" and mean the one function rather than two that agree today.
 *  the-real-design-projects.test.ts is where that sharing is proved. */

const GATE_DESIGN = fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url));

/** A design as a person writes one: comments, unquoted keys, no braces, an anchor reused. */
const AS_WRITTEN = `# The cockpit, declared before it is drawn.
screens:
  cockpit:
    name: Cockpit
    width: 80
    height: 24
    parts:
      # The box that answers first.
      - name: Needs you
        width: 80
        height: &half 10
        at: { x: 0, y: 0 }
        key: n
      - name: Running
        width: 80
        height: 14
        at:
          x: 0
          y: *half
        key: r
`;

function fileOf(text: string, name = "design.yaml"): string {
  const at = join(tmp("wecode-real-design-"), name);
  writeFileSync(at, text);
  return at;
}

const svgAt = (name = "cockpit.svg"): string => join(tmp("wecode-real-design-"), name);
const ports = (): Ports => ({ expected, wireframe } as unknown as Ports);

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});
afterEach(() => vi.restoreAllMocks());

const complained = (): string => err.join("");

describe("wecode design show, on a design as it is actually written", () => {
  it("draws a yaml design that is not also json, with its default reader", async () => {
    const at = svgAt();
    const code = await design(["show", "cockpit", "--from", fileOf(AS_WRITTEN), "--out", at], ports);
    expect(complained()).toBe("");
    expect(code).toBe(0);
    expect(existsSync(at)).toBe(true);
  });

  it("reads the numbers yaml states, so the boxes land where the design put them", async () => {
    const at = svgAt("placed.svg");
    expect(await design(["show", "cockpit", "--from", fileOf(AS_WRITTEN), "--out", at], ports)).toBe(0);
    const svg = readFileSync(at, "utf8");
    expect(svg).toContain('width="80" height="24"');
    expect(svg).toContain('<rect x="0" y="0" width="80" height="10"');
    expect(svg).toContain('<rect x="0" y="10" width="80" height="14"');
    for (const name of ["Cockpit", "Needs you", "Running"]) expect(svg).toContain(`>${name}<`);
  });

  it("still reads a design written as json, because json is yaml", async () => {
    const json = JSON.stringify({
      screens: { detail: { name: "Detail", width: 40, height: 8 } },
    });
    const at = svgAt("detail.svg");
    expect(await design(["show", "detail", "--from", fileOf(json, "design.json"), "--out", at], ports)).toBe(0);
    expect(readFileSync(at, "utf8")).toContain(">Detail<");
  });

  it("reads the gate's own design file exactly as the gate reads it", async () => {
    const text = readFileSync(GATE_DESIGN, "utf8");
    // Nothing stubbed at all: the loader that answers is the gate's, reached from here.
    const mine = await design(["show", "cockpit", "--from", GATE_DESIGN, "--out", svgAt("gate.svg")]);
    // The gate's file declares the cockpit's frame, not a screen the projection draws, so
    // the command refuses it for that reason and for no other: it parsed.
    expect(mine).toBe(2);
    expect(complained()).toContain("declares no screens");
    expect(parse(text)).toMatchObject({ page: { lead: "services" } });
  });

  it("refuses yaml that does not parse, and says so rather than drawing", async () => {
    const at = svgAt("broken.svg");
    const code = await design(["show", "cockpit", "--from", fileOf("screens:\n  - [a\n"), "--out", at], ports);
    expect(code).toBe(2);
    expect(complained()).toContain("cannot read the design at");
    expect(existsSync(at)).toBe(false);
  });
});
