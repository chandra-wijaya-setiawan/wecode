/** Everything drawn before it was work, as a list — and the one a reader opened, at full
 *  width, in a frame.
 *
 *  A sketch is a record of a drawing: `core`'s `sketch` table holds the name, the kind, the
 *  line it says of itself, the story it became if it became one, and the path of the html.
 *  The drawing itself is a file an agent wrote, which is the whole design — a picture kept
 *  in a column would need a verb to fetch it out and a diff nobody could read.
 *
 *  So this page is a list you scan and then one drawing you look at, and which of the two it
 *  is, is in the target: `/sketches` is the list and `/sketches?open=112` is the drawing, the
 *  way `/tasks?task=8` picks a task. A selection held in a script would be a selection
 *  nobody can link to, bookmark or reload into.
 *
 *  There is no new-sketch control, and that is a decision and not an omission: a sketch is
 *  drawn by the orchestrator, because drawing one means writing a file and an agent is the
 *  one who writes files. What the bar offers is the two things a person does *to* a drawing
 *  — turn it into work, or take the row out — and neither is this surface's verb either.
 *  Both are typed at the dock, unsent: the words land on the command line the operator was
 *  already watching, where they can be read, edited and sent, or not. `browser/annotate.ts`
 *  posts a round of review to `SHELL_AT` for the same reason, and this posts to the same
 *  route — `keys`, not `prompt`, because the far end submits a `prompt` for you and the
 *  whole point here is that nothing is sent on a person's behalf.
 *
 *  The frame does not yet reload itself when the drawing changes under it. That wants the
 *  poll the dock already has, which is `shell.ts`'s and `dock.ts`'s; story 651 holds it and
 *  a follow-up carries it. Until then a reader reloads the page.
 *
 *  Every element carries the `data-ui` name `config/ui.yaml` declares it under, so the drawn
 *  surface and the declaration can be held against one another by name rather than by eye. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Sketch } from "@wecode/core";
import { encode } from "@wecode/painter/dist/client/terminal.js";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { CONTROLS, document, DOCKED, shelled, SHELL_AT } from "./shell.js";

/** The reading this page is served from. Not the record: a sketch hangs under nothing and
 *  is in no tree, so `tree()`'s nodes carry none of it. */
export const READS = "sketches";

/** Which sketch the reader opened, as the target spells it. One name, so a link built by
 *  the page and a link typed by a person are the same link. */
export const PARAM = "open";

export class SketchesUiError extends Error {}

/** Where the words are and what reads them. The parser is resolved through `@wecode/tui`,
 *  which owns the `yaml` dependency, the way `tree.ts` reaches for it. */
const here = createRequire(fileURLToPath(import.meta.url));
const UI = fileURLToPath(new URL("../../config/ui.yaml", import.meta.url));
const { parse } = createRequire(here.resolve("@wecode/tui"))("yaml") as {
  parse: (text: string) => unknown;
};

const mapOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** One thing the bar offers: the word it is offered under, the class it wears, and what it
 *  types at the dock — a lead said once, a clause per picked sketch, and what joins them.
 *  The clause is a template over the record's own columns, so a page never decides what a
 *  person's machine is told to do: `Remove` types the cli's own `wecode sketch drop <id>`,
 *  and `Make a story from it` types prose because no verb turns a drawing into work. */
export interface Act {
  readonly id: string;
  /** The short name the markup keys a row's clauses by. */
  readonly name: string;
  readonly says: string;
  readonly kind: string;
  readonly lead: string;
  readonly row: string;
  readonly joins: string;
}

/** What `ui.yaml` declares for this page: the bar, and the line above the list. A field the
 *  declaration does not hold is a refusal and never a default, for the reason `tree.ts`'s
 *  are — a word this file supplied when the file was silent is a word nobody signed. */
export interface Ui {
  readonly acts: readonly Act[];
  /** What the bar says of the ticks: the word after the count, and the words for none. */
  readonly picked: string;
  readonly none: string;
  readonly pickedId: string;
  readonly hint: string;
}

const wordOf = (v: unknown, at: string, path: string): string => {
  if (typeof v !== "string") throw new SketchesUiError(`${path}: ${at} says nothing`);
  return v;
};

