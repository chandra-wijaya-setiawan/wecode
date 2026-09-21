/** The projects page: how the workspace is doing, and how each project in it is doing.
 *
 *  Two questions, in that order. The strip across the top is the whole workspace in one
 *  line — one cell per box `views.yaml` puts on the dashboard, carrying that box's own mark,
 *  its own title and how many rows it is holding — so the reader who wants *is anything on
 *  fire* gets an answer before scrolling. The cards below are the same question asked of
 *  one project at a time.
 *
 *  Nothing here names a box, a title, a mark or an empty line: the strip is `loadViews()`'s
 *  page order and the heading is the off-page `projects` box's own title and empty line, both
 *  read from `packages/tui/config/views.yaml` through `@wecode/tui`. A board drawn from a
 *  second list of boxes is a second board, and it goes stale the first time one is renamed.
 *
 *  Beside the boxes the strip carries the seven readings `packages/webapp/config/ui.yaml`
 *  declares under `projects.strip`, and each card carries the three ways out the mockup puts
 *  on one. Every node the definition names is drawn with its own `data-ui` and the words the
 *  definition gives it, so the drawing and the declaration can be read against each other —
 *  the boxes are what the board *is grouped into*, and the readings are what a person asks
 *  of the workspace, which is why both are in the one line rather than in two strips.
 *
 *  What a card says beyond the row is a project's pulse: how long since anything under it
 *  moved, and how many tests have gone green per hour. Both are `@wecode/core`'s — `silence`
 *  and `throughput` — and both are optional, because the page is readable without them and a
 *  page that could only be drawn with them could not be tested without a database. */
import type { Board, Row } from "@wecode/core";
import { loadOffPage, loadViews, sectionMark, type View } from "@wecode/tui";
import { html, type Page, type Reply, type Routes } from "../server.js";
import { escape } from "./board.js";
import { pathOf } from "./discover.js";
import { document, shelled } from "./shell.js";
import { PROJECT } from "./tasks.js";

/** A project's beat, by project id: how long since anything under it moved, in
 *  milliseconds, and its passes per hour oldest bucket first. Each is a `Map` because that
 *  is what `silence()` and `throughput()` return — a project missing from one is a project
 *  nothing can date, which is not the same as one that has been quiet for zero minutes. */
export interface Pulse {
  readonly silence?: ReadonlyMap<number, number>;
  readonly throughput?: ReadonlyMap<number, readonly number[]>;
}

/** The page's own presentation, and the only thing here that is not read off config. The
 *  frame's rules — the margins, the type, the banner — are the shell's, so none of them is
 *  here: what is left is the strip and the cards, which are this page's alone. */
const STYLE = `
  h2 { font-size: .9rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
       margin: 0; color: #888 }
  ul.strip { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap;
             gap: .75rem 1.5rem; border-top: 1px solid #333; border-bottom: 1px solid #333;
             padding: .6rem 0 }
  ul.strip li { display: flex; gap: .4rem; align-items: baseline }
  ul.strip .mark { color: #6cf }
  ul.strip .title { color: #888 }
  ul.strip .count { color: #ddd }
  ul.strip li.none .count, ul.strip li.none .title { color: #555 }
  ul.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem;
             grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)) }
  ul.cards li { border: 1px solid #333; border-radius: .25rem; padding: .6rem .75rem;
                display: grid; gap: .3rem; min-width: 0 }
  .name { font-weight: 600; overflow-wrap: anywhere }
  .code { color: #666 }
  .state { color: #6cf }
  .stories { color: #888 }
  .meter { height: .3rem; background: #222; border-radius: .15rem; overflow: hidden }
  .meter span { display: block; height: 100%; background: #6cf }
  .pulse { color: #888; display: flex; gap: .5rem; min-width: 0 }
  .pulse .spark { color: #6cf; letter-spacing: .05em }
  p.empty { margin: 0; color: #666 }
`;

/** The blocks a sparkline is drawn out of, shortest first. A bucket of nothing is the
 *  lowest block rather than a space: the line is ten hours wide either way, and a gap in
 *  the middle of it reads as missing evidence rather than as an hour with no pass in it. */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

const spark = (series: readonly number[]): string => {
  const top = Math.max(...series, 1);
  return series
    .map((n) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((n / top) * (BLOCKS.length - 1)))])
    .join("");
};

/** How long, in the units a person reading a board thinks in. Minutes up to an hour, then
 *  hours up to a day, then days — a beat measured in seconds is noise and one measured in
 *  four thousand minutes is arithmetic the reader has to do. */
