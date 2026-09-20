/** The CDP adapter behind the ViewIndex port, held against the port itself.
 *
 *  The question this file answers is not "what HTML does it emit" but "does a person
 *  reading the page read the same screen as a person reading the terminal". So the
 *  assertions are mostly a round trip: take the page apart again — drop the tags, undo the
 *  escaping — and the lines that come back must be `indexLines`' lines exactly. A reflow,
 *  a dropped column or a renderer that laid the screen out a second way fails here without
 *  the fixture having to be written out twice.
 *
 *  What is asserted literally is only what is the page's own and cannot be recovered from
 *  the text: that the columns are inside a `<pre>` and so survive, that the caller's data
 *  is escaped, that the letter is emphasised, and that the call sent is the one call that
 *  replaces the document of the frame it was given. */
import { describe, expect, it } from "vitest";

import { indexLines, type ViewIndexScreen } from "../src/ports.js";
import { cdpViewIndex, drawOn, indexHtml, type CdpSession } from "../src/adapters/cdp.js";

/** The same three boxes the terminal adapter is held against: two the page draws and one
 *  reached only by its letter, with titles of different lengths so the note column has
 *  something to line up against. */
const SCREEN: ViewIndexScreen = {
  title: "Views",
  views: [
    { key: "n", title: "Needs you" },
    { key: "q", title: "Queue" },
    { key: "o", title: "Open", note: "off page" },
  ],
};

const FRAME = "FRAME-1";

/** The page, read back as a person reads it: the text inside the `<pre>`, tags gone and
 *  escaping undone. Nothing here knows the fixture — it knows HTML. */
const read = (html: string): string[] => {
  const pre = /<pre class="view-index">([\s\S]*)<\/pre>/.exec(html);
  expect(pre).not.toBeNull();
  return (pre?.[1] ?? "")
    .replace(/<\/?b>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .split("\n");
};

class Recorded implements CdpSession {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];

  async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    return {};
  }
}

const html = (): string => String(cdpViewIndex(FRAME).draw(SCREEN).params["html"]);

describe("the CDP adapter behind the ViewIndex port", () => {
  it("puts the port's screen on the page, line for line", () => {
    expect(read(indexHtml(SCREEN))).toEqual(indexLines(SCREEN));
  });

  it("keeps the columns the port aligned, because the lines are preformatted", () => {
    const [, first] = read(indexHtml(SCREEN));
    expect(first).toBe("n  Needs you");
    expect(indexHtml(SCREEN)).toContain('<pre class="view-index">');
  });

  it("starts the page at the title, with no newline the parser would eat", () => {
    expect(indexHtml(SCREEN)).toContain('<pre class="view-index"><b>Views</b>');
  });

  it("emphasises the letter each box opens on, and nothing else on the row", () => {
    const rows = indexHtml(SCREEN).split("\n").slice(1);
    expect(rows).toEqual([
      "<b>n</b>  Needs you",
      "<b>q</b>  Queue",
      "<b>o</b>  Open       off page</pre>",
    ]);
  });

  it("keeps the order it was handed", () => {
    const reversed = { ...SCREEN, views: [...SCREEN.views].reverse() };
    expect(read(indexHtml(reversed)).slice(1).map((l) => l[0])).toEqual(["o", "q", "n"]);
  });

  it("treats the caller's words as text and not as markup", () => {
    const sharp: ViewIndexScreen = {
      title: "Views & <b>more</b>",
      views: [{ key: "n", title: "Needs you", note: "<script>alert(1)</script>" }],
    };
    const page = indexHtml(sharp);
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(read(page)).toEqual(indexLines(sharp));
  });

  it("draws with the one call that replaces the document of the frame it was given", () => {
    const call = cdpViewIndex(FRAME).draw(SCREEN);
    expect(call.method).toBe("Page.setDocumentContent");
    expect(call.params["frameId"]).toBe(FRAME);
    expect(html()).toContain("<!doctype html>");
  });

  it("opens nothing itself — the session the caller has is what sends it", async () => {
    const session = new Recorded();
    await drawOn(session, FRAME, SCREEN);
    expect(session.calls.map((c) => c.method)).toEqual(["Page.setDocumentContent"]);
    expect(read(String(session.calls[0]?.params["html"]))).toEqual(indexLines(SCREEN));
  });
});
