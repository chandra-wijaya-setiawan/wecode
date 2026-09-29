/** The one sketch a reader opened, at full width, in a frame — and the two ways there are of
 *  looking at one.
 *
 *  This is `pages/sketches.ts`'s other half, and it is here rather than there because the
 *  page is a list and this is a drawing: the list reads the record and writes rows, and none
 *  of what is below touches a row. The split is also what makes room — a page at its ceiling
 *  cannot grow a second frame — but the reason it is *this* line and not some other is that
 *  the two halves answer different questions. `pages/sketches.ts` answers "what has been
 *  drawn"; this answers "what does this one look like, and what may I do to it".
 *
 *  **View** is the drawing handed over whole, in an origin of its own, with the board's own
 *  script kept out of it. **Edit** is the same drawing served from a path of this board's,
 *  in this board's origin, so that the review loop `browser/annotate.ts` serves can reach
 *  into the frame and turn a click into a note. Those are not two renderings of one idea,
 *  they are two different security decisions, and the whole of the difference between them
 *  is in `sandboxed` and `sameOrigin` below.
 *
 *  Which of the two a reader gets is in the target, next to which sketch they opened — the
 *  same reason the sketch itself is: `/sketches?open=112` is the drawing and
 *  `/sketches?open=112&mode=edit` is the drawing with the notes machine over it, and both
 *  are links a person can send to another person. A mode held in a script would be a mode
 *  nobody can link to, bookmark or reload into.
 *
 *  Neither frame reloads itself when the drawing changes under it. That wants the poll the
 *  dock already has, which is `pages/shell.ts`'s and `browser/dock.ts`'s; story 651 holds it
 *  and a follow-up carries it. Until then a reader reloads the page.
 *
 *  The words `view` and `edit` are written here for now. They are a surface's words and will
 *  read off `config/ui.yaml` the way the bar's two acts already do — a follow-up carries
 *  that, and it is the reason both places that offer them go through one `waysIn`. */
import { readFileSync } from "node:fs";
import type { Sketch } from "@wecode/core";
import { REVIEW } from "./browser/annotate.js";
import { escape } from "./pages/board.js";
import { html, type Page, type Reply, text } from "./server.js";

// ─── what the target says ───────────────────────────────────────────────────────────

/** Which sketch the reader opened, as the target spells it. One name, so a link built by
 *  the page and a link typed by a person are the same link. */
export const PARAM = "open";

/** And how they are looking at it. */
export const MODE = "mode";

/** The two ways in. `view` is what a bare `?open=` means, so the word is never in a link the
 *  page builds for the list — it is here because the opened header offers the way back to it
 *  from the other one, and because a mode with no name is a mode nobody can ask for. */
export const VIEW = "view";
export const EDIT = "edit";
export type Way = typeof VIEW | typeof EDIT;

/** In the order they are offered, which is the order they cost: looking, and then reaching
 *  in. */
export const WAYS: readonly Way[] = [VIEW, EDIT];

/** Which sketch the reader opened: the one the target names, and nothing when it names
 *  none. Nothing rather than the first, because the list is the page and one drawing is the
 *  reader having asked for it. A number is a target that named a sketch the record has not
 *  got, which is a thing to say rather than a thing to fall back from. */
export function opened(all: readonly Sketch[], url: URL): Sketch | number | null {
  const said = url.searchParams.get(PARAM);
  if (said === null) return null;
  const id = Number(said);
  if (!Number.isInteger(id)) return null;
  return all.find((s) => s.id === id) ?? id;
}

/** How they are looking at it. `edit` exactly, and everything else is `view` — a target that
 *  said nothing, or said a word nobody wrote, gets the frame the board cannot reach into.
 *  Falling the other way would make every mistyped link an invitation. */
export const modeOf = (url: URL): Way => (url.searchParams.get(MODE) === EDIT ? EDIT : VIEW);

/** A link to one sketch, one way in. `view` is the bare target rather than `mode=view`, so a
 *  reader who opens a sketch and a reader who came back from editing one are at one address
 *  and not two that draw the same thing. */
export const linkTo = (id: number, way: Way): string =>
  way === EDIT ? `?${PARAM}=${id}&amp;${MODE}=${EDIT}` : `?${PARAM}=${id}`;

// ─── what a sketch says of itself ───────────────────────────────────────────────────

/** The state column: whether this is still only a sketch, or the story it became.
 *
 *  The mock spells the story's own state beside its number — `story #491 · signed`. The
 *  record carries `story_id` and nothing else about it, and a state guessed here would be a
 *  state nobody can check, so the number is all that is said. Saying more wants a reading
 *  that carries the story with the sketch, which is `bin.ts`'s and not this file's. */
