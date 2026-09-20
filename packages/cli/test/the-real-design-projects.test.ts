import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { design } from "../src/ui.js";
import { designDocument, designScreen, DesignError } from "../../ui/src/expected.js";
import { cockpitDesign, ViewError } from "../../tui/src/views.js";
import { tmp } from "../../core/test/tmpdir.js";

/** That there is one reader of a design file, and that both sides reach it.
 *
 *  Until now the projector had a reader of its own — `screens:`, the screen under a name,
 *  the sentences said when neither is there — and the gate over the cockpit had another.
 *  Two readers of one file format is two answers to "is this a design": a file the gate
 *  accepts can fail to draw, and nobody finds out until an operator types the command. The
 *  reader is now `@wecode/ui`'s, beside `expected`, which is the module that has to make
 *  sense of what comes back.
 *
 *  So what is asserted here is the pointing, not the reading: that the projector run with
 *  no ports and no reader stubbed draws a real design file — which it could not do before,
 *  because it could not reach `@wecode/ui` at all — and that the gate refuses the documents
 *  the loader refuses, in the loader's own words. The loader's rules are proved against the
 *  loader, once, because there is now one place they live. */

const GATE_DESIGN = fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url));

/** A design as a person writes one: comments, unquoted keys, an anchor reused. */
const AS_WRITTEN = `# The cockpit, declared before it is drawn.
screens:
  cockpit:
    name: Cockpit
    width: 80
    height: 24
    parts:
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
  const at = join(tmp("wecode-one-loader-"), name);
  writeFileSync(at, text);
  return at;
}

const svgAt = (name: string): string => join(tmp("wecode-one-loader-"), name);

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

describe("the design loader, where it now lives", () => {
  it("reads the screen a document declares under a name", () => {
    const doc = { screens: { cockpit: { name: "Cockpit", width: 80, height: 24 } } };
    expect(designScreen(doc, "cockpit", "design.yaml")).toEqual({
      name: "Cockpit",
      width: 80,
      height: 24,
    });
  });

  it("refuses a document that is not a mapping at all, and names the file", () => {
    expect(() => designDocument("a design, surely", "design.yaml")).toThrow(DesignError);
    expect(() => designDocument([], "design.yaml")).toThrow("design.yaml is not a mapping");
  });

  it("refuses a document with no screens in it", () => {
    expect(() => designScreen({ page: { lead: "services" } }, "cockpit", "views.yaml")).toThrow(
      "views.yaml declares no screens",
    );
  });

  it("names the screens it does declare, so a typo is one word from the answer", () => {
    const doc = { screens: { cockpit: {}, detail: {} } };
    expect(() => designScreen(doc, "outline", "design.yaml")).toThrow(
      "design.yaml declares no screen outline — it declares cockpit, detail",
    );
  });

  it("refuses a screen that is not a box, rather than handing a string to the projection", () => {
    expect(() => designScreen({ screens: { cockpit: "soon" } }, "cockpit", "d.yaml")).toThrow(
      "d.yaml declares cockpit as something other than a box",
    );
  });
});

describe("the projector, pointed at that loader", () => {
  it("draws a real design file with nothing stubbed — no ports, no reader, no selection", async () => {
    const at = svgAt("cockpit.svg");
    const code = await design(["show", "cockpit", "--from", fileOf(AS_WRITTEN), "--out", at]);
    expect(complained()).toBe("");
    expect(code).toBe(0);
    expect(printed()).toBe(`${at}\n`);
    const svg = readFileSync(at, "utf8");
    expect(svg).toContain('width="80" height="24"');
    expect(svg).toContain('<rect x="0" y="10" width="80" height="14"');
    for (const name of ["Cockpit", "Needs you", "Running"]) expect(svg).toContain(`>${name}<`);
  });

  it("refuses a screen the file does not declare in the loader's own words", async () => {
    const at = svgAt("missing.svg");
    expect(await design(["show", "outline", "--from", fileOf(AS_WRITTEN), "--out", at])).toBe(2);
    expect(complained()).toContain("declares no screen outline — it declares cockpit");
    expect(existsSync(at)).toBe(false);
  });

  it("refuses the gate's own design file for the one reason the loader gives", async () => {
    // The gate's file declares the cockpit's frame, not a screen the projection draws. It
    // parses, and the refusal is the loader's sentence about `screens:` and no other.
    expect(await design(["show", "cockpit", "--from", GATE_DESIGN, "--out", svgAt("g.svg")])).toBe(2);
    expect(complained()).toContain("declares no screens");
  });
});

describe("the gate, pointed at the same loader", () => {
  it("still reads the cockpit's design out of the two files that declare it", () => {
    const box = cockpitDesign({ width: 80, height: 30 });
    expect(box.name).toBe("Cockpit");
    expect((box.parts ?? []).length).toBeGreaterThan(1);
  });

  it("refuses a design file the loader refuses, in the loader's words under its own error", () => {
    const notAMapping = fileOf("a design, surely\n", "flat.yaml");
    expect(() => cockpitDesign({ width: 80, height: 30 }, {}, { design: notAMapping })).toThrow(
      ViewError,
    );
    expect(() => cockpitDesign({ width: 80, height: 30 }, {}, { design: notAMapping })).toThrow(
      "flat.yaml is not a mapping",
    );
  });

  it("names the file that was wrong, which one sentence for both files could not", () => {
    const notAMapping = fileOf("- a\n- list\n", "views-as-a-list.yaml");
    expect(() => cockpitDesign({ width: 80, height: 30 }, {}, { views: notAMapping })).toThrow(
      "views-as-a-list.yaml is not a mapping",
    );
  });
});
