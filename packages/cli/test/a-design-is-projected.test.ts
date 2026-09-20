import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { design, type Ports, type Read } from "../src/ui.js";
import { expected } from "../../ui/src/expected.js";
import { wireframe } from "../../ui/src/wireframe.js";
import { tmp } from "../../core/test/tmpdir.js";

/** What an operator gets from `wecode design show`.
 *
 *  The projection is proved in `packages/ui` — that a tree draws at the coordinates it
 *  states, that a design's offsets add up. What is unproven until here is that a person who
 *  types the command ends up with a file they can open: that the design named on the command
 *  line is the one drawn, that every section it declares is a box in the file, and that a
 *  design that cannot be read fails loudly instead of leaving a stale svg behind.
 *
 *  So the ports are the real `expected` and `wireframe` rather than stubs. The only thing
 *  between them is the command, which is what these assertions are about: stub them and the
 *  test would assert that a fake returned a fake, and the one join that can be wrong — a
 *  captured node's `name` reaching the drawing as its `title` — would go unproved. */

/** A design with two sections, each a box inside the page, at the coordinates it states. */
const TWO_SECTIONS = {
  screens: {
    cockpit: {
      name: "Cockpit",
      width: 80,
      height: 24,
      parts: [
        { name: "Needs you", width: 80, height: 10, at: { x: 0, y: 0 }, key: "n", rows: ["one"] },
        { name: "Running", width: 80, height: 14, at: { x: 0, y: 10 }, key: "r", rows: ["two"] },
      ],
    },
  },
};

const ports = (): Ports => ({ expected, wireframe } as unknown as Ports);
const asJson: () => Read = () => (text: string) => JSON.parse(text) as unknown;

/** A design file on disk, and the path an operator would type. */
function designOf(declared: unknown, name = "design.yaml"): string {
  const at = join(tmp("wecode-design-"), name);
  writeFileSync(at, JSON.stringify(declared));
  return at;
}

const svgAt = (name = "cockpit.svg"): string => join(tmp("wecode-design-"), name);

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

/** The command, run against the two-section design, answering where it wrote. */
async function show(extra: readonly string[] = []): Promise<{ code: number; at: string }> {
  const at = svgAt();
  const code = await design(
    ["show", "cockpit", "--from", designOf(TWO_SECTIONS), "--out", at, ...extra],
    ports,
    asJson,
  );
  return { code, at };
}

describe("wecode design show", () => {
  it("writes a file where it was told to, and exits zero", async () => {
    const { code, at } = await show();
    expect(code).toBe(0);
    expect(existsSync(at)).toBe(true);
  });

  it("writes an svg, sized to the page the design declared", async () => {
    const { at } = await show();
    const svg = readFileSync(at, "utf8");
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="80" height="24"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("draws a box per declared section, at the coordinates the design gave it", async () => {
    const { at } = await show();
    const svg = readFileSync(at, "utf8");
    expect(svg).toContain('<rect x="0" y="0" width="80" height="10"');
    expect(svg).toContain('<rect x="0" y="10" width="80" height="14"');
    expect([...svg.matchAll(/<rect /g)]).toHaveLength(3);
  });

  it("names every section in the drawing, so a reviewer can tell the boxes apart", async () => {
    const { at } = await show();
    const svg = readFileSync(at, "utf8");
    for (const name of ["Cockpit", "Needs you", "Running"]) expect(svg).toContain(`>${name}<`);
  });

  it("says where it wrote, and says nothing else", async () => {
    const { at } = await show();
    expect(printed()).toBe(`${at}\n`);
    expect(complained()).toBe("");
  });

  it("draws the screen that was named, not the first one declared", async () => {
    const two = {
      screens: {
        cockpit: TWO_SECTIONS.screens.cockpit,
        detail: { name: "Detail", width: 40, height: 8 },
      },
    };
    const at = svgAt("detail.svg");
    expect(await design(["show", "detail", "--from", designOf(two), "--out", at], ports, asJson)).toBe(0);
    const svg = readFileSync(at, "utf8");
    expect(svg).toContain(">Detail<");
    expect(svg).not.toContain(">Cockpit<");
  });

  it("refuses a screen the design file does not declare, and names the ones it does", async () => {
    const at = svgAt("missing.svg");
    const code = await design(
      ["show", "outline", "--from", designOf(TWO_SECTIONS), "--out", at],
      ports,
      asJson,
    );
    expect(code).toBe(2);
    expect(complained()).toContain("declares no screen outline");
    expect(complained()).toContain("cockpit");
    expect(existsSync(at)).toBe(false);
  });

  it("refuses a design file that is not there, rather than writing an empty drawing", async () => {
    const at = svgAt("nothing.svg");
    const missing = join(tmp("wecode-design-"), "nowhere.yaml");
    expect(await design(["show", "cockpit", "--from", missing, "--out", at], ports, asJson)).toBe(2);
    expect(complained()).toContain("cannot read the design at");
    expect(existsSync(at)).toBe(false);
  });

  it("refuses a file that parses but declares no screens", async () => {
    const at = svgAt("noscreens.svg");
    const file = designOf({ page: { lead: "services" } });
    expect(await design(["show", "cockpit", "--from", file, "--out", at], ports, asJson)).toBe(2);
    expect(complained()).toContain("declares no screens");
    expect(existsSync(at)).toBe(false);
  });

  it("passes on what the projection refuses rather than drawing it anyway", async () => {
    const outside = {
      screens: {
        cockpit: {
          name: "Cockpit",
          width: 10,
          height: 4,
          parts: [{ name: "Queue", width: 20, height: 4, at: { x: 0, y: 0 } }],
        },
      },
    };
    const at = svgAt("clipped.svg");
    expect(await design(["show", "cockpit", "--from", designOf(outside), "--out", at], ports, asJson)).toBe(2);
    expect(complained()).toContain("cannot draw cockpit");
    expect(complained()).toContain("does not fit its parent");
    expect(existsSync(at)).toBe(false);
  });

  it("exits 2 when the projection cannot be reached at all", async () => {
    const broken = (): Ports => {
      throw new Error("@wecode/ui exports no expected/wireframe — packages/cli does not depend on it yet");
    };
    const code = await design(
      ["show", "cockpit", "--from", designOf(TWO_SECTIONS), "--out", svgAt()],
      broken,
      asJson,
    );
    expect(code).toBe(2);
    expect(complained()).toContain("does not depend on it yet");
  });

  it("asks for a screen when none was named", async () => {
    expect(await design(["show"], ports, asJson)).toBe(2);
    expect(complained()).toContain("wecode design show <screen>");
  });

  it("answers a question it does not have with the manual, and fails", async () => {
    expect(await design(["draw", "cockpit"], ports, asJson)).toBe(2);
    expect(complained()).toContain("no such question: draw");
    expect(printed()).toContain("wecode design show <screen>");
  });

  it("prints the manual and succeeds when asked nothing", async () => {
    expect(await design([], ports, asJson)).toBe(0);
    expect(printed()).toContain("Exit: 0 written, 2 the screen could not be drawn.");
  });
});
