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
 *  What a card says beyond the row is a project's pulse: how long since anything under it
 *  moved, and how many tests have gone green per hour. Both are `@wecode/core`'s — `silence`
 *  and `throughput` — and both are optional, because the page is readable without them and a
 *  page that could only be drawn with them could not be tested without a database. */
import type { Board, Row } from "@wecode/core";
import { loadOffPage, loadViews, sectionMark, type View } from "@wecode/tui";
import { html, type Page, type Reply, type Routes } from "../server.js";
import { escape } from "./board.js";

/** A project's beat, by project id: how long since anything under it moved, in
 *  milliseconds, and its passes per hour oldest bucket first. Each is a `Map` because that
 *  is what `silence()` and `throughput()` return — a project missing from one is a project
 *  nothing can date, which is not the same as one that has been quiet for zero minutes. */
export interface Pulse {
  readonly silence?: ReadonlyMap<number, number>;
  readonly throughput?: ReadonlyMap<number, readonly number[]>;
}

/** The page's own presentation, and the only thing here that is not read off config. The
 *  same dark monospace as the board: they are two questions about one workspace, not two
 *  products. */
const STYLE = `
  :root { color-scheme: dark }
  body { margin: 0; padding: 1.5rem; background: #111; color: #ddd;
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace }
  main { display: grid; gap: 1.25rem; max-width: 60rem; margin: 0 auto }
  h1 { font-size: 1rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
       margin: 0; color: #888 }
  h1 a { color: inherit; text-decoration: none }
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

/** The whole document. */
export function projectsPage(
  board: Board,
  pulse: Pulse = {},
  views: readonly View[] = loadViews(),
  off: readonly View[] = loadOffPage(),
): Reply {
  const box = heading(off);
  const strip = `<ul class="strip">${views.map((v) => cell(v, board)).join("")}</ul>`;
  const cards =
    board.projects.length === 0
      ? `<p class="empty">${escape(box.empty)}</p>`
      : `<ul class="cards">${board.projects.map((p) => card(p, pulse)).join("")}</ul>`;
  return html(
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escape(box.title)} — wecode</title><style>${STYLE}</style></head>` +
      `<body><main><h1>${escape(box.title)}</h1>${strip}${cards}</main></body></html>\n`,
  );
}

/** The page, bound to a way of getting the current rows and beat. Both are read on every
 *  request for the reason the board is: a page drawn from a snapshot taken at boot is a page
 *  that is wrong by the time somebody reads it. */
export const projectsAt =
  (rows: () => Board, pulse: () => Pulse = () => ({})): Page =>
  () =>
    projectsPage(rows(), pulse());

/** Where the projects page answers. It is the front page — the first question anybody asks
 *  of a workspace is which projects are in it and which of them is moving — and it keeps its
 *  own name as well, so a link to it is a link that says what it points at. */
export const PROJECTS_PATHS = ["/", "/projects"] as const;

export const projectRoutes = (rows: () => Board, pulse?: () => Pulse): Routes =>
  Object.fromEntries(PROJECTS_PATHS.map((path) => [path, projectsAt(rows, pulse)]));
