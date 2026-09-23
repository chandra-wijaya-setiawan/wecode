/** The mockup's banner ends in a terminal button, and the button opens a dock down the right
 *  edge of the window. These hold the drawing of that — the button is the last thing in the
 *  banner's row and the dock is in the document of every page — and the two things that make
 *  it a sidebar rather than a popover: the design says where it sits and what room the page
 *  gives it, and `docking()` turns it.
 *
 *  A popover is the browser's own top-layer box. It is drawn over the page and cannot make
 *  room beside it, and — because the top layer belongs to the document — every link a reader
 *  follows shuts it, which on a surface of eight documents is a terminal that closes itself
 *  whenever the reader looks at anything. So the state is a class the root element wears,
 *  remembered across a navigation, and one sheet answers both the panel and the room.
 *
 *  What fills the dock is `the-dock-runs-a-shell.test.ts`'s, so the output is asserted empty
 *  rather than asserted about, and the form is asserted to exist rather than to go
 *  anywhere. */
import { describe, expect, it } from "vitest";
import { CONTROLS, DOCK, DOCKED, docking, document, loadLook, REMEMBERED, stylesheet } from "../src/pages/shell.js";
import type { Remembers, Rules } from "../src/pages/shell.js";

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

/** The rule that makes room for the dock, which is the one rule about it that is not keyed
 *  to its id: the panel is out of the flow, so the width it takes is the document's to give
 *  back, and the document is the root and the body. */
const ROOM = `html.${DOCKED} body`;

/** The rules the design declares about the dock: the ones naming its id, and that one. */
const DOCK_RULES = Object.entries(LOOK.frame).filter(
  ([selector]) => selector.includes(`#${DOCK}`) || selector === ROOM,
) as readonly (readonly [string, string])[];

/** One of them, by selector. Asked for by name so a missing rule fails as itself rather
 *  than as an undefined further down. */
function said(selector: string): string {
  const held = LOOK.frame[selector];
  expect(typeof held, `the frame declares no ${selector}`).toBe("string");
  return held as string;
}

const DOCK_DECLARATIONS = DOCK_RULES.map(([, held]) => held);

/** A root element and a browser's store, as much of each as the sidebar reaches for. The
 *  classes worn and the words held are readable, because what is asserted below is what the
 *  turning left on the document and what it left for the next one. */
function rooted(): { readonly worn: Set<string>; readonly root: Parameters<typeof docking>[0] } {
  const worn = new Set<string>();
  const classList = {
    toggle: (name: string, on: boolean): void => void (on ? worn.add(name) : worn.delete(name)),
    contains: (name: string): boolean => worn.has(name),
  };
  return { worn, root: { classList } };
}

function storing(): Remembers & { readonly held: Record<string, string> } {
  const held: Record<string, string> = {};
  return {
    held,
    getItem: (key) => held[key] ?? null,
    setItem: (key, value) => void (held[key] = value),
  };
}

