/** The mockup's banner ends in a terminal button, and the button opens a dock along the
 *  right edge of the window. These hold the two halves of that to the markup: the button is
 *  the last thing in the banner's row, and the dock is in the document of every page, closed.
 *
 *  And they hold a third thing, which is where the dock sits. A popover nothing styles is
 *  drawn by the browser alone — a small box in the middle of the window, sized to whatever
 *  is inside it — so a dock the design says nothing about is not a dock. What it should be
 *  is the mockup's: down the right edge, full height, over the page rather than shoving it,
 *  about a third of the window wide, close at the top, the session's output filling the
 *  middle in the mono face, the command line along the foot. That is said in
 *  `renderers.webapp.look.frame`, because the dock is in every document and is no page's,
 *  and it is said in the palette and type tokens and in nothing else. This file reads it
 *  back off the design.
 *
 *  Only the drawing is gated here. What fills the dock — the session's output, and what
 *  happens when a line is typed — comes next, so the output is asserted empty rather than
 *  asserted about, and the form is asserted to exist rather than to go anywhere. */
import { describe, expect, it } from "vitest";
import { document, DOCK, loadLook, type Rules, stylesheet } from "../src/pages/shell.js";

const BODY = document(`<section class="board"><h2>a page</h2></section>`);
const LOOK = loadLook();
const SHEET = stylesheet();

/** The banner's row of ways in, tags and all. */
const nav = (body: string): string =>
  body.slice(body.indexOf("<nav>"), body.indexOf("</nav>") + "</nav>".length);

/** The dock as it is drawn, tag for tag. */
const drawn = (body: string): string =>
  body.slice(body.indexOf(`id="${DOCK}"`), body.indexOf("</aside>"));

/** Every declaration in a block, wherever it sits — a query holds rules of its own. */
const declarations = (rules: Rules): readonly string[] =>
  Object.values(rules).flatMap((held) =>
    typeof held === "string" ? [held] : declarations(held as Rules),
  );

/** The rules the design declares about the dock, which are the ones keyed to its own id. */
const DOCK_RULES = Object.entries(LOOK.frame).filter(([selector]) =>
  selector.startsWith(`#${DOCK}`),
) as readonly (readonly [string, string])[];

/** One of them, by selector. Asked for by name so a missing rule fails as itself rather
 *  than as an undefined further down. */
function said(selector: string): string {
  const held = LOOK.frame[selector];
  expect(typeof held, `the frame declares no ${selector}`).toBe("string");
  return held as string;
}

const DOCK_DECLARATIONS = DOCK_RULES.map(([, held]) => held);
const EVERY_DECLARATION = [LOOK.frame, ...Object.values(LOOK.pages)].flatMap(declarations);

describe("the banner ends in a terminal button", () => {
  it("carries one button, named for what it is", () => {
    expect([...BODY.matchAll(/data-ui="shell\.terminal"/g)]).toHaveLength(1);
    expect(nav(BODY)).toContain(`data-ui="shell.terminal"`);
  });

  it("puts it after every way in, not among them", () => {
    const row = nav(BODY);
    expect(row.lastIndexOf("<a ")).toBeLessThan(row.indexOf("<button"));
  });

  it("points it at the dock", () => {
    expect(nav(BODY)).toContain(`popovertarget="${DOCK}"`);
  });

  /** What is still true after approval 1561 is where the open-or-shut state lives: the
   *  popover attributes, which are the browser's. What is no longer true is that the
   *  document carries no script — the operator's mockup draws a terminal, and the pane
   *  behind the dock is script — so only the handler of one's own is forbidden here. */
  it("opens the dock through the popover and not a handler of its own", () => {
    expect(BODY).not.toContain("onclick");
  });

  /** And the frame lets a page's own script through, which is the retirement itself: the
   *  shell writes `contents` as it is given them, so markup a page means to serve arrives
   *  in the document rather than being dropped or escaped on the way. */
  it("carries a page's script into the document rather than refusing it", () => {
    const served = document(`<script type="module" src="/dock.js"></script>`);
    expect(served).toContain(`<script type="module" src="/dock.js"></script>`);
    expect(served).not.toContain("&lt;script");
  });
});

