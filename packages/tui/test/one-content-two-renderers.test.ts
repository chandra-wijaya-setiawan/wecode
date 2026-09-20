/** design.yaml is one design read by two renderers, and says which half is whose.
 *
 *  The tree `views.ts` builds out of this file is read twice: by the ink gate, which holds
 *  the terminal to it, and by the SVG projector, which draws a picture of it for a person
 *  to sign. While every statement sat at the top level there was nothing to say which
 *  renderer each was addressed to, and the two readings had to argue — the projector held
 *  to a rule character it has no way to draw, or the terminal excused a decision that was
 *  never about characters at all.
 *
 *  So the file is in two halves. `shared` is what the screen *is*: which sections there
 *  are, what a record's page holds, what a row of the tree says, which keys the screen
 *  answers, and the proposal that was signed. `renderers` is what one renderer draws and
 *  another does not: a `─` filled to the width, a border spent on a page, a bar pinned to
 *  the last line.
 *
 *  This file holds the split to four things:
 *    - both halves exist, and every block lives in exactly one of them;
 *    - the shared half names no character a renderer would have to draw;
 *    - the terminal half is only characters, lines and columns, and every other renderer
 *      declares what it does instead of each of them;
 *    - the top-level names the gate's other tests still read are aliases of those one
 *      definitions and not second copies — an edit to either is an edit to both.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { cockpitDesign, outlineDesign, screenNames } from "../src/views.js";

const TEXT = readFileSync(
  fileURLToPath(new URL("../config/design.yaml", import.meta.url)),
  "utf8",
);
const design = parse(TEXT) as Record<string, any>;

const shared = design.shared as Record<string, any>;
const renderers = design.renderers as Record<string, any>;

/** Every character a renderer has to draw *as a character*. A statement in the shared half
 *  that named one of these would be a terminal's answer filed as if it were the screen. */
const GLYPHS = ["─", "│", "┌", "┐", "└", "┘", "├", "┤", "═"];

describe("one content, two renderers", () => {
  it("is in two halves, a shared one and a renderer one", () => {
    expect(shared).toBeTruthy();
    expect(renderers).toBeTruthy();
    expect(Object.keys(shared).length).toBeGreaterThan(0);
    expect(Object.keys(renderers).length).toBeGreaterThan(1);
  });

  it("declares more than one renderer, so the split has something to be a split between", () => {
    expect(Object.keys(renderers)).toEqual(["terminal", "wireframe"]);
  });

  it("puts every block in exactly one half, so no block has two homes", () => {
    for (const name of Object.keys(shared)) {
      for (const renderer of Object.keys(renderers)) {
        expect(renderers[renderer], `${name} is in shared and in ${renderer}`).not.toHaveProperty(
          name,
        );
      }
    }
  });

  it("keeps the whole screen in the shared half: every screen the gate names is declared", () => {
    // `screenNames` reads `detail.screens`, which is a shared block — a translation that
    // could not find it would be reading a half that no longer holds the screens.
    expect(screenNames()).toEqual(["cockpit", "detail", "outline", "node", "assignment"]);
    for (const block of ["page", "detail", "outline", "key_bar", "proposal"]) {
      expect(shared, block).toHaveProperty(block);
    }
  });

  it("names no glyph in the shared half — a character is a renderer's answer, not a screen's", () => {
    // The proposal is the exception it declares itself to be: its marks are the states'
    // own vocabulary, which is the content of a head and not the drawing of one. Nothing
    // else in the shared half may spell a box out of line characters.
    const { proposal: _signed, ...rest } = shared;
    const written = JSON.stringify(rest);
    for (const glyph of GLYPHS) expect(written, glyph).not.toContain(glyph);
  });

  it("keeps the terminal's characters, lines and columns in the terminal's half", () => {
    const terminal = renderers.terminal as Record<string, any>;
    expect(terminal.head.glyph).toBe("─");
    expect(terminal.head.case).toBe("upper");
    expect(terminal.dashboard.chrome).toBe("rule");
    expect(terminal.dashboard.rows_begin_at_column).toBe(0);
    expect(terminal.pages.chrome).toBe("border");
    expect(terminal.bars.key_bar).toBe("last");
    // And the box-drawing characters a rule exists to avoid spending are refused here,
    // where a rule is a thing: no other renderer has a column to save.
    expect(terminal.dashboard.forbidden).toContain("│");
  });

  it("makes the other renderer answer each of them rather than inherit them", () => {
    const { wireframe } = renderers as Record<string, any>;
    expect(wireframe.glyphs).toBe("none");
    expect(wireframe.fill).toBe("none");
    expect(wireframe.case).toBe("as_written");
    expect(wireframe.chrome).toBe("outline");
    expect(wireframe.bars).toBe("as_boxes");
    expect(wireframe.draws).toEqual(["box", "title"]);
    // A picture that spelled a box out of line characters would be drawing a terminal.
    for (const glyph of GLYPHS) expect(JSON.stringify(wireframe), glyph).not.toContain(glyph);
  });

  it("gives each renderer an answer for everything the other one states", () => {
    // Not a subset check on names — the two renderers use different words for the same
    // decision — but on count: a renderer with fewer statements than the terminal has is
    // one that is quietly inheriting a terminal's answer to something.
    const terminal = Object.keys(renderers.terminal as object);
    for (const [name, block] of Object.entries(renderers)) {
      if (name === "terminal") continue;
      expect(Object.keys(block as object).length, name).toBeGreaterThanOrEqual(terminal.length);
    }
  });
});