describe("the banner ends in a terminal button", () => {
  it("carries one button, named for what it is", () => {
    expect([...BODY.matchAll(/data-ui="shell\.terminal"/g)]).toHaveLength(1);
    expect(nav(BODY)).toContain(`data-ui="shell.terminal"`);
  });

  it("puts it after every way in, not among them", () => {
    const row = nav(BODY);
    expect(row.lastIndexOf("<a ")).toBeLessThan(row.indexOf("<button"));
  });

  it("says what it turns, and whether it is open, rather than targeting a popover", () => {
    expect(nav(BODY)).toContain(`aria-controls="${DOCK}"`);
    // Served shut, as the sheet serves the panel: the script at the foot is what turns both,
    // so a document that claimed to be open would be claiming it for a page load.
    expect(nav(BODY)).toContain(`aria-expanded="false"`);
    expect(BODY, "the popover is what a navigation shuts").not.toContain("popover");
  });

  /** What is still true after approval 1561 is that no element carries a handler of its
   *  own: the markup is the shell's and the wiring is `browser/dock.ts`'s, one place, over
   *  every page there is. What is no longer true is that the document carries no script —
   *  the operator's mockup draws a terminal, and the pane behind the dock is script. */
  it("opens the dock from the served script and not from a handler in the markup", () => {
    expect(BODY).not.toContain("onclick");
  });

  it("names two controls, each of them one element of the document", () => {
    for (const selector of Object.values(CONTROLS)) {
      // The selectors are attributes, so the attribute itself is what the document holds.
      const attribute = selector.slice(1, -1).replace(/[[\]().*+?^$|\\]/g, "\\$&");
      expect([...BODY.matchAll(new RegExp(attribute, "g"))], selector).toHaveLength(1);
    }
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

  it("is an aside and not a popover, and is closable again from inside", () => {
    expect(BODY).toMatch(new RegExp(`<aside id="${DOCK}" data-ui="shell\\.dock">`));
    expect(drawn(BODY)).not.toContain("popover");
    expect(drawn(BODY)).toContain(`data-ui="shell.dock.close"`);
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
  it("says it at all, which is what stops the browser drawing a box of its own choosing", () => {
    expect(DOCK_RULES.length).toBeGreaterThan(0);
    for (const [selector] of DOCK_RULES) expect(SHEET, selector).toContain(`${selector} {`);
    expect(BODY).toContain(`#${DOCK} {`);
  });

  it("says it in the frame, because the dock is in every document and is no page's", () => {
    for (const [page, rules] of Object.entries(LOOK.pages)) {
      for (const selector of Object.keys(rules)) {
        expect(selector.includes(`#${DOCK}`), `${page} styles ${selector}`).toBe(false);
        expect(selector.includes(DOCKED), `${page} styles ${selector}`).toBe(false);
      }
    }
  });

  it("keys every rule to the dock's own id, bar the one that makes room for it", () => {
    // The whole sheet is in every document. A rule about the dock written loose would be a
    // rule about everybody's `pre`, `form` and `button`.
    const dock = drawn(BODY);
    for (const [selector] of DOCK_RULES) {
      if (selector === ROOM) continue;
      // Every tag the selector descends into is one the dock actually draws: a rule about
      // markup nobody writes is a decision nobody can read off the page.
      const under = selector.slice(selector.indexOf(`#${DOCK}`) + `#${DOCK}`.length);
      for (const part of under.split(/[\s>]+/).filter(Boolean)) {
        const named = part.split(":")[0] as string;
        if (named === "") continue; // a state of the dock itself, not a tag inside it
        expect(dock, `${selector} styles a ${named} the dock never draws`).toContain(`<${named}`);
      }
    }
    // …and no rule about the dock is written anywhere but under its id, where a `pre` or a
    // `button` of its own would be a `pre` or a `button` of every page's.
    for (const [selector] of Object.entries(LOOK.frame)) {
      if (selector.includes(`#${DOCK}`)) continue;
      for (const tag of ["pre", "aside", "form"]) expect(selector.split(/[\s>]+/), tag).not.toContain(tag);
    }
  });
});

describe("it sits down the right edge, full height, as a column of the window", () => {
  /** The dock's own rule, asked for when a statement needs it rather than when the file is
   *  read — a missing rule is one red statement here and not a file that will not load. */
  const self = (): string => said(`#${DOCK}`);

  it("is pinned to that edge, full height, rather than laid out where it is drawn", () => {
    expect(self()).toContain("position: fixed");
    expect(self()).toContain("inset: 0 0 0 auto");
    expect(self()).toContain("margin: 0");
    // The height is said: an inset alone does not undo a box the browser sizes to what is
    // inside it, which is the one shape a terminal must not be.
    expect(self()).toMatch(/height: 100dvh|height: 100vh|height: auto/);
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

  it("is served shut, and is opened by the class the root wears", () => {
    // Shut is the state every document is served in: the class goes on from the script at
    // the foot, and a panel drawn open would stand open for the length of every page load.
    expect(self()).toContain("display: none");
    const open = said(`html.${DOCKED} #${DOCK}`);
    expect(open).toContain("display: flex");
    // Nothing is left of the popover, whose own `:popover-open` was where this used to be.
    expect(Object.keys(LOOK.frame).join(" ")).not.toContain("popover");
  });

  it("gives the body the width the dock is not taking, and a gutter beside it", () => {
    // One width, said in two rules because a fixed panel and the room made for it are two
    // decisions the browser will not make for us. Held to each other here, so neither can
    // be changed alone: the page would slide under the dock or stop short of it.
    const width = /width: ([^;]*)/.exec(self())?.[1] as string;
    const gutter = /padding: \S+ (clamp\([^)]*\))/.exec(LOOK.frame["body"] as string)?.[1] as string;
    expect(gutter, "the body keeps no gutter of its own to match").toBeTypeOf("string");
    expect(said(ROOM)).toBe(`padding-right: calc(${width} + ${gutter})`);
    // And only while it is open. One sheet carries both states, so the room is on the state
    // and never on the body: a document nobody opened the dock on has the whole width.
    expect(ROOM.startsWith(`html.${DOCKED} `)).toBe(true);
    expect(LOOK.frame["body"]).not.toContain("padding-right");
  });
});

describe("what is inside it is stacked: close, output, command line", () => {
  it("stacks them down the panel in the order the dock draws them", () => {
    const open = said(`html.${DOCKED} #${DOCK}`);
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

describe("the class the root wears is the state, and the browser remembers it", () => {
  it("is shut on a document nobody has opened it on", () => {
    const { worn, root } = rooted();
    const shown: boolean[] = [];
    docking(root, storing(), (open) => void shown.push(open)).restore();
    expect(worn.has(DOCKED)).toBe(false);
    // The wiring is told all the same: shut is what stops the poll and says so on the
    // button, and a restore that said nothing would leave both to guess.
    expect(shown).toEqual([false]);
  });

  it("wears the class when a reader turns it open, and takes it off again", () => {
    const { worn, root } = rooted();
    const sidebar = docking(root, storing(), () => {});
    sidebar.turn(true);
    expect(worn.has(DOCKED)).toBe(true);
    expect(sidebar.opened()).toBe(true);
    sidebar.turn(false);
    expect(worn.has(DOCKED)).toBe(false);
    expect(sidebar.opened()).toBe(false);
  });

  it("reads open-or-shut off the root, so nothing holds a second copy of it", () => {
    const { worn, root } = rooted();
    const sidebar = docking(root, storing(), () => {});
    worn.add(DOCKED);
    expect(sidebar.opened()).toBe(true);
  });

  it("tells the wiring every turn, which is what attaches the pane and starts the poll", () => {
    const shown: boolean[] = [];
    const sidebar = docking(rooted().root, storing(), (open) => void shown.push(open));
    sidebar.turn(true);
    sidebar.turn(false);
    sidebar.restore();
    expect(shown).toEqual([true, false, false]);
  });

  /** The whole reason it is remembered rather than held in the page: this surface is eight
   *  documents, and a reader who follows a link is served a new one. */
  it("opens the next document as the reader left the last", () => {
    const store = storing();
    docking(rooted().root, store, () => {}).turn(true);
    expect(store.held[REMEMBERED]).toBe("open");
    const next = rooted();
    docking(next.root, store, () => {}).restore();
    expect(next.worn.has(DOCKED)).toBe(true);
  });

  it("keeps it shut on the next document when the reader shut it on this one", () => {
    const store = storing();
    const first = docking(rooted().root, store, () => {});
    first.turn(true);
    first.turn(false);
    const next = rooted();
    docking(next.root, store, () => {}).restore();
    expect(next.worn.has(DOCKED)).toBe(false);
  });

  it("writes nothing while restoring, so only what a reader did is remembered", () => {
    const store = storing();
    docking(rooted().root, store, () => {}).restore();
    expect(Object.keys(store.held)).toEqual([]);
  });

  it("remembers it under a name of this surface's own", () => {
    // Not `docked`, which is a word any script on any origin might have taken: the store is
    // the origin's and is shared with whatever else the operator has served from it.
    expect(REMEMBERED).toContain("wecode");
    expect(REMEMBERED).toContain(DOCK);
  });

  it("still turns in a browser that refuses a store", () => {
    // Reaching for `localStorage` throws outright in a document that is not allowed one. A
    // dock that forgets is a great deal better than a script that dies before it wires.
    const { worn, root } = rooted();
    const sidebar = docking(root, null, () => {});
    sidebar.turn(true);
    expect(worn.has(DOCKED)).toBe(true);
    sidebar.restore();
    expect(worn.has(DOCKED)).toBe(false);
  });
});
