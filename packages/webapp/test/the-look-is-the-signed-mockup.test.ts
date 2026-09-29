/** The colours and the faces the web surface is drawn in are the signed mockup's.
 *
 *  The look was already declared in one place — `renderers.webapp.look` — but what it
 *  declared was not what anybody signed: a dark surface in ten greys and one blue, set
 *  throughout in one monospace face. That was what the five pages happened to spell at the
 *  moment the look was lifted out of them. The mockup the person approved is a light paper
 *  surface set in three faces: a serif for what is read, a sans for the surface, a mono for
 *  what must line up.
 *
 *  So this file pins the values themselves. The mockup is an artifact and not a file of this
 *  repository, so its `:root` is transcribed below, colour for colour and stack for stack,
 *  and that transcription is the contract: the design may be edited, but not away from it
 *  without editing this file, which is the same as asking for the mockup to be signed again.
 *  Where the artifact is on the machine, it is read and held to agreeing with the
 *  transcription too — so the record cannot quietly drift from the thing it records.
 *
 *  `the-shell-is-the-signed-design.test.ts` asks the other half of the question: that the
 *  look is declared once, scoped per page, and spent by name. This one asks only whether the
 *  values are the signed ones.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLook, type Rules, stylesheet } from "../src/pages/shell.js";

const LOOK = loadLook();
const SHEET = stylesheet();

/** The mockups' `:root`, transcribed. The name on the left is what the colour is for on this
 *  surface; the name in the comment is what the mockup calls it.
 *
 *  Two signed mockups. The shell's — `.lavish/webapp-design.html` — signed **ten** colours,
 *  and for a long time only seven of them were ever lifted out of it: `--amber`, `--red` and
 *  `--vio` were dropped in transcription, which is story #561 in full. The tree then spent the
 *  seven on questions they cannot answer, so `failed` took plain ink for want of a red that was
 *  sitting in the file all along.
 *
 *  Nothing caught it, because this file used to name the seven mappings it wanted checked and
 *  assert those agreed. A transcription checked that way can only ever confirm what it already
 *  says; it cannot notice a colour it left out. So the check below runs the other way round:
 *  every `--name:#hex` in the mockup's own `:root` must be a colour this palette holds, whatever
 *  it is called here. Add an eleventh to the artifact and this file fails until somebody
 *  decides what it is for.
 *
 *  Sketch #7, "the tree you can read", signs the four lane hues — one colour a branch, the way
 *  a commit graph does. Those answer a question the shell mockup has no opinion about, because
 *  the shell has no tree in it. */
const SIGNED_PALETTE: Readonly<Record<string, string>> = {
  page: "#f8f7f3", // --bg / --page
  raised: "#fdfcfa", // --panel / --raised
  rule: "#e5e2d9", // --line / --rule
  ink: "#1f2328", // --ink
  faint: "#6b7178", // --dim / --faint
  mark: "#2f6f77", // --cyan / --mark
  good: "#3d6b4f", // --green / --good
  // The three the shell mockup signed and the transcription dropped.
  warn: "#a4711c", // --amber
  stop: "#a8423a", // --red
  violet: "#5b4d8a", // --vio
  // Sketch #7's four lane hues.
  "lane-story": "#2f6f77", // --lane-story
  "lane-req": "#8a5a2b", // --lane-req
  "lane-crit": "#5a5a8c", // --lane-crit
  "lane-task": "#6b7178", // --lane-task
};

/** What the shell mockup calls each of them. Every colour in its `:root` is here, which is what
 *  the check below holds it to: a name missing from this map is a colour nobody decided about. */
const CALLED: Readonly<Record<string, string>> = {
  "--bg": "page", "--panel": "raised", "--line": "rule", "--ink": "ink", "--dim": "faint",
  "--cyan": "mark", "--green": "good", "--amber": "warn", "--red": "stop", "--vio": "violet",
};

/** The mockup's three faces, first name and fallbacks both. A stack is signed whole: the
 *  fallback is what the surface is actually set in on a machine without the first. */