describe("the dock is in the document", () => {
  it("draws it once, at the foot, outside the page's own element", () => {
    expect([...BODY.matchAll(/data-ui="shell\.dock"/g)]).toHaveLength(1);
    expect(BODY.indexOf(`id="${DOCK}"`)).toBeGreaterThan(BODY.indexOf("</main>"));
    expect(BODY.indexOf(`id="${DOCK}"`)).toBeLessThan(BODY.indexOf("</body>"));
  });

  it("is closed until the button is pressed", () => {
    expect(BODY).toMatch(new RegExp(`<aside id="${DOCK}" popover[\\s>]`));
  });

  it("is closable again from inside", () => {
    expect(BODY).toContain(`popovertargetaction="hide"`);
    expect(BODY).toContain(`data-ui="shell.dock.close"`);
  });

  it("holds the session's output and a command line, both empty", () => {
    const dock = drawn(BODY);
    expect(dock).toContain(`<pre data-ui="shell.dock.output"></pre>`);
    expect(dock).toContain(`data-ui="shell.dock.command"`);
    expect(dock).toMatch(/<input [^>]*type="text"/);
    expect(dock).not.toMatch(/<input [^>]*value=/);
  });

  it("is the same dock on every page, because there is one session", () => {
    expect([...document("<p>elsewhere</p>").matchAll(/data-ui="shell\.dock"/g)]).toHaveLength(1);
    expect(document("<p>elsewhere</p>").slice(document("<p>elsewhere</p>").indexOf("</main>"))).toBe(
      BODY.slice(BODY.indexOf("</main>")),
    );
  });

  it("declares no look of its own — the design file says how it sits", () => {
    expect(drawn(BODY)).not.toContain("style=");
  });
});

describe("the design says where the dock sits", () => {
  it("says it at all, which is what stops the browser centring a small box", () => {
    expect(DOCK_RULES.length).toBeGreaterThan(0);
    for (const [selector] of DOCK_RULES) expect(SHEET, selector).toContain(`${selector} {`);
    expect(BODY).toContain(`#${DOCK} {`);
  });

  it("says it in the frame, because the dock is in every document and is no page's", () => {
    for (const [page, rules] of Object.entries(LOOK.pages)) {
      for (const selector of Object.keys(rules)) {
        expect(selector.startsWith(`#${DOCK}`), `${page} styles ${selector}`).toBe(false);
      }
    }
  });

  it("keys every rule to the dock's own id, so none of it reaches the page", () => {
    // The whole sheet is in every document. A rule about the dock written loose would be a
    // rule about everybody's `pre`, `form` and `button`.
    const dock = drawn(BODY);
    for (const [selector] of DOCK_RULES) {
      // Every tag the selector descends into is one the dock actually draws: a rule about
      // markup nobody writes is a decision nobody can read off the page.
      for (const part of selector.slice(`#${DOCK}`.length).split(/[\s>]+/).filter(Boolean)) {
        const named = part.split(":")[0] as string;
        if (named === "") continue; // a state of the dock itself, not a tag inside it
        expect(dock, `${selector} styles a ${named} the dock never draws`).toContain(`<${named}`);
      }
    }
    // …and no rule about the dock is written anywhere but under its id, where a `pre` or a
    // `button` of its own would be a `pre` or a `button` of every page's.
    for (const [selector] of Object.entries(LOOK.frame)) {
      if (selector.startsWith(`#${DOCK}`)) continue;
      for (const tag of ["pre", "aside", "form"]) expect(selector.split(/[\s>]+/), tag).not.toContain(tag);
    }
  });
});