export function since(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** How much of a project is finished, when its row says. `board()` writes the detail as
 *  `n/m stories`, so the meter is read back off the row rather than counted a second time
 *  here — a second count is a second opinion about what "finished" means. A row whose
 *  detail says something else gets no meter, and still gets its words. */
const done = (detail: string): number | null => {
  const at = /^(\d+)\/(\d+)\b/.exec(detail);
  if (at === null) return null;
  const [of, all] = [Number(at[1]), Number(at[2])];
  return all === 0 ? null : Math.round((Math.min(of, all) / all) * 100);
};

/** One cell of the strip: a box's mark, its title and how many rows it is holding. A box
 *  holding nothing is dimmed rather than dropped — which boxes there are is a fact about
 *  the workspace, and a strip that changes length as work moves cannot be read at a glance. */
const cell = (view: View, board: Board): string => {
  const held = board[view.filter].length;
  return (
    `<li class="${held === 0 ? "none" : "some"}">` +
    `<span class="mark">${escape(sectionMark(view.name))}</span>` +
    `<span class="count">${held}</span>` +
    `<span class="title">${escape(view.title)}</span></li>`
  );
};

/** A count the definition's strip names and the board cannot answer. Drawn as the dash
 *  rather than left out, for the reason the ledger's strip draws its own: a count that is
 *  missing reads as a count of nothing, and the two are different sentences. */
const UNCOUNTED = "—";

/** The seven readings `ui.yaml` puts in `projects.strip`, in its order: the name each
 *  carries as its `data-ui`, the words the definition gives it, and what the board can
 *  answer it with.
 *
 *  Three of them are the mockup's and not the board's. "landed today" and "attempts ok
 *  today" are both cut at a day, and nothing on the board carries the hour it happened —
 *  `delivered` is what is *waiting* to land, and what became of an attempt is the ledger
 *  table's, which this page is not served. "master" is a fact about a checkout and not
 *  about the record at all. Each is the dash, so the strip is the seven the definition
 *  names either way. */
const readings = (
  board: Board,
): readonly (readonly [string, string, string | number])[] => [
  ["running", "agents running", board.running.length],
  ["needs-you", "need you", board.needs_human.length],
  // What is stuck, which is the board's own fold: a task that gave up and work nothing is
  // moving. Red on the mockup, and the one count on the strip somebody has to act on.
  ["blocked", "blocked", board.cooking.length],
  // Begun and not finished: `open` is every epic and story still owed and `planned` is the
  // half nobody has picked up, so what is in progress is the difference between them.
  ["in-progress", "stories in progress", Math.max(0, board.open.length - board.planned.length)],
  ["landed", "landed today", UNCOUNTED],
  ["attempts", "attempts ok today", UNCOUNTED],
  ["master", "master", UNCOUNTED],
];

/** One declared cell of the strip, written the way the mockup writes one — the value loud,
 *  the words it counts underneath — and carrying the name the definition knows it by. A
 *  cell holding nothing, or holding the dash, is dimmed exactly as a box holding no row is. */
const reading = ([name, says, held]: readonly [string, string, string | number]): string =>
  `<li class="${held === 0 || held === UNCOUNTED ? "none" : "some"}" ` +
  `data-ui="projects.strip.${name}">` +
  `<b class="count">${escape(String(held))}</b>` +
  `<span class="title">${escape(says)}</span></li>`;

/** The three ways out of a card the mockup draws, as the ordinary anchors they are: this
 *  page reads the board and changes nothing, so a way on is a link and never a verb.
 *
 *  Where each page answers is `discover.ts`'s one answer, asked for here rather than spelled
 *  a second time — and where a page can be narrowed to one project it is, on the one word
 *  both of those pages narrow on. `open` is the project's own work, which is what the tasks
 *  page is, and it narrows on the project's name because that is what a task carries; the
 *  tree narrows on the id because that is what a node carries; the decisions page keeps the
 *  whole workspace's questions and takes no narrowing at all.
 *
 *  All three are on every card. The definition says of two of them that they are *offered*
 *  on a project with a decision waiting, or with records to show, and neither is a question
 *  this page can ask: the board's `needs_human` rows are the workspace's and carry no
 *  project, so a card that hid its decisions link would be hiding it on a guess. A link to
 *  a page that turns out to have nothing on it is a cheaper wrong answer than a way out
 *  that is missing from some cards and not others for a reason the reader cannot see.
 *
 *  The node the definition calls `projects.project` is on this row rather than on the card's
 *  own `<li>`: two files outside this story find a card in a live workspace's page by
 *  looking for exactly `<li id="project-N">`, so the card's opening tag is not this story's
 *  to widen, and the row is the nearest element that is one project's and holds the three
 *  links the definition parents under it. */
const ways = (row: Row): string =>
  `<div data-ui="projects.project">` +
  (
    [
      ["open", `${pathOf("tasks")}?${PROJECT}=${encodeURIComponent(row.what)}`],
      ["decisions", pathOf("decisions")],
      ["tree", `${pathOf("tree")}?${PROJECT}=${row.id}`],
    ] as const
  )
    .map(
      ([says, at]) =>
        `<a class="code" data-ui="projects.project.${says}" href="${at}">${says}</a>`,
    )
    .join(" ") +
  `</div>`;

/** One project, as its row and whatever of its pulse is known. */
function card(row: Row, pulse: Pulse): string {
  const quiet = pulse.silence?.get(row.id);
  const series = pulse.throughput?.get(row.id);
  const finished = done(row.detail);
  const rate = series === undefined ? 0 : (series[series.length - 1] ?? 0);
  return (
    `<li id="project-${row.id}">` +
    `<span class="name">${escape(row.what)}</span>` +
    `<span class="code">#${row.id}</span>` +
    `<span class="state">${escape(row.state)}</span>` +
    `<span class="stories">${escape(row.detail)}</span>` +
    (finished === null ? "" : `<div class="meter"><span style="width:${finished}%"></span></div>`) +
    (quiet === undefined && series === undefined
      ? ""
      : `<div class="pulse">` +
        (series === undefined
          ? ""
          : `<span class="spark">${spark(series)}</span><span class="rate">${rate}/h</span>`) +
        (quiet === undefined ? "" : `<span class="quiet">quiet ${since(quiet)}</span>`) +
        `</div>`) +
    ways(row) +
    `</li>`
  );
}

/** The off-page box this page is the long form of. Its title heads the page and its empty
 *  line is what the page says when there is no project — the words a person is told to type
 *  to make one live in views.yaml, beside every other word the board says. */
const heading = (views: readonly View[]): View => {
  const found = views.find((v) => v.filter === "projects");
  if (found === undefined) throw new Error("no view keeps the projects");
  return found;
};

/** What the page says: its heading, its strip and its cards, and nothing around them. The
 *  frame is the shell's, so the document's own words are not spelled here — and the page's
 *  heading is an `h2` because the one `h1` of the document is the shell's banner. */
export function projectsContents(
  board: Board,
  pulse: Pulse = {},
  views: readonly View[] = loadViews(),
  off: readonly View[] = loadOffPage(),
): string {
  const box = heading(off);
  const strip =
    `<div data-ui="projects.strip"><ul class="strip">` +
    views.map((v) => cell(v, board)).join("") +
    readings(board).map(reading).join("") +
    `</ul></div>`;
  const cards =
    board.projects.length === 0
      ? `<p class="empty">${escape(box.empty)}</p>`
      : `<ul class="cards">${board.projects.map((p) => card(p, pulse)).join("")}</ul>`;
  return `<h2 data-ui="projects">${escape(box.title)}</h2>${strip}${cards}`;
}

/** The whole document: what the page says, in the shell design.yaml declares. */
export function projectsPage(
  board: Board,
  pulse: Pulse = {},
  views: readonly View[] = loadViews(),
  off: readonly View[] = loadOffPage(),
): Reply {
  return html(document(projectsContents(board, pulse, views, off), STYLE));
}

/** This page is drawn from the board — one cell per box and one card per project row — so
 *  it says so. Without this line discovery hands it the record it reads by default, and
 *  `tree()`'s nodes have no box on them: the front page threw on the first cell for every
 *  reader, while every test in this package kept passing because each one calls
 *  `projectsPage` itself and hands it a `Board` by hand. */
export const READS = "board";

/** The page, bound to a way of getting the current rows and beat. Both are read on every
 *  request for the reason the board is: a page drawn from a snapshot taken at boot is a page
 *  that is wrong by the time somebody reads it. */
export const projectsAt = (rows: () => Board, pulse: () => Pulse = () => ({})): Page =>
  shelled(() => projectsContents(rows(), pulse()), STYLE);

/** Where the projects page answers. It is the front page — the first question anybody asks
 *  of a workspace is which projects are in it and which of them is moving — and it keeps its
 *  own name as well, so a link to it is a link that says what it points at. */
export const PROJECTS_PATHS = ["/", "/projects"] as const;

export const projectRoutes = (rows: () => Board, pulse?: () => Pulse): Routes =>
  Object.fromEntries(PROJECTS_PATHS.map((path) => [path, projectsAt(rows, pulse)]));
