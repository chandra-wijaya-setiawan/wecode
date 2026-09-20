/** The board as a web page.
 *
 *  This file draws; it decides nothing. Which boxes there are, in what order, under what
 *  title, on what letter, how many rows each shows, what it says when it is empty and the
 *  glyph its head carries are all `packages/tui/config/views.yaml`'s, read through
 *  `@wecode/tui`'s loader — the same words, from the same file, as the terminal cockpit.
 *  What a row says is `@wecode/tui`'s `code`/`description` for the same reason: a row is a
 *  sentence, and a second opinion about how to write one is two boards.
 *
 *  So the dependency on `@wecode/tui` is not a web page reaching into a terminal: the views
 *  loader and the row contract happen to live there, and copying either here would be a
 *  second declaration of the board — one that goes stale the moment a box is renamed.
 *
 *  The rows arrive as a `Board`, not as a database. A page that opened its own connection
 *  could not be read without one, and where a workspace is, is `bin.ts`'s business. */
import type { Board, Row } from "@wecode/core";
import { code, description, loadViews, sectionMark, type View } from "@wecode/tui";
import { html, type Page, type Reply } from "../server.js";
import { document, shelled } from "./shell.js";

/** This box's own presentation, and the only thing here that is not read off config: a
 *  stylesheet is how the page looks, not what it says. What a document looks like — its
 *  margins, its type and its banner — is the shell's, so none of it is here. A section is
 *  separated by a rule as design.yaml says it is, drawn as a border rather than as a row of
 *  characters, because a browser has no height to spend. */
const STYLE = `
  section { border-top: 1px solid #333; padding-top: .5rem }
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 .4rem }
  h2 .mark { display: inline-block; width: 1.25rem; color: #6cf }
  h2 kbd { float: right; color: #888; font: inherit }
  ul { list-style: none; margin: 0; padding: 0 }
  li { display: flex; gap: .75rem; padding: .1rem 0 }
  li .code { flex: 0 0 9rem; color: #888 }
  li .state { flex: 0 0 9rem; color: #6cf }
  li .what { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere }
  p.empty { margin: 0; color: #666 }
`;

/** Every character HTML has an opinion about. A board's rows are a person's own words —
 *  a story titled `a <script> in the title` is a title, not markup — so nothing reaches
 *  the document without coming through here. */
export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One box, as the head views.yaml declares it and the rows the board kept for it.
 *
 *  `view.rows` is the terminal's height for the box, and it is honoured here too: the box
 *  is a box, not a scroll of everything there is, and a page that showed all forty queued
 *  tasks where the cockpit shows six is a different board. What is cut off is said, because
 *  a list that stops without saying so reads as a list that ended. */
function section(view: View, rows: readonly Row[]): string {
  const head =
    `<h2><span class="mark">${escape(sectionMark(view.name))}</span>${escape(view.title)}` +
    (view.key === undefined ? "" : `<kbd>${escape(view.key)}</kbd>`) +
    `</h2>`;
  const body =
    rows.length === 0
      ? `<p class="empty">${escape(view.empty)}</p>`
      : `<ul>${rows
          .slice(0, view.rows)
          .map(
            (r) =>
              `<li><span class="code">${escape(code(r))}</span>` +
              `<span class="state">${escape(r.state)}</span>` +
              `<span class="what">${escape(description(r))}</span></li>`,
          )
          .join("")}${
          rows.length > view.rows
            ? `<li><span class="code"></span><span class="state"></span>` +
              `<span class="what">and ${rows.length - view.rows} more</span></li>`
            : ""
        }</ul>`;
  return `<section id="${escape(view.name)}">${head}${body}</section>`;
}

/** What the board says: its boxes, and nothing around them. The frame is the shell's, so
 *  this file writes no document — it writes what goes inside one. */
export function boardBoxes(board: Board, views: readonly View[] = loadViews()): string {
  return views.map((v) => section(v, board[v.filter])).join("");
}

/** The whole document: the board's boxes, in the shell design.yaml declares. */
export function boardPage(board: Board, views: readonly View[] = loadViews()): Reply {
  return html(document(boardBoxes(board, views), STYLE));
}

/** Which reading of the workspace this page is served from. The board is not the record:
 *  it is the boxes the record was sorted into, so it asks for that reading by name where a
 *  page of the tree takes the default. See `discover.ts`. */
export const READS = "board";

/** The page, bound to a way of getting the current rows, and wearing the shell — a page of
 *  this package reaches the server through `shelled` and by no other road.
 *
 *  A board is read fresh on every request rather than once at startup: work moves without
 *  anybody reloading, and a page served from a snapshot taken when the process booted is a
 *  board that is wrong by the time it is read. */
export const boardAt = (rows: () => Board, views?: readonly View[]): Page =>
  shelled(() => (views === undefined ? boardBoxes(rows()) : boardBoxes(rows(), views)), STYLE);
