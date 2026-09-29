/** Everything drawn before it was work, as a list — and the way into the one a reader
 *  opened.
 *
 *  A sketch is a record of a drawing: `core`'s `sketch` table holds the name, the kind, the
 *  line it says of itself, the story it became if it became one, and the path of the html.
 *  The drawing itself is a file an agent wrote, which is the whole design — a picture kept
 *  in a column would need a verb to fetch it out and a diff nobody could read.
 *
 *  So this page is a list you scan and then one drawing you look at, and which of the two it
 *  is, is in the target: `/sketches` is the list and `/sketches?open=112` is the drawing, the
 *  way `/tasks?task=8` picks a task. A selection held in a script would be a selection
 *  nobody can link to, bookmark or reload into. The drawing itself, the two ways of looking
 *  at one, and the route the second of them is served from are `../drawing.ts`'s: a list is
 *  what this file is, and what a frame may reach is not a list's decision.
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
 *  Every element carries the `data-ui` name `config/ui.yaml` declares it under, so the drawn
 *  surface and the declaration can be held against one another by name rather than by eye. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Sketch } from "@wecode/core";
import { encode } from "@wecode/painter/dist/client/terminal.js";
import { DROP_AT, REMOVED } from "../drop.js";
import {
  linkTo, modeOf, openedSketch, opened, PARAM, stale, stateOf, storied, touched, VIEW, waysIn,
} from "../drawing.js";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { CONTROLS, documentAt, DOCKED, shelled, SHELL_AT } from "./shell.js";

/** What a reader opens a sketch with, offered here as well because it is this page's
 *  vocabulary and a caller of the page should not have to know which half of it holds
 *  which word. */
export { opened, PARAM, stateOf, touched };

/** The reading this page is served from. Not the record: a sketch hangs under nothing and
 *  is in no tree, so `tree()`'s nodes carry none of it. */
export const READS = "sketches";

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
  /** Where this act posts, for the one that is a verb rather than a sentence. An act with
   *  this is a submit button in the list's own form; an act without it types at the dock. */
  readonly posts?: string;
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
    lead: said["posts"] === undefined ? wordOf(said["lead"], `${at}.lead`, path) : "",
    row: said["posts"] === undefined ? wordOf(said["row"], `${at}.row`, path) : "",
    joins: said["posts"] === undefined ? wordOf(said["joins"], `${at}.joins`, path) : "",
    ...(said["posts"] === undefined ? {} : { posts: wordOf(said["posts"], `${at}.posts`, path) }),
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

/** How many rows the verb just removed, as the target spells it. Read off the address so
 *  the notice survives a reload and is the same page however a reader arrived at it. */