function actOf(v: unknown, n: number, path: string): Act {
  const said = mapOf(v);
  const at = `sketches.acts[${n}]`;
  return {
    id: wordOf(said["id"], `${at}.id`, path),
    name: wordOf(said["name"], `${at}.name`, path),
    says: wordOf(said["says"], `${at}.says`, path),
    kind: wordOf(said["kind"], `${at}.kind`, path),
    lead: wordOf(said["lead"], `${at}.lead`, path),
    row: wordOf(said["row"], `${at}.row`, path),
    joins: wordOf(said["joins"], `${at}.joins`, path),
  };
}

export function loadUi(path: string = UI): Ui {
  const block = mapOf(mapOf(parse(readFileSync(path, "utf8")))["sketches"]);
  const said = block["acts"];
  if (!Array.isArray(said) || said.length === 0) {
    throw new SketchesUiError(`${path}: sketches offers no acts`);
  }
  const ticks = mapOf(block["picked"]);
  return {
    acts: said.map((a, n) => actOf(a, n, path)),
    picked: wordOf(ticks["says"], "sketches.picked.says", path),
    none: wordOf(ticks["none"], "sketches.picked.none", path),
    pickedId: wordOf(ticks["id"], "sketches.picked.id", path),
    hint: wordOf(block["hint"], "sketches.hint", path),
  };
}

// ─── what a row says ────────────────────────────────────────────────────────────────

/** What the page says when the record holds no sketch at all. Most days there are none,
 *  and a page that came back blank reads as a page that failed. */
const NOTHING_DRAWN = "nothing drawn yet — a sketch is drawn by the orchestrator";

/** What the open view says when the target names a sketch the record has not got. A reader
 *  who followed a stale link is told so, rather than shown the first drawing. */
const nothingAt = (id: number): string => `no sketch #${id} in the record`;

/** What the frame says when the row is there and the file is not. The row goes and the
 *  drawing stays, says `dropSketch`; the other way round happens too — a drawing somebody
 *  moved or deleted by hand — and the reader is owed the path rather than an empty box. */
const noDrawing = (at: string): string => `no drawing on this machine at ${at}`;

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
const storied = (s: Sketch): boolean => s.story_id !== null;

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

// ─── what the dock is typed ─────────────────────────────────────────────────────────

/** One act's clause for one sketch, the record's own columns filled in. */
export const clauseOf = (act: Act, s: Sketch): string =>
  act.row
    .replace(/%id%/g, String(s.id))
    .replace(/%name%/g, s.name)
    .replace(/%html%/g, s.html);

/** What an act types at the dock for a set of picked sketches: the lead once, then a clause
 *  each. The browser composes the same sentence out of the same clauses, so what a reader's
 *  shell receives is proved here rather than read off a screenshot. */
export const typed = (act: Act, picked: readonly Sketch[]): string =>
  act.lead + picked.map((s) => clauseOf(act, s)).join(act.joins);

/** The kind of frame those words go up as. Keys and not a prompt: the far end submits a
 *  prompt for you — `pty.ts` appends the return — and an instruction sent on a person's
 *  behalf is the one thing this bar must not do. */
export const KIND = "keys" as const;

/** The one line of the browser's script that makes a frame. Held against `framed` below by
 *  this page's own test, so the frame a reader's browser builds and the frame the route
 *  decodes are one format rather than two that agree today. */
export const FRAMES = `(data) => JSON.stringify({ kind: ${JSON.stringify(KIND)}, data })`;

/** The same frame on this side of the wire, by the painter's own encoder. */
export const framed = (data: string): string => encode({ kind: KIND, data });

// ─── the list ───────────────────────────────────────────────────────────────────────

const SECTION = "sketches";
const LIST = "sketches.list";
const ITEM = "sketches.list.item";
const BAR = "sketches.bar";

/** The clauses one row hands the bar, by the act that would type them — one attribute, read
 *  back by the browser as the JSON it is. The words are built here and not there so that
 *  every sentence a person's shell can receive from this page is a sentence a test has
 *  already read. */