const SIGNED_TYPE: Readonly<Record<string, string>> = {
  serif: '"Newsreader", Georgia, "Times New Roman", serif',
  sans: '"Source Sans 3", "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** The shell's mockup, if this machine has it. It is written beside the checkout it was drawn
 *  for, which is the parent of this worktree when the work is done in one. */
const MOCKUP = [
  "../../../.lavish/webapp-design.html",
  // …and a worktree of it sits two levels down, under `.wecode/worktrees`.
  "../../../../../.lavish/webapp-design.html",
  "../../../../../../.lavish/webapp-design.html",
]
  .map((at) => fileURLToPath(new URL(at, import.meta.url)))
  .find((at) => existsSync(at));

/** Sketch #7, which is where the lane and state hues were signed. A sketch is written into the
 *  workspace it was drawn in, which is the operator's own directory and not this repository's —
 *  so it is looked for under every workspace this machine has rather than at one path. */
const SKETCH = existsSync(join(homedir(), ".wecode/workspaces"))
  ? readdirSync(join(homedir(), ".wecode/workspaces"))
      .map((w) => join(homedir(), ".wecode/workspaces", w, "sketches/the-tree-you-can-read-2.html"))
      .find((at) => existsSync(at))
  : undefined;

/** Every declaration in the look, wherever it sits. */
const declarations = (rules: Rules): readonly string[] =>
  Object.values(rules).flatMap((held) =>
    typeof held === "string" ? [held] : declarations(held as Rules),
  );

const everyRule = [LOOK.frame, ...Object.values(LOOK.pages)];
const everyDeclaration = everyRule.flatMap((rules) => declarations(rules));

describe("the palette is the mockup's", () => {
  it("is the light paper surface that was signed, and not the dark one that was not", () => {
    expect(LOOK.scheme).toBe("light");
    expect(LOOK.palette["page"]).toBe(SIGNED_PALETTE["page"]);
    expect(LOOK.palette["ink"]).toBe(SIGNED_PALETTE["ink"]);
  });

  it("holds every signed colour, and no colour that was not signed", () => {
    expect(LOOK.palette).toEqual(SIGNED_PALETTE);
  });

  it("writes each of them into the sheet every document carries", () => {
    for (const [name, held] of Object.entries(SIGNED_PALETTE)) {
      expect(SHEET, name).toContain(`--${name}: ${held}`);
    }
    expect(SHEET).toContain("color-scheme: light");
  });

  it("leaves no colour of the look it replaced anywhere in the sheet", () => {
    // The greys and the blue the pages used to spell. One of them surviving means a rule
    // was ported across rather than restyled.
    for (const gone of ["#111", "#1a1a1a", "#222", "#333", "#444", "#555", "#666", "#888", "#ddd", "#6cf"]) {
      expect(SHEET, gone).not.toContain(gone);
    }
  });

  it("spends every colour it declares, so a token is a decision somebody made", () => {
    const said = everyDeclaration.join(" ");
    for (const name of Object.keys(SIGNED_PALETTE)) {
      expect(said.includes(`var(--${name})`), `${name} is declared but never spent`).toBe(true);
    }
  });
});

describe("the type is the mockup's three faces", () => {
  it("declares the serif, the sans and the mono, stacks and all", () => {
    for (const [name, stack] of Object.entries(SIGNED_TYPE)) {
      expect(LOOK.type[name], name).toBe(stack);
      expect(SHEET, name).toContain(`--${name}: ${stack}`);
    }
  });

  it("sets the surface in the sans and the document's own heading in the serif", () => {
    expect(LOOK.frame["body"]).toContain("var(--sans)");
    expect(LOOK.frame["h1"]).toContain("var(--serif)");
  });

  it("sets what must line up in the mono — an id, a code, a count", () => {
    const mono = everyDeclaration.filter((said) => said.includes("var(--mono)"));
    expect(mono.length).toBeGreaterThan(3);
    for (const page of Object.values(LOOK.pages)) {
      // Every page has something in a column: nothing is read in a face that does not hold
      // one, which is the whole reason the mockup carries a third face at all.
      expect(declarations(page).some((said) => said.includes("var(--mono)"))).toBe(true);
    }
  });

  it("names no face of its own in any rule", () => {
    for (const said of everyDeclaration) {
      // The tokens are the only way to name a face, so they come out before the asking.
      const spent = said.replace(/var\(--[a-z-]+\)/g, "");
      expect(spent, said).not.toMatch(/monospace|serif|system-ui|Georgia|Menlo|Newsreader/);
    }
  });
});

/** The `:root` of a mockup on this machine, so the transcription above is held to the artifact
 *  rather than taken on trust. */
const rootOf = (at: string): string => {
  const text = readFileSync(at, "utf8");
  return text.slice(text.indexOf(":root{"), text.indexOf("}", text.indexOf(":root{")));
};

describe("the mockups themselves agree, where the machine has them", () => {
  it.skipIf(!MOCKUP)("declares the same colours and the same stacks as the artifact", () => {
    const said = rootOf(MOCKUP as string);
    // Every colour the artifact declares, and not a list of the ones this file wants checked:
    // a transcription held to its own seven names could never have noticed the three it lost.
    const drawn = [...said.matchAll(/(--[a-z]+):(#[0-9a-fA-F]{3,8})\b/g)].map(([, n, v]) => [n, v] as const);
    expect(drawn.length, "the mockup's :root declares no colours — has its shape changed?").toBeGreaterThan(6);
    for (const [name, held] of drawn) {
      const here = CALLED[name];
      expect(here, `${name} ${held} is in the mockup and this file names nothing for it`).toBeDefined();
      expect(LOOK.palette[here as string], `${name} is ${held} in the mockup`).toBe(held);
    }
    // …and the other way: a name this file maps must be one the artifact still declares.
    for (const name of Object.keys(CALLED)) expect(said, `${name} is mapped here and gone from the mockup`).toContain(`${name}:`);
    for (const [mockup, here] of [["--serif", "serif"], ["--sans", "sans"], ["--mono", "mono"]] as const) {
      expect(said, mockup).toContain(`${mockup}:${(LOOK.type[here] as string).replace(/, /g, ",")}`);
    }
  });

  // Sketch #7 is where the lanes and the states were signed, and it holds the shell's seven
  // too — at the same values, which is what makes the two one look rather than two.
  it.skipIf(!SKETCH)("declares the four lane hues sketch #7 drew, and the shell's own seven", () => {
    const said = rootOf(SKETCH as string);
    for (const [drawn, here] of [
      ["--lane-story", "lane-story"], ["--lane-req", "lane-req"], ["--lane-crit", "lane-crit"],
      ["--lane-task", "lane-task"],
      ["--page", "page"], ["--raised", "raised"], ["--rule", "rule"], ["--ink", "ink"],
      ["--faint", "faint"], ["--mark", "mark"], ["--good", "good"],
    ] as const) expect(said, drawn).toContain(`${drawn}:${LOOK.palette[here]}`);
  });
});
