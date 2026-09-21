/** The mockup's banner ends in a terminal button, and the button opens a dock along the
 *  foot of the page. These hold the two halves of that to the markup: the button is the
 *  last thing in the banner's row, and the dock is in the document of every page, closed.
 *
 *  Only the drawing is gated here. What fills the dock — the session's output, and what
 *  happens when a line is typed — comes next, so the output is asserted empty rather than
 *  asserted about, and the form is asserted to exist rather than to go anywhere. */
import { describe, expect, it } from "vitest";
import { document, DOCK } from "../src/pages/shell.js";

const BODY = document(`<section class="board"><h2>a page</h2></section>`);

/** The banner's row of ways in, tags and all. */
const nav = (body: string): string =>
  body.slice(body.indexOf("<nav>"), body.indexOf("</nav>") + "</nav>".length);

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

  it("opens the dock with no script, because the surface serves none", () => {
    expect(BODY).not.toContain("<script");
    expect(BODY).not.toContain("onclick");
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
    const dock = BODY.slice(BODY.indexOf(`id="${DOCK}"`), BODY.indexOf("</aside>"));
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
    const dock = BODY.slice(BODY.indexOf(`id="${DOCK}"`), BODY.indexOf("</aside>"));
    expect(dock).not.toContain("style=");
  });
});