const wordsOf = (acts: readonly Act[], s: Sketch): string =>
  escape(JSON.stringify(Object.fromEntries(acts.map((a) => [a.name, clauseOf(a, s)]))));

/** One sketch: a row and not a card, because this is a list you scan. The tick leads
 *  because it is what the bar acts on; the name carries what the sketch says of itself
 *  under it, cut to two lines by the look rather than here, so the row keeps the record's
 *  own words and a long line costs the list no height. */
function row(s: Sketch, acts: readonly Act[], now: number): string {
  return (
    `<li id="sketch-${s.id}" data-ui="${ITEM}" data-words="${wordsOf(acts, s)}">` +
    `<input type="checkbox" value="${s.id}" aria-label="pick #${s.id}">` +
    `<span class="id">#${s.id}</span>` +
    `<span class="name"><a href="?${PARAM}=${s.id}">${escape(s.name)}</a>` +
    `<span class="says">${escape(s.says)}</span></span>` +
    `<span class="kind">${escape(s.kind)}</span>` +
    `<span class="state${storied(s) ? " signed" : ""}">${escape(stateOf(s))}</span>` +
    `<span class="when">${escape(touched(s.updated_at, now))}</span>` +
    `<span class="row-acts"><a href="?${PARAM}=${s.id}">open</a></span></li>`
  );
}

/** The head of the list, which is the columns named. A row of words and not a `<thead>`:
 *  the list is a list, and the grid the look declares is what lines the columns up. */
const head = (): string =>
  `<li class="head"><span></span><span>id</span><span>name</span>` +
  `<span>kind</span><span>state</span><span>touched</span><span></span></li>`;

/** The bar above the list: what the ticks add up to, the two acts, and the one sentence
 *  saying why there is no third. Disabled to start with, because nothing is picked yet and
 *  a control that acts on nothing is a control that does nothing. `Remove` wears the plain
 *  button: the mock draws it in a red the signed palette does not hold. */
function bar(ui: Ui): string {
  const buttons = ui.acts.map(
    (a) =>
      `<button type="button" class="${a.kind}" data-ui="${a.id}" data-act="${a.name}" ` +
      `data-lead="${escape(a.lead)}" data-joins="${escape(a.joins)}" disabled>` +
      `${escape(a.says)}</button>`,
  );
  return (
    `<div class="bar" data-ui="${BAR}">` +
    `<span class="picked" data-ui="${ui.pickedId}">${escape(ui.none)}</span>` +
    buttons.join("") +
    `<span class="hint">${escape(ui.hint)}</span></div>`
  );
}

/** The script that makes the bar act, and it is the only thing on this surface a page runs
 *  in a browser. It is here rather than in `browser/dock.ts` because it is this page's and
 *  no other's — the dock's half is in every document, and a page's is in one. A module, so
 *  it is deferred: it reaches for the dock's own control, drawn after the page.
 *
 *  It composes out of the clauses the markup already carries, so no sentence is written
 *  here. The shell is opened before the frame goes up, because a frame posted at a shell
 *  nobody has started is refused; the dock is opened after, because words typed on a screen
 *  nobody is looking at are words nobody can edit. */
const script = (ui: Ui): string =>
  `<script type="module">
const AT = ${JSON.stringify(SHELL_AT)};
const frame = ${FRAMES};
const rows = [...window.document.querySelectorAll('[data-ui="${ITEM}"]')];
const acts = [...window.document.querySelectorAll('[data-ui="${BAR}"] [data-act]')];
const count = window.document.querySelector('[data-ui="${ui.pickedId}"]');
const picked = () => rows.filter((li) => li.querySelector("input").checked);
const shown = () => {
  const n = picked().length;
  count.textContent = n === 0 ? ${JSON.stringify(ui.none)} : n + " " + ${JSON.stringify(ui.picked)};
  for (const act of acts) act.disabled = n === 0;
};
for (const li of rows) li.querySelector("input").addEventListener("change", shown);
shown();
for (const act of acts) {
  act.addEventListener("click", async () => {
    const said = picked().map((li) => JSON.parse(li.dataset.words)[act.dataset.act]);
    if (said.length === 0) return;
    await window.fetch(AT + "?from=0");
    await window.fetch(AT, { method: "POST", body: frame(act.dataset.lead + said.join(act.dataset.joins)) });
    if (!window.document.documentElement.classList.contains(${JSON.stringify(DOCKED)})) {
      window.document.querySelector(${JSON.stringify(CONTROLS.open)}).click();
    }
  });
}
</script>`;