describe("it sits down the right edge, full height, over the page", () => {
  /** The dock's own rule, asked for when a statement needs it rather than when the file is
   *  read — a missing rule is one red statement here and not a file that will not load. */
  const self = (): string => said(`#${DOCK}`);

  it("is pinned to the right edge rather than centred by the popover's own margin", () => {
    // A popover is `inset: 0; margin: auto`, which is the small centred box. Both are
    // answered: the left inset gives way, and the margin goes.
    expect(self()).toContain("position: fixed");
    expect(self()).toContain("inset: 0 0 0 auto");
    expect(self()).toContain("margin: 0");
  });

  it("runs the full height of the window, which an inset alone does not buy", () => {
    // The popover is drawn `height: fit-content`, so top and bottom together are not
    // enough — the height is said.
    expect(self()).toMatch(/height: 100dvh|height: 100vh|height: auto/);
  });

  it("lies over the page instead of pushing it aside", () => {
    // `position: fixed` takes it out of the flow, and nothing anywhere else in the look
    // reserves room for it — the mockup's `body.docked { padding-right }` is not here,
    // because the look is one sheet for both states and the dock lies over what it covers.
    expect(LOOK.frame["body"]).not.toContain("padding-right");
    expect(Object.keys(LOOK.frame).join(" ")).not.toContain("docked");
    const width = /width: ([^;]*)/.exec(self())?.[1] as string;
    for (const held of EVERY_DECLARATION) {
      if (DOCK_DECLARATIONS.includes(held)) continue;
      expect(held, "something outside the dock is making room for it").not.toContain(width);
    }
  });

  it("takes about a third of the window, and never less than a readable line", () => {
    const width = /width: ([^;]*)/.exec(self())?.[1] as string;
    // The floor. A terminal that wraps at forty columns says less than no terminal, so the
    // share gives way to a fixed width on a narrow window rather than the other way round.
    const floored = /max\(([^)]*)\)/.exec(width)?.[1] as string;
    expect(floored, `${width} says no share and no floor`).toBeTypeOf("string");
    const share = /(\d+(?:\.\d+)?)vw/.exec(floored)?.[1] as string;
    expect(Number(share), `${width} is not about a third of the window`).toBeGreaterThan(28);
    expect(Number(share), `${width} is not about a third of the window`).toBeLessThan(40);
    const floor = /(\d+(?:\.\d+)?)rem/.exec(floored)?.[1] as string;
    expect(Number(floor), `${width} is narrower than a line worth reading`).toBeGreaterThanOrEqual(30);
    // …and the floor itself gives way on a window narrower than it, rather than hanging
    // the dock off the side of one.
    expect(width, "the dock can be wider than the window").toContain("min(100vw,");
  });

  it("stays shut when it is shut — the open shape is on the open state", () => {
    // The browser hides a closed popover with `display: none`. An author `display` on the
    // dock itself beats that whatever its specificity, and the dock would stand open on
    // every page of the surface with no way to close it.
    expect(self()).not.toMatch(/(^|;)\s*display:/);
    expect(said(`#${DOCK}:popover-open`)).toContain("display: flex");
  });
});

describe("what is inside it is stacked: close, output, command line", () => {
  it("stacks them down the panel in the order the dock draws them", () => {
    const open = said(`#${DOCK}:popover-open`);
    expect(open).toContain("flex-direction: column");
    const dock = drawn(BODY);
    expect(dock.indexOf("<button")).toBeLessThan(dock.indexOf("<pre"));
    expect(dock.indexOf("<pre")).toBeLessThan(dock.indexOf("<form"));
  });

  it("gives the close control the top and lets it take no more than it needs", () => {
    expect(said(`#${DOCK} button`)).toContain("flex: 0 0 auto");
  });

  it("fills the middle with the output, in the mono face, scrolling on its own", () => {
    const output = said(`#${DOCK} pre`);
    // The one child that grows: everything between the close and the command line is the
    // session's, which is the whole point of the panel.
    expect(output).toContain("flex: 1 1 auto");
    expect(output).toContain("var(--mono)");
    expect(output).toContain("overflow: auto");
    // A flex child will not scroll while its floor is its content's height.
    expect(output).toContain("min-height: 0");
    // The record's own line breaks are what the session said, and a long line wraps rather
    // than dragging the panel sideways.
    expect(output).toContain("white-space: pre-wrap");
  });

  it("keeps the command line along the foot, always in view", () => {
    const form = said(`#${DOCK} form`);
    expect(form).toContain("flex: 0 0 auto");
    expect(form).toContain("display: flex");
    expect(said(`#${DOCK} form input`)).toContain("flex: 1 1 auto");
  });
});

describe("it is drawn out of the signed tokens and out of nothing else", () => {
  it("spells no colour of its own", () => {
    for (const held of DOCK_DECLARATIONS) expect(held, held).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("spells no face of its own", () => {
    for (const held of DOCK_DECLARATIONS) {
      const spent = held.replace(/var\(--[a-z-]+\)/g, "");
      expect(spent, held).not.toMatch(/monospace|serif|system-ui|Georgia|Menlo|Newsreader/);
    }
  });

  it("names only tokens the palette and the type declare", () => {
    const declared = new Set([...Object.keys(LOOK.palette), ...Object.keys(LOOK.type)]);
    const spent = new Set<string>();
    for (const held of DOCK_DECLARATIONS) {
      for (const [, name] of held.matchAll(/var\(--([a-z-]+)\)/g)) {
        expect(declared.has(name as string), `${name} is spent but never declared`).toBe(true);
        spent.add(name as string);
      }
    }
    // It is a panel raised off the page, ruled off from it, with quiet chrome — so it
    // spends the surface's own words for those and invents none.
    for (const name of ["raised", "rule", "ink", "faint", "mono"]) {
      expect([...spent], name).toContain(name);
    }
  });
});
