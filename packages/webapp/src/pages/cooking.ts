/** Everything in flight, and why each row is where it is.
 *
 *  The board's Cooking box shows the ten oldest and says how many more there were. Ten is
 *  a terminal's height, not an answer: a person who has opened this page has already asked
 *  the box and wants the rest. So this page cuts nothing — every cooking row there is, in
 *  the order the board handed them over, oldest first.
 *
 *  What a row says about itself is `@wecode/tui`'s `why` — the group views.yaml puts its
 *  state in, or the state's own word where no group claims it. A row whose why is *a
 *  worker has it* is moving; every other why is the exact thing refusing it, said in the
 *  words the config declares rather than left as a state a reader has to interpret. That
 *  is the whole of this page: the moving ones, and the refusal for each one that is not.
 *
 *  Grouped, because a why repeated down twenty rows is a heading said twenty times, and
 *  marked, because a row read on its own still has to carry its group. Neither the order,
 *  the wording nor the glyph is decided here — `groupCooking`, `why` and `mark` are the
 *  terminal's, from views.yaml, and a second opinion about them would be a second board.
 *
 *  Nothing routes this file: it is a page because it is a file under `pages/`, it answers
 *  at `/cooking` because that is its name, and it is served the board because it says so
 *  in `READS`. See `discover.ts` — there is no table to add it to.
 *
 *  Read-only, like every page of this surface: `renderers.webapp` says the web offers no
 *  verb, so a row that wants a person says what to type and offers nothing to click.
 *
 *  Every node `packages/webapp/config/ui.yaml` declares under `cooking` is drawn here,
 *  carrying its `data-ui` name and the words the definition gives it — the page itself
 *  with its lead, the ticket row, the seats card and the red-at-base card. The last two
 *  ask the board something the board does not hold, so each is drawn as the dash and the
 *  reason rather than left out: a node nothing is said under reads as a node whose answer
 *  is nothing, and that is a different sentence.
 *
 *  `cooking.task.retry` and `cooking.task.drop` are not drawn. Both are verbs on a ticket
 *  that is out of attempts, and this surface offers none — they are the same two verbs the
 *  task detail withholds, and they belong with that page's own pair rather than repeated
 *  here on a row that is only a reading. */
import type { Board, Row } from "@wecode/core";
import { code, description, loadViews, mark, why, groupCooking, type View } from "@wecode/tui";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { document, shelled } from "./shell.js";

/** The one why that is not a refusal. Compared as the word views.yaml declares rather than
 *  as a group name, because the word is what the page shows a person. */
const MOVING = "a worker has it";

/** Is this row moving, or is its why the thing refusing it? */
export const moving = (row: Row): boolean => why(row) === MOVING;

/** The name the definition gives an element, written into the markup so the drawing and
 *  the declaration are checkable against each other by anything that can read either. */
const named = (ui: string): string => ` data-ui="${ui}"`;

/** One row: what it is, what state it is in, what it says, and its why in full. The why is
 *  on every row and not only on the head — a row copied out of this page alone still has
 *  to say what is holding it.
 *
 *  This is `cooking.task`, the one node the definition declares once and the page draws per
 *  record: a ticket that is moving, running, blocked, ready or failed. */
const line = (row: Row): string =>
  `<li class="${moving(row) ? "moving" : "refused"}"${named("cooking.task")}>` +
  `<span class="code">${escape(code(row))}</span>` +
  `<span class="state">${escape(row.state)}</span>` +
  `<span class="what">${escape(description(row))}</span>` +
  `<span class="why">${escape(why(row))}</span></li>`;

/** The rows gathered under the why they share, in views.yaml's order. `groupCooking` has
 *  already sorted them, so a group is a run of adjacent rows and this only finds the
 *  breaks — grouping them a second way here would be a second order. */
function grouped(rows: readonly Row[]): readonly (readonly Row[])[] {
  const runs: Row[][] = [];
  let last: string | null = null;
  for (const row of groupCooking(rows)) {
    const said = why(row);
    if (said !== last) runs.push([]);
    (runs[runs.length - 1] as Row[]).push(row);
    last = said;
  }
  return runs;
}