export const stateOf = (s: Sketch): string =>
  s.story_id === null ? "sketch" : `story #${s.story_id}`;

/** A sketch that earned a story is marked: most of them stay sketches, and the ones that
 *  did not are what a reader is looking down the column for. */
export const storied = (s: Sketch): boolean => s.story_id !== null;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a sketch was last touched, in the mock's own words. Relative, because a sketch is a
 *  thought in progress and what a reader wants is how stale the thought is, not a timestamp
 *  to subtract in their head. `now` is a parameter so the words can be proved. */
export function touched(at: string, now: number = Date.now()): string {
  const ago = now - Date.parse(at);
  if (!Number.isFinite(ago)) return "at no time the record can read";
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < 2 * HOUR) return "an hour ago";
  if (ago < DAY) return `${Math.floor(ago / HOUR)} hours ago`;
  if (ago < 2 * DAY) return "yesterday";
  return `${Math.floor(ago / DAY)} days ago`;
}

/** What the open view says when the target names a sketch the record has not got. A reader
 *  who followed a stale link is told so, rather than shown the first drawing. */
export const nothingAt = (id: number): string => `no sketch #${id} in the record`;

/** What the frame says when the row is there and the file is not. The row goes and the
 *  drawing stays, says `dropSketch`; the other way round happens too — a drawing somebody
 *  moved or deleted by hand — and the reader is owed the path rather than an empty box. */
export const noDrawing = (at: string): string => `no drawing on this machine at ${at}`;

// ─── the route the edit frame is served from ────────────────────────────────────────

/** The drawing, read off the disk the record points at. `html` is an absolute path — the
 *  cli writes it under the workspace's own home — so nothing here guesses where anybody is
 *  standing, and a path the record does not hold is never read. */
const drawingAt = (at: string): string | null => {
  try {
    return readFileSync(at, "utf8");
  } catch {
    return null;
  }
};

/** Where one drawing answers on its own, in this board's origin.
 *
 *  Under the page's own path, because that is what it is a part of, and it takes the page's
 *  own `open` so a person editing a link edits one word in one place. */
export const DRAWN_AT = "/sketches/drawing";

/** Where the edit frame points. */
export const drawnFrom = (id: number): string => `${DRAWN_AT}?${PARAM}=${id}`;

/** One drawing, as a document of this board's own.
 *
 *  This is the path the view frame deliberately does not have, and the one thing that makes
 *  it safe to add is that it reads no path. The target names an *id*; the id is looked up in
 *  the record; the file that is opened is the record's own `html` column and can be nothing
 *  else. A route that took a path would be a route that serves the operator's private key to
 *  anything that can reach this port.
 *
 *  It is mounted in `bin.ts` beside `/answer` and the dock's files rather than discovered
 *  under `pages/`, which is not a formality: `docked()` puts the dock's own script into every
 *  document the pages hand back, and a sketch is not the board — what is served here is the
 *  bytes an agent wrote and nothing of this surface's. */
export const drawingsAt = (all: () => readonly Sketch[]): Page =>
  (url: URL): Reply => {
    const one = opened(all(), url);
    if (one === null) return text(400, `${DRAWN_AT} draws one sketch — say which, as ?${PARAM}=<id>`);
    if (typeof one === "number") return text(404, nothingAt(one));
    const drawn = drawingAt(one.html);
    return drawn === null ? text(404, noDrawing(one.html)) : html(drawn + ARMED);
  };

/** What turns a served drawing into one a person can annotate.
 *
 *  One tag, and it is `boot.js` rather than `overlay.js`: `overlay.js` is a state machine that
 *  starts nothing, so a document that asked for it loaded a class nobody constructed and a
 *  reviewer got no overlay at all. `boot.js` is the line that builds one, mounts the adapter
 *  over this document and turns picking on. Everything else it needs it imports itself, so
 *  this file keeps no copy of that import graph to get wrong the day one of them moves.
 *
 *  Appended rather than woven in: a drawing is an agent's own document and this route does not
 *  parse it. A module script at the end runs after the document is there to be picked in, which
 *  is the whole requirement — and a sketch with no `</body>` to insert before is still a sketch
 *  a reviewer should be able to mark up. */
const ARMED = `<script type="module" src="${REVIEW.boot}"></script>`;

// ─── the two frames ─────────────────────────────────────────────────────────────────

const FRAME = `class="drawing" data-ui="sketches.open.drawing"`;