describe("the names the gate's other tests still read", () => {
  /** The blocks that still answer to a top-level name, and the half each is defined in. */
  const ALIASES: readonly [string, "shared" | "terminal"][] = [
    ["page", "shared"],
    ["detail", "shared"],
    ["outline", "shared"],
    ["key_bar", "shared"],
    ["proposal", "shared"],
    ["dashboard", "terminal"],
    ["head", "terminal"],
    ["pages", "terminal"],
    ["bars", "terminal"],
  ];

  it("is an alias of the one definition and never a second copy of it", () => {
    for (const [name, half] of ALIASES) {
      const declared = half === "shared" ? shared[name] : (renderers.terminal as any)[name];
      // The same node, not an equal one: yaml resolves the alias to the very object the
      // anchor named, so an edit to either is an edit to both and they cannot drift.
      expect(design[name], name).toBe(declared);
    }
  });

  it("is written as an alias in the file, so the text holds one definition too", () => {
    for (const [name] of ALIASES) {
      expect(TEXT, name).toContain(`\n${name}: *${name}`);
    }
  });

  it("leaves every block reachable from a half, so deleting the tail is a rename", () => {
    const halves = new Set([
      ...Object.keys(shared),
      ...Object.keys(renderers.terminal as object),
    ]);
    for (const [name] of ALIASES) expect(halves.has(name), name).toBe(true);
  });
});

describe("the gate reads the split and not the tail", () => {
  it("still derives the cockpit when the tail is gone", () => {
    // The translation is pointed at the two halves, so a file with no compatibility names
    // at all still draws — which is what makes the tail deletable.
    const at = withoutTail();
    const box = cockpitDesign({ width: 80, height: 30 }, {}, { design: at });
    expect(box.name).toBe("Cockpit");
    expect((box.parts ?? [])[0]?.name).toBe("SERVICES");
    expect((box.parts ?? []).at(-1)?.at?.y).toBe(29);
  });

  it("still derives the outline when the tail is gone", () => {
    const box = outlineDesign({ width: 80, height: 30 }, {}, { design: withoutTail() });
    expect((box.parts ?? [])[0]?.rows?.length).toBe(5);
  });
});

/** The file with its compatibility tail cut off, written somewhere else: everything up to
 *  the comment that introduces the aliases. Reading the design back out of a copy is the
 *  only way to say the tree came from the halves rather than from the names above them. */
function withoutTail(): string {
  const cut = TEXT.indexOf("\n# The names the gate's tests still reach");
  expect(cut).toBeGreaterThan(0);
  const at = join(mkdtempSync(join(tmpdir(), "wecode-split-")), "design.yaml");
  writeFileSync(at, TEXT.slice(0, cut + 1));
  return at;
}
