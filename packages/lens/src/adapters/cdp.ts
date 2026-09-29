/** The CDP adapter behind the ViewIndex port — the index of boxes, on a web page.
 *
 *  A renderer that talks to a browser over the Chrome DevTools Protocol deals in one
 *  thing: a call, a method name and its params, that somebody else puts on the wire. So
 *  that is this adapter's `Frame`. It builds the call and returns it; it opens no socket,
 *  because a screen that owned its transport could not be tested without a browser and
 *  could not be sent down a session the caller already has.
 *
 *  The lines are `indexLines`' and are not laid out again here — the terminal and the page
 *  must not drift into two answers to a question with one answer. What the page adds is
 *  the two things a browser would otherwise take away: a `<pre>`, because the port aligns
 *  its columns with spaces and HTML would collapse them, and escaping, because the titles
 *  and notes are the caller's data and a `<` in one of them is text, not markup. The one
 *  decision of its own is the same as ink's — the letter each box opens on is bold, since
 *  that is the part a reader is hunting for. */
import { indexLines, type ViewIndex, type ViewIndexScreen } from "../ports.js";

/** One Chrome DevTools Protocol call, as a caller would send it. */
export interface CdpCall {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Whatever the caller already has a page on. Any CDP client has this shape, so the
 *  adapter names no library. */
export interface CdpSession {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** The letter, and then the rest of the line — split by width, as ink splits it, so the
 *  emphasis cannot drift from the text. */
const KEY = 1;

/** Text, as HTML. Only the three characters that could be read as markup are touched:
 *  quotes cannot start anything in element content, and escaping them would show up in a
 *  diff of what the page says. */
const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const bold = (text: string): string => `<b>${escape(text)}</b>`;

const row = (text: string): string => `${bold(text.slice(0, KEY))}${escape(text.slice(KEY))}`;

/** The screen as the body of a page: the port's lines, in a `<pre>` so their columns
 *  survive, the title bold and then one row per box. The `<pre>` holds no newline of its
 *  own before the first line — a parser eats it, and the page would then disagree with
 *  every other adapter about where the screen starts. */
export function indexHtml(screen: ViewIndexScreen): string {
  const [title, ...rows] = indexLines(screen);
  const lines = [bold(title ?? ""), ...rows.map(row)];
  return `<pre class="view-index">${lines.join("\n")}</pre>`;
}

/** The screen as the call that puts it on a page. `Page.setDocumentContent` replaces the
 *  frame's document outright, which is what drawing a screen means: the index is the whole
 *  of what is on show, not a patch over whatever was there before. */
export const cdpViewIndex = (frameId: string): ViewIndex<CdpCall> => ({
  draw(screen: ViewIndexScreen): CdpCall {
    return {
      method: "Page.setDocumentContent",
      params: { frameId, html: `<!doctype html><html><body>${indexHtml(screen)}</body></html>` },
    };
  },
});

/** Draw the screen on a page the caller has a session for. The adapter still decides
 *  nothing about the transport: it hands the session the call it built. */
export async function drawOn(
  session: CdpSession,
  frameId: string,
  screen: ViewIndexScreen,
): Promise<void> {
  const call = cdpViewIndex(frameId).draw(screen);
  await session.send(call.method, { ...call.params });
}