/** Looking at it: the document handed over whole, in an origin of its own.
 *
 *  `srcdoc` rather than a route: the board serves no second path that answers with a file off
 *  the operator's disk *for this*, and the dock's own script — which is added to every html
 *  reply the pages make — is not injected into somebody's sketch. Sandboxed without
 *  `allow-same-origin`, so a drawing's own script runs (a sketch of a surface is often a
 *  working one) in an origin of its own and cannot reach the board around it. */
const sandboxed = (s: Sketch, drawn: string): string =>
  `<iframe ${FRAME} sandbox="allow-scripts" ` +
  `title="${escape(s.name)}" srcdoc="${escape(drawn)}"></iframe>`;

/** Reaching into it: the same drawing, from this board's own origin.
 *
 *  Which is the entire point, and the reason it is a second frame rather than an attribute on
 *  the first. Annotating a sketch means turning a click inside it into a CSS path, a tag and
 *  the words that were showing, and `browser/annotate.ts` serves the painter's machine that
 *  does exactly that — but it can only read a document the page it runs in is allowed to
 *  read. An opaque origin is a frame nobody can pick an element in.
 *
 *  So there is no `sandbox` here, and its absence is the decision rather than an omission: a
 *  `sandbox` that had to list `allow-same-origin` beside `allow-scripts` would be a fence with
 *  its own gate held open, which reads as a guard and is not one. What keeps this honest is
 *  the route instead — it serves the record's own drawings and nothing else a target can
 *  name, and this frame is offered only where a reader asked for it in so many words. */
const sameOrigin = (s: Sketch): string =>
  `<iframe ${FRAME} title="${escape(s.name)}" src="${drawnFrom(s.id)}"></iframe>`;

/** The drawing, the way this reader asked to see it. Read here for the view branch and
 *  fetched by the browser for the edit branch, because the edit frame is served from a route
 *  that reads the very same file — so a drawing that has gone says so either way, once here
 *  and once at `drawingsAt`. */
const frame = (s: Sketch, way: Way): string => {
  if (way === EDIT) return sameOrigin(s);
  const drawn = drawingAt(s.html);
  if (drawn === null) {
    return `<p class="gone" data-ui="sketches.open.drawing">${escape(noDrawing(s.html))}</p>`;
  }
  return sandboxed(s, drawn);
};

// ─── the two ways in ────────────────────────────────────────────────────────────────

const wayIn = (id: number, way: Way, at: Way | null): string =>
  `<a href="${linkTo(id, way)}" data-ui="sketches.way.${way}"` +
  `${way === at ? ` aria-current="page"` : ""}>${way}</a>`;

/** Both ways into one sketch, as the row offers them and as the opened header offers them.
 *
 *  One function for the two places, because they are the same offer: a reader who is looking
 *  at the list and a reader who is already inside a drawing want the same two things, and two
 *  spellings of them would be two things to keep in step. `at` is which way the reader is
 *  already in, marked rather than dropped — the pair does not move about under them, and the
 *  one that is not a link to anywhere new still says where they are.
 *
 *  It wears `row-acts`, which is the shape the design declares for exactly this, so the words
 *  are drawn by a rule somebody signed in both places rather than by one added here. */
export const waysIn = (id: number, at: Way | null = null): string =>
  `<span class="row-acts">${WAYS.map((way) => wayIn(id, way, at)).join("")}</span>`;

// ─── the opened sketch ──────────────────────────────────────────────────────────────

/** The one sketch, the way back to the list above it, and the other way in beside that. */
export function openedSketch(s: Sketch, way: Way, now: number): string {
  return (
    `<div class="open" id="open-${s.id}" data-ui="sketches.open">` +
    `<p class="back"><a href="?" data-ui="sketches.open.back">← every sketch</a>` +
    `${waysIn(s.id, way)}</p>` +
    `<h3><span class="id">#${s.id}</span>${escape(s.name)}</h3>` +
    `<p class="says">${escape(s.says)}</p>` +
    `<p class="meta"><span class="kind">${escape(s.kind)}</span>` +
    `<span class="state${storied(s) ? " signed" : ""}">${escape(stateOf(s))}</span>` +
    `<span class="when">${escape(touched(s.updated_at, now))}</span>` +
    `<span class="mono">${escape(s.html)}</span></p>` +
    frame(s, way) +
    `</div>`
  );
}

/** The way back with nothing to go back from: a target that named a sketch the record has
 *  not got still gets the link, because it is the one thing a reader wants next. No ways in
 *  beside it — there is nothing here to look at either way. */
export const stale = (id: number): string =>
  `<div class="open" data-ui="sketches.open">` +
  `<p class="back"><a href="?" data-ui="sketches.open.back">← every sketch</a></p>` +
  `<p class="empty">${escape(nothingAt(id))}</p></div>`;