/** The list, whole: the bar, the columns, a row each. */
function listing(all: readonly Sketch[], ui: Ui, now: number): string {
  if (all.length === 0) return `<p class="empty">${NOTHING_DRAWN}</p>`;
  return (
    bar(ui) +
    `<ul class="sketches" data-ui="${LIST}">` +
    head() +
    all.map((s) => row(s, ui.acts, now)).join("") +
    `</ul>` +
    script(ui)
  );
}

// ─── the one that is open ───────────────────────────────────────────────────────────

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

/** The drawing at full width, in a frame.
 *
 *  `srcdoc` rather than a route of its own: the document is handed over whole, so the board
 *  serves no second path that answers with a file off the operator's disk, and the dock's
 *  own script — which is added to every html reply this surface makes — is not injected
 *  into somebody's sketch. Sandboxed without `allow-same-origin`, so a drawing's own script
 *  runs (a sketch of a surface is often a working one) in an origin of its own and cannot
 *  reach the board around it. */
const frame = (s: Sketch): string => {
  const drawn = drawingAt(s.html);
  if (drawn === null) {
    return `<p class="gone" data-ui="sketches.open.drawing">${escape(noDrawing(s.html))}</p>`;
  }
  return (
    `<iframe class="drawing" data-ui="sketches.open.drawing" sandbox="allow-scripts" ` +
    `title="${escape(s.name)}" srcdoc="${escape(drawn)}"></iframe>`
  );
};

/** The one sketch, and the way back to the list above it. */
function drawing(s: Sketch, now: number): string {
  return (
    `<div class="open" id="open-${s.id}" data-ui="sketches.open">` +
    `<p class="back"><a href="?" data-ui="sketches.open.back">← every sketch</a></p>` +
    `<h3><span class="id">#${s.id}</span>${escape(s.name)}</h3>` +
    `<p class="says">${escape(s.says)}</p>` +
    `<p class="meta"><span class="kind">${escape(s.kind)}</span>` +
    `<span class="state${storied(s) ? " signed" : ""}">${escape(stateOf(s))}</span>` +
    `<span class="when">${escape(touched(s.updated_at, now))}</span>` +
    `<span class="mono">${escape(s.html)}</span></p>` +
    frame(s) +
    `</div>`
  );
}

/** The way back with nothing to go back from: a target that named a sketch the record has
 *  not got still gets the link, because it is the one thing a reader wants next. */
const stale = (id: number): string =>
  `<div class="open" data-ui="sketches.open">` +
  `<p class="back"><a href="?" data-ui="sketches.open.back">← every sketch</a></p>` +
  `<p class="empty">${escape(nothingAt(id))}</p></div>`;

// ─── the page ───────────────────────────────────────────────────────────────────────

/** What the page says: its name, the line under it, and then either the list or the one
 *  drawing. The frame around it is the shell's. */
export function sketchesList(all: readonly Sketch[], url: URL, ui = loadUi(), now = Date.now()): string {
  const one = opened(all, url);
  const body =
    one === null ? listing(all, ui, now) : typeof one === "number" ? stale(one) : drawing(one, now);
  return (
    `<section class="${SECTION}" data-ui="${SECTION}"><h2>Sketches</h2>` +
    `<p class="q">Anything drawn before it is work. Yours alone until one earns a story.</p>` +
    body +
    `</section>`
  );
}

/** The whole document: the list, in the shell design.yaml declares. */
export function sketchesPage(all: readonly Sketch[], url: URL): Reply {
  return html(document(sketchesList(all, url)));
}

/** The page, bound to a way of reading the record now. Read fresh on every request, for the
 *  reason the board is: an agent draws while somebody is looking at the list. */
export const sketchesAt = (all: () => readonly Sketch[], ui: Ui = loadUi()): Page =>
  shelled((url) => sketchesList(all(), url, ui));