/** One group, headed by its mark and its why, with how many rows it has — the count is
 *  what the box used to say as *and 12 more*, said here as a number a person can read the
 *  size of the problem off. */
function group(rows: readonly Row[]): string {
  const first = rows[0] as Row;
  return (
    `<section class="cooking ${moving(first) ? "moving" : "refused"}">` +
    `<h2><span class="mark">${escape(mark(first))}</span>${escape(why(first))}` +
    `<span class="count">${rows.length}</span></h2>` +
    `<ul>${rows.map(line).join("")}</ul></section>`
  );
}

/** The words the definition gives the page itself: what it is called, and what it says the
 *  page is for. Neither is this file's sentence — both are read off the signed mockup. */
const SAYS = "Cooking";
const LEAD = "Tickets that are moving — the wecode workers move them for you.";

/** What a declared reading shows when the board does not carry it. A dash rather than a
 *  zero, for the reason a null minute is not a zero one: nothing measured is not the same
 *  as measured as none. */
const NOTHING = "—";

/** One card: the word the definition labels it with, what the page can say for it, and why
 *  that is all. It is a row of a list inside the page's own section, so the look already
 *  dresses it — the surface gains a reading, not a second shape. */
const card = (ui: string, says: string, said: string, why: string): string =>
  `<li${named(ui)}><span class="state">${escape(says)}</span>` +
  `<span class="what">${escape(said)}</span>` +
  `<span class="why">${escape(why)}</span></li>`;

/** The two cards the definition declares under the rows.
 *
 *  Seats is half a question this page can answer. A moving row is a seat a worker is
 *  holding, so the busy count is the page's own rows counted once — but the board names
 *  only who is working, so there is no roster to take idle off and no role on a row to
 *  split either by. Red at base is none of it: which test was already failing is the
 *  record's, on the acceptance test, and this page is served the board. */
const cards = (rows: readonly Row[]): string =>
  `<ul>` +
  card(
    "cooking.seats",
    "Seats",
    `${rows.filter(moving).length} busy · ${NOTHING} idle`,
    "the board names only who is working — no roster of seats, and no role on a row",
  ) +
  card(
    "cooking.red-at-base",
    "Red at base",
    NOTHING,
    "red at base lives on the acceptance test in the record — the board carries no test run",
  ) +
  `</ul>`;

/** What the page says: its lead, its groups and its two cards, and nothing around them. The
 *  frame is the shell's, and so is the look — this page names no stylesheet of its own,
 *  because the whole surface's is `renderers.webapp.look` and a page that carried a second
 *  one would be a second look.
 *
 *  Empty is views.yaml's word for the Cooking box — *nothing is stuck* — because this page
 *  and that box keep the same rows, and a page that invented its own sentence for having
 *  none of them would be saying a second thing about one fact. The cards are drawn either
 *  way: a node is not its content, and a card that vanished when the page went quiet would
 *  read as a card that failed to draw. */
export function cookingGroups(rows: readonly Row[], views: readonly View[] = loadViews()): string {
  const view = views.find((v) => v.filter === "cooking");
  const inside =
    rows.length === 0
      ? `<p class="empty">${escape(view === undefined ? "nothing is stuck" : view.empty)}</p>`
      : grouped(rows).map(group).join("");
  return (
    `<section class="cooking"${named("cooking")}>` +
    `<h2>${escape(SAYS)}</h2><p class="empty">${escape(LEAD)}</p>` +
    `${inside}${cards(rows)}</section>`
  );
}

/** The whole document: the groups, in the shell design.yaml declares. */
export function cookingPage(rows: readonly Row[], views?: readonly View[]): Reply {
  return html(document(views === undefined ? cookingGroups(rows) : cookingGroups(rows, views)));
}

/** Which reading of the workspace this page is served from. The same `board()` the index
 *  page reads, and `cooking` is one of its groups — so the page and the box on `/` can
 *  never disagree about what is in flight. See `discover.ts`. */
export const READS = "board";

/** The page, bound to a way of getting the board as it is now. Read fresh on every request,
 *  for the reason the index is: a row that moved while the page sat open has moved. */
export const cookingAt = (board: () => Board): Page => shelled(() => cookingGroups(board().cooking));
