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

/** How this page looks is not here either. It was — a template string with its own hex
 *  colours written into it, one of five such strings across the pages, all of them agreeing
 *  about what "faint" is until one of them was edited. The look is the design's now, and
 *  `shell.ts` is the only thing that turns it into a sheet, so this file draws markup and
 *  says nothing about colour, type or space.
 *
 *  What it does say is which shape it draws: the design scopes the board's rules to
 *  `section.board`, so the class below is how a box of this page is told from a `section`
 *  some other page draws into the same sheet. */
const SHAPE = "board";

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
  return `<section id="${escape(view.name)}" class="${SHAPE}">${head}${body}</section>`;
}

/** What the board says: its boxes, and nothing around them. The frame is the shell's, so
 *  this file writes no document — it writes what goes inside one. */
export function boardBoxes(board: Board, views: readonly View[] = loadViews()): string {
  return views.map((v) => section(v, board[v.filter])).join("");
}

/** The whole document: the board's boxes, in the shell and the look design.yaml declares. */
export function boardPage(board: Board, views: readonly View[] = loadViews()): Reply {
  return html(document(boardBoxes(board, views)));
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
  shelled(() => (views === undefined ? boardBoxes(rows()) : boardBoxes(rows(), views)));