export const removedIn = (url: URL): number | null => {
  const said = url.searchParams.get(REMOVED);
  if (said === null) return null;
  const n = Number(said);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** What a person is told when rows went, and how to be rid of the notice. */
const SAYS_REMOVED = (n: number): string =>
  n === 1 ? "one sketch removed — the drawing is still on disk" : `${n} sketches removed — the drawings are still on disk`;
const SAYS_DISMISS = "dismiss";

const removed = (n: number): string =>
  `<p class="removed" data-ui="sketches.removed">${SAYS_REMOVED(n)}` +
  `<a href="?" data-ui="sketches.removed.dismiss">${SAYS_DISMISS}</a></p>`;

/** What the page says when the record holds no sketch at all. Most days there are none,
 *  and a page that came back blank reads as a page that failed. */
const NOTHING_DRAWN = "nothing drawn yet — a sketch is drawn by the orchestrator";

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
  escape(JSON.stringify(Object.fromEntries(
    acts.filter((a) => a.posts === undefined).map((a) => [a.name, clauseOf(a, s)]),
  )));

/** One sketch: a row and not a card, because this is a list you scan. The tick leads
 *  because it is what the bar acts on; the name carries what the sketch says of itself
 *  under it, cut to two lines by the look rather than here, so the row keeps the record's
 *  own words and a long line costs the list no height.
 *
 *  It ends in both ways in rather than in one `open`, because there are two things a reader
 *  does with a drawing and the row is where they choose: a word that meant "whichever of the
 *  two the page decides" would be a choice taken off them. The name goes on leading to the
 *  cheaper of the two, which is looking at it. */
function row(s: Sketch, acts: readonly Act[], now: number): string {
  return (
    `<li id="sketch-${s.id}" data-ui="${ITEM}" data-words="${wordsOf(acts, s)}">` +
    `<input type="checkbox" name="id" value="${s.id}" aria-label="pick #${s.id}">` +
    `<span class="id">#${s.id}</span>` +
    `<span class="name"><a href="${linkTo(s.id, VIEW)}">${escape(s.name)}</a>` +
    `<span class="says">${escape(s.says)}</span></span>` +
    `<span class="kind">${escape(s.kind)}</span>` +
    `<span class="state${storied(s) ? " signed" : ""}">${escape(stateOf(s))}</span>` +
    `<span class="when">${escape(touched(s.updated_at, now))}</span>` +
    `${waysIn(s.id)}</li>`
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
  const buttons = ui.acts.map((a) =>
    a.posts === undefined
      ? `<button type="button" class="${a.kind}" data-ui="${a.id}" data-act="${a.name}" ` +
        `data-lead="${escape(a.lead)}" data-joins="${escape(a.joins)}" disabled>` +
        `${escape(a.says)}</button>`
      // A submit, so removing what is ticked needs no script at all: the form carries one
      // `id` per tick and the verb answers with the list again.
      : `<button type="submit" class="${a.kind}" data-ui="${a.id}" data-act="${a.name}" ` +
        `formaction="${a.posts}" formmethod="post" disabled>${escape(a.says)}</button>`,
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
// Only the acts that type at the dock. The one that posts is a submit the browser handles,
// and wiring it here sent the shell the word "undefined" alongside the real removal.
const acts = [...window.document.querySelectorAll('[data-ui="${BAR}"] [data-act]')]
  .filter((b) => b.getAttribute("formaction") === null);
const submits = [...window.document.querySelectorAll('[data-ui="${BAR}"] [formaction]')];
const count = window.document.querySelector('[data-ui="${ui.pickedId}"]');
const picked = () => rows.filter((li) => li.querySelector("input").checked);
const shown = () => {
  const n = picked().length;
  count.textContent = n === 0 ? ${JSON.stringify(ui.none)} : n + " " + ${JSON.stringify(ui.picked)};
  for (const act of [...acts, ...submits]) act.disabled = n === 0;
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
  // A form around the whole list: the ticks are its fields, so the act that removes needs
  // no script and works with several rows at once. `method=get` is never used — the one
  // act that submits carries its own `formmethod=post` — but a form needs an action, and
  // the page itself is the honest one for a submit that never happens.
  return (
    `<form action="?" method="get" data-ui="sketches.form">` +
    bar(ui) +
    `<ul class="sketches" data-ui="${LIST}">` +
    head() +
    all.map((s) => row(s, ui.acts, now)).join("") +
    `</ul>` +
    `</form>` +
    script(ui)
  );
}

// ─── the page ───────────────────────────────────────────────────────────────────────

/** What the page says: its name, the line under it, and then either the list or the one
 *  drawing. The frame around it is the shell's, and the drawing inside it is
 *  `../drawing.ts`'s — including which of its two frames this reader asked for, which is in
 *  the target beside the sketch's own id. */
export function sketchesList(all: readonly Sketch[], url: URL, ui = loadUi(), now = Date.now()): string {
  const one = opened(all, url);
  // Only on the list: a notice about rows that went belongs beside the rows, and a reader
  // who has opened one drawing is not looking at the list.
  const note = one === null ? removedIn(url) : null;
  const body =
    (note === null ? "" : removed(note)) +
    (one === null
      ? listing(all, ui, now)
      : typeof one === "number"
        ? stale(one)
        : openedSketch(one, modeOf(url), now));
  return (
    `<section class="${SECTION}" data-ui="${SECTION}"><h2>Sketches</h2>` +
    `<p class="q">Anything drawn before it is work. Yours alone until one earns a story.</p>` +
    body +
    `</section>`
  );
}

/** The whole document: the list, in the shell design.yaml declares, drawn at the target so the
 *  banner lights this page's name — as it does over a socket. */
export function sketchesPage(all: readonly Sketch[], url: URL): Reply {
  return html(documentAt(sketchesList(all, url), url.pathname));
}

/** The page, bound to a way of reading the record now. Read fresh on every request, for the
 *  reason the board is: an agent draws while somebody is looking at the list. */
export const sketchesAt = (all: () => readonly Sketch[], ui: Ui = loadUi()): Page =>
  shelled((url) => sketchesList(all(), url, ui));
