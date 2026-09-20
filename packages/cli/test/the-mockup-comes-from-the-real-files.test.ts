/** That the picture an operator is asked to sign is the screen the gate holds the code to.
 *
 *  The projector could draw any design file and could not draw the product's own screens:
 *  views.yaml and design.yaml declare the cockpit, the detail page and the outline, and
 *  `wecode design show` had no way to reach them, so the mockup of a wecode screen was
 *  drawn by hand into whatever document it was pasted into. A hand-drawn mockup is a second
 *  answer to what the screen is — the gate holds the code to the config and the operator
 *  signed the picture, and nothing made the two agree.
 *
 *  So `--real` calls the gate's own translation, `screenDesign`, and draws what comes back.
 *  What is proven here is that the call is the gate's and not a copy of it: the same three
 *  screens the gate derives come out of the command, an edit to views.yaml moves the
 *  picture, and the refusal for a screen nobody declared names the ones that are. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { design } from "../src/ui.js";
import { check, expected } from "../../ui/src/index.js";
import { loadViews, screenDesign, screenNames } from "../../tui/src/views.js";
import { tmp } from "../../core/test/tmpdir.js";

const SCREEN = { width: 80, height: 30 };
const VIEWS = fileURLToPath(new URL("../../tui/config/views.yaml", import.meta.url));

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
const svgAt = (name: string): string => join(tmp("wecode-real-mockup-"), name);

/** The command with nothing stubbed at all — no ports, no reader, no translation. That is
 *  the whole claim: run as an operator runs it, it reaches `@wecode/ui` and `@wecode/tui`
 *  and writes a file. */
async function drawn(screen: string, ...rest: string[]): Promise<string> {
  const at = svgAt(`${screen}.svg`);
  const code = await design(["show", screen, "--real", "--out", at, ...rest]);
  expect(complained()).toBe("");
  expect(code).toBe(0);
  expect(printed()).toBe(`${at}\n`);
  return readFileSync(at, "utf8");
}

describe("the three real screens, drawn from the files that declare them", () => {
  it("draws the cockpit with every box views.yaml orders, under the head design.yaml asks for", async () => {
    const svg = await drawn("cockpit");
    expect(svg).toContain('width="80" height="30"');
    for (const view of loadViews()) expect(svg).toContain(`>${view.title.toUpperCase()}<`);
    expect(svg).toContain(">SERVICES<");
    expect(svg).toContain(">Key bar<");
  });

  it("draws the detail page as its title pattern, with the sections a node carries", async () => {
    const svg = await drawn("detail");
    expect(svg).toContain(">{what} · {state}<");
    expect(svg).toContain(">block<");
    expect(svg).toContain(">children ({count}) · {tally}<");
    expect(svg).toContain(">proof ({count}) · {tally}<");
    // Two footer lines, the record's above the global one on the terminal's last line.
    expect(svg).toContain(">record<");
    expect(svg).toContain('y="28"');
    expect(svg).toContain('y="29"');
  });

  it("draws the outline under the title and letter views.yaml gives it", async () => {
    const svg = await drawn("outline");
    expect(svg).toContain(">Outline<");
    expect(svg).toContain(">tree<");
  });

  it("names the screens the config declares when asked for one it does not", async () => {
    const at = svgAt("nope.svg");
    expect(await design(["show", "weather", "--real", "--out", at])).toBe(2);
    expect(complained()).toContain("no such screen weather");
    for (const name of screenNames()) expect(complained()).toContain(name);
    expect(existsSync(at)).toBe(false);
  });

  it("draws for the terminal it is given, and refuses a size that is not one", async () => {
    expect(await drawn("cockpit", "--size", "120x40")).toContain('width="120" height="40"');
    const at = svgAt("bad.svg");
    expect(await design(["show", "cockpit", "--real", "--size", "wide", "--out", at])).toBe(2);
    expect(complained()).toContain("--size is <width>x<height>, not wide");
  });
});

describe("the picture is the gate's own translation and not a copy of it", () => {
  it("is box for box what the gate derives, for every screen the config declares", () => {
    for (const name of screenNames()) {
      const box = screenDesign(name, SCREEN);
      expect(check(expected(box))).toEqual([]);
      expect(box.width).toBe(SCREEN.width);
      expect(box.height).toBe(SCREEN.height);
    }
  });

  it("moves when views.yaml moves, with no edit to the projector", async () => {
    const text = readFileSync(VIEWS, "utf8");
    expect(text).toContain("title: Outline");
    const to = join(tmp("wecode-real-mockup-"), "views.yaml");
    writeFileSync(to, text.replace("title: Outline", "title: The whole tree"));
    const box = screenDesign("outline", SCREEN, {}, { views: to });
    expect(box.name).toBe("The whole tree");
    expect(screenDesign("outline", SCREEN).name).toBe("Outline");
  });

  it("puts nothing in the picture the two files do not say", async () => {
    // Every box name is a word out of views.yaml or design.yaml. The detail page's are
    // the file's own keys and title patterns, so a literal invented here would show up as
    // a name neither file contains.
    const files = [
      readFileSync(VIEWS, "utf8"),
      readFileSync(fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url)), "utf8"),
    ].join("\n");
    const names = (box: { name: string; parts?: readonly { name: string }[] }): string[] => [
      box.name,
      ...(box.parts ?? []).flatMap((p) => names(p)),
    ];
    for (const name of names(screenDesign("detail", SCREEN))) {
      const word = name.split(" ")[0] ?? "";
      expect(files, `${name} is in neither file`).toContain(word.replace(/[{}]/g, ""));
    }
  });
});
