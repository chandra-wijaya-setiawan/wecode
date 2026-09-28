/** The record as a tree: the levels of work, and under each story the proof it was done.
 *
 *  The cockpit's outline and this page answer the same question — where a row sits in the
 *  work — so they are drawn from the same design. `shared.outline` in
 *  `packages/tui/config/design.yaml` says which levels a tree shows, which it folds and
 *  what a row of it says; none of that is decided here, and a second opinion about how deep
 *  a tree goes is two trees.
 *
 *  The ledger is nine levels deep. Five are work and four — a requirement, its criteria,
 *  the tests that accept it and the tests a task is proven by — are the proof that a story
 *  was done rather than work being done. Drawn as rows they outnumber the work, which is
 *  why the terminal's outline sends them to a record's own page: a box twenty rows tall
 *  cannot spend twelve of them on one story's paperwork. A page in a browser can, because a
 *  row inside a shut fold costs the reader nothing until they open it. So `levels.web` in
 *  the design names the four as levels this tree shows, and they arrive shut: the page
 *  lands at story level, and the proof of a story is under the story that it proves.
 *
 *  A parent is a disclosure, the way a comment thread's is: the reader closes a branch they
 *  are not reading and opens it again later, and the browser keeps the marker and the
 *  keyboard for us. A branch of work arrives open — a tree that hides work by default is a
 *  tree nobody trusts — a branch of proof arrives shut, and a leaf gets none, because there
 *  is nothing to disclose. Approval 1561 settled that this surface may carry controls; a
 *  disclosure is the mildest of them, and it changes nothing in wecode, only what this
 *  reader is looking at.
 *
 *  What the reader is offered around the tree — the one select that narrows it, the states
 *  it narrows by, and how much of a record's own text a row spends before the rest goes
 *  behind a fold — is `packages/webapp/config/ui.yaml`'s. A word or a number written here
 *  instead would be a decision about the surface that nobody can read off a file.
 *
 *  The nodes arrive as nodes, not as a database, for the reason the board's do: where a
 *  workspace is, is `bin.ts`'s.
 *
 *  How deep a row sits is drawn the way a commit graph draws it: the first column of every
 *  row is the swimlanes beside it, as one `<svg>` `rail.ts` makes. The line leaves a parent's node going
 *  right, turns down, and becomes the lane its children are threaded on, so a child is a node
 *  on a line rather than a stub off a phantom vertical. That file draws one row at a time and
 *  keeps no memory between rows, so where a row sits is this walk's to say: its depth, which
 *  ancestors' lanes still have a row to come, whether it is the last row on its own lane,
 *  whether anything above feeds that lane, and whether anything hangs under it.
 *
 *  What is left of that rule — how the rail and the row sit beside each other — is, like
 *  every other rule of this surface, the shell's: one stylesheet, selected on the markup this
 *  file writes. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Node } from "@wecode/core";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { rail } from "../rail.js";
import { documentAt, shelled } from "./shell.js";

/** Where the two files are and what reads them. The design and the parser are resolved
 *  through `@wecode/tui`, which owns both the file and the `yaml` dependency that parses it
 *  — `shell.ts` does the same thing for the same reason; see the note there about
 *  `import.meta.resolve`. The declaration is this package's own, beside its `src`, so it is
 *  found the same way from the source tree and from `dist`. */
const here = createRequire(fileURLToPath(import.meta.url));
const DESIGN = here.resolve("@wecode/tui/config/design.yaml");
const UI = fileURLToPath(new URL("../../config/ui.yaml", import.meta.url));
const { parse } = createRequire(here.resolve("@wecode/tui"))("yaml") as {
  parse: (text: string) => unknown;
};

export class TreeDesignError extends Error {}

/** How far down the tree goes, as the design says it. */
export interface Levels {
  /** The entities drawn open, outermost first. */
  readonly shows: readonly string[];
  /** The entities the terminal passes through — their children rise to the nearest shown
   *  ancestor there. On the web they are drawn, so this list is what `folds` overrides. */
  readonly omits: readonly string[];
  /** The entities this tree draws inside a disclosure that arrives shut. */
  readonly folds: readonly string[];
}

const mapOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const namesOf = (v: unknown, what: string, path: string): readonly string[] => {
  const said = Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === "string");
  if (!said) throw new TreeDesignError(`${path}: outline.levels declares no ${what}`);
  return v as readonly string[];
};

/** The levels `shared.outline.levels` declares. A design that does not say is a refusal and
 *  never a default: a tree cut to a depth nothing declared is a tree nothing gates. */
export function loadLevels(path: string = DESIGN): Levels {
  const outline = mapOf(mapOf(mapOf(parse(readFileSync(path, "utf8")))["shared"])["outline"]);
  const levels = mapOf(outline["levels"]);
  const web = mapOf(levels["web"]);
  // The web block wins where it speaks. `shared.outline.levels` is the cockpit's and this
  // renderer's both, and the two cannot want the same rungs: a fixed box needs the whole
  // shape, a page is opened to work one story. A key the web block leaves out is not an
  // override, so the shared list still answers for it.
  return {
    shows: namesOf(web["shows"] ?? levels["shows"], "shows", path),
    omits: namesOf(web["omits"] ?? levels["omits"], "omits", path),
    folds: namesOf(web["folds"], "web.folds", path),
  };
}

export class TreeUiError extends Error {}

/** One answer the filter offers: the name it is drawn under, the value it puts on the
 *  query, the word the reader is offered, and the states it leaves out. */
export interface Option {
  readonly id: string;
  readonly value: string;
  readonly says: string;
  readonly excludes: readonly string[];
}

/** The filter, which is one select: the word beside it, the query parameter the choice
 *  travels in, which answer is the arriving one, the answers themselves, and the word on the
 *  control that sends the chosen one — a select goes nowhere until something submits it. */
export interface Filter {
  readonly id: string;
  readonly says: string;
  readonly param: string;
  readonly default: string;
  readonly submit: string;
  readonly submitId: string;
  readonly options: readonly Option[];
}

/** Everything about this page that `ui.yaml` declares. */
export interface Ui {
  readonly filter: Filter;
  /** What a row calls each level, by the record's own name for it. A level this map does not
   *  name is drawn by that name itself — see the note in `ui.yaml`. */
  readonly kinds: Readonly<Record<string, string>>;
}

const wordOf = (v: unknown, at: string, path: string): string => {
  if (typeof v !== "string" || v === "") throw new TreeUiError(`${path}: ${at} says nothing`);
  return v;
};

/** A list of state names. Empty is an answer here — the option that narrows nothing says so
 *  with an empty list — but a missing list is not. */
const statesOf = (v: unknown, at: string, path: string): readonly string[] => {
  const said = Array.isArray(v) && v.every((e) => typeof e === "string");
  if (!said) throw new TreeUiError(`${path}: ${at} names no states`);
  return v as readonly string[];
};

function optionOf(v: unknown, n: number, path: string): Option {
  const said = mapOf(v);
  const at = `tree.filter.options[${n}]`;
  return {
    id: wordOf(said["id"], `${at}.id`, path),
    value: wordOf(said["value"], `${at}.value`, path),
    says: wordOf(said["says"], `${at}.says`, path),
    excludes: statesOf(said["excludes"], `${at}.excludes`, path),
  };
}

/** What `ui.yaml` declares for this page. A field the declaration does not hold is a
 *  refusal and never a default, for the reason the design's fields are: a word this file
 *  supplied when the file was silent is a word nobody signed. */
export function loadUi(path: string = UI): Ui {
  const tree = mapOf(mapOf(parse(readFileSync(path, "utf8")))["tree"]);
  const filter = mapOf(tree["filter"]);
  const said = filter["options"];
  if (!Array.isArray(said) || said.length === 0) {
    throw new TreeUiError(`${path}: tree.filter offers no options`);
  }
  const submit = mapOf(filter["submit"]);
  const kinds = mapOf(tree["kinds"]);
  if (Object.keys(kinds).length === 0) throw new TreeUiError(`${path}: tree.kinds names no level`);
  for (const [level, word] of Object.entries(kinds)) wordOf(word, `tree.kinds.${level}`, path);
  return {
    filter: {
      id: wordOf(filter["id"], "tree.filter.id", path),
      says: wordOf(filter["says"], "tree.filter.says", path),
      param: wordOf(filter["param"], "tree.filter.param", path),
      default: wordOf(filter["default"], "tree.filter.default", path),
      submit: wordOf(submit["says"], "tree.filter.submit.says", path),
      submitId: wordOf(submit["id"], "tree.filter.submit.id", path),
      options: said.map((o, n) => optionOf(o, n, path)),
    },
    kinds: kinds as Readonly<Record<string, string>>,
  };
}

/** What the page says when the record is empty. A page that came back blank reads as a page
 *  that failed. */
const NOTHING_YET = "nothing in the record yet";

/** What the page says when the filter is on and nothing is left under it. Distinct from
 *  `NOTHING_YET`: a record with nothing in it and a record narrowed to nothing are two
 *  different things to have done, and one sentence for both sends the reader to the wrong
 *  place. */
const NOTHING_MATCHES = "nothing in the record matches this filter";

/** The query of a reader who asked for nothing in particular. Only a base is needed: what
 *  is read off it is the search, and where the surface is deployed is nobody's here. */
const NOWHERE = new URL("http://localhost/tree");

/** The parts of a row, in the order sketch #7 draws them. They are columns and not a
 *  sentence: the kind and the id are narrow and fixed, the record's own words take what is
 *  left, and the state ends the row at the right-hand edge. A reader scans a column; a
 *  sentence has to be read. Which is why nothing joins them — the separator that used to
 *  was what made four columns one line of prose, and with it gone the rails, the kinds, the
 *  ids and the states each line up down the page however deep the row sits. */

/** The names `packages/webapp/config/ui.yaml` declares this page's parts by, carried into
 *  the markup as `data-ui` so the drawing and the declaration are checkable against each
 *  other by name rather than by eye. */
const SECTION = "tree";
const NODE = "tree.node";
const SAYS_SECTION = "Tree";

/** One row: the rail beside it, what kind of record it is, its number, its own words, and
 *  the state it is in. Everything in it is a person's own words, so nothing reaches the
 *  document without coming through `escape`.
 *
 *  The rail is the row's first column rather than the `<li>`'s first child. Outside the row
 *  it had to be paid for twice — once as the drawing's own width, once as a negative margin
 *  pulling the children back out from under it — and the two never quite cancelled, so no
 *  two rows' text began at the same place. As a column of the same grid every row declares,
 *  depth is drawn by the rail and by nothing else, and every row's words start on one line
 *  down the page. It is `aria-hidden`, so it adds nothing to the name of the control it now
 *  sits inside.
 *
 *  The row ends at the state, and the trailing column is that state alone. What used to
 *  trail it was the rollup — how many done, open and failed hang under the row — and it was
 *  a second answer to a question the tree already answers by being a tree: the rows it
 *  counted are the rows underneath, and a reader who wants them opens the branch. It was
 *  also the widest thing after the state and a number nobody can follow anywhere, so a
 *  reader scanning the column that says how a row is going read past it every time.
 *
 *  The state carries its own hue in, as one custom property the sheet spends. Which hue a
 *  state wears is the look's — see `hueOf` — and a rule per state in the sheet would be
 *  thirteen ways of saying the one thing this line says once. `style` leads the span so the
 *  row still ends `class="state">...</span>`, which is what says the state is last. */
function row(node: Node, kind: string, drawn: string): string {
  return (
    `${drawn}<span class="kind">${escape(kind)}</span>` +
    `<span class="id">#${node.id}</span>` +
    `<span class="label" title="${escape(node.label)}">${escape(node.label)}</span>` +
    `<span style="--hue:${escape(hueOf(node.state))}" class="state">${escape(node.state)}</span>`
  );
}

/** The tree the design draws, out of the tree the record keeps: a node of a level this
 *  renderer shows or folds keeps its place, and a node of any other level gives its children
 *  to whoever was above it. A level the design names in none of the lists is a level nothing
 *  decided about, so it is kept — a row silently dropped is worse than a row nobody meant to
 *  draw. */
export function shown(nodes: readonly Node[], levels: Levels = loadLevels()): readonly Node[] {
  return nodes.flatMap((n) => {
    const kids = shown(n.children, levels);
    const drawn = levels.shows.includes(n.entity) || levels.folds.includes(n.entity);
    if (levels.omits.includes(n.entity) && !drawn) return kids;
    return [{ ...n, children: kids }];
  });
}

/** Where a row sits, as the rail beside it needs it told. `live` is the ancestors whose lanes
 *  still have a row to come, by the lane each is on — an ancestor that was the last of its
 *  siblings has nothing below it, so its lane is not carried past here. `first` is true of one
 *  row in the page: the first root, whose lane nothing above it begins. */
interface At {
  readonly depth: number;
  readonly live: readonly number[];
  readonly last: boolean;
  readonly first: boolean;
}

/** The hue the node wears, as a token named after the state the row is in. Which hue that is
 *  belongs to the look and not to a page, so what is decided here is only that a node is
 *  coloured by its state; a state the sheet says nothing about takes the colour of the text
 *  beside it rather than drawing as a hole. */
const hueOf = (state: string): string => `var(--st-${state}, currentColor)`;

/** The lanes a row's children are drawn among: one in from this row, carrying whatever this
 *  row carried, and this row's own lane too unless this row ended it. */
const under = (at: At, of: readonly Node[], i: number): At => ({
  depth: at.depth + 1,
  live: at.last ? at.live : [...at.live, at.depth],
  last: i === of.length - 1,
  first: false,
});

/** One row and whatever hangs under it. A parent's row goes in the `<summary>` of a
 *  `<details>`, so the whole branch closes and opens on that row; a leaf is the row alone.
 *
 *  A record's own words are drawn whole and cut by the sheet at the width the reader's window
 *  actually is, and carried whole in `title` for the reader who wants the rest of a cut one
 *  without leaving the page. What was here instead was a budget of lines counted against a
 *  declared width, with the remainder behind a fold — three decisions this page had to make
 *  about a window it cannot measure, and the fold cost a second line on nearly half the rows,
 *  which is what broke the rail: the drawing is 22px tall a row, so a row that is 44 leaves a
 *  gap and the lanes read as broken pipe.
 *
 *  A leaf's row is a `<div>` and a parent's is the `<summary>`, and both wear the same
 *  class: the row is one shape whether or not it opens, and the sheet says that shape once.
 *  Every row is one line, whatever the record wrote: a row is where a thing sits in the
 *  work, and a paragraph drawn in one is a row whose rail no longer reaches it.
 *
 *  A branch arrives shut once the proof begins — the row is of a folded level, or what it
 *  holds is — and every branch above that arrives open, so the page lands at the last level
 *  of work. The rest of a long record's text is its own disclosure, and it sits after the
 *  row rather than inside the `<summary>`: a disclosure nested in a summary is one the
 *  reader cannot press without pressing the other. */
function branch(node: Node, levels: Levels, kinds: Ui["kinds"], at: At): string {
  const kids = node.children;
  const drawn = rail({ ...at, children: kids.length > 0, fill: hueOf(node.state) });
  const open = `<li id="${escape(node.entity)}-${node.id}" data-ui="${NODE}">`;
  const drawnRow = row(node, kinds[node.entity] ?? node.entity, drawn);
  if (kids.length === 0) return `${open}<div class="row">${drawnRow}</div></li>`;
  const proof = (n: Node): boolean => levels.folds.includes(n.entity);
  const shut = proof(node) || kids.some(proof);
  return (
    `${open}<details${shut ? "" : " open"}><summary class="row">${drawnRow}</summary>` +
    `<ul>${kids.map((k, i) => branch(k, levels, kinds, under(at, kids, i))).join("")}</ul>` +
    `</details></li>`
  );
}

/** What the page says: the tree, and nothing around it. The frame is the shell's. */
export function treeBranches(nodes: readonly Node[], levels?: Levels, ui: Ui = loadUi()): string {
  const said = levels ?? loadLevels();
  const roots = shown(nodes, said);
  if (roots.length === 0) return `<p class="empty">${NOTHING_YET}</p>`;
  // The roots are the outermost lane, and the first of them is the one row of the page with
  // nothing above it: its lane starts at its own node rather than at the top of the row.
  const top = (i: number): At =>
    ({ depth: 0, live: [], last: i === roots.length - 1, first: i === 0 });
  return `<ul class="tree">${roots.map((n, i) => branch(n, said, ui.kinds, top(i))).join("")}</ul>`;
}

/** The answer the query is holding. An answer the declaration does not offer is not an
 *  answer, and neither is an absent one: both are the arriving reading, which is what makes
 *  `/tree` and the default option's own link the same page. */
export function chosen(url: URL, filter: Filter): Option {
  const by = (value: string | null): Option | undefined =>
    filter.options.find((o) => o.value === value);
  return (by(url.searchParams.get(filter.param)) ?? by(filter.default) ?? filter.options[0]) as Option;
}

/** The record as the query asks for it. The chosen answer leaves out every row whose state
 *  it excludes — and keeps a row it would have left out when a kept row hangs under it,
 *  because a row shown without the rows it hangs under is a row nobody can place. */
export function narrowed(nodes: readonly Node[], url: URL, ui: Ui = loadUi()): readonly Node[] {
  const { excludes } = chosen(url, ui.filter);
  if (excludes.length === 0) return nodes;
  const kept = (node: Node): Node | null => {
    const children = node.children.map(kept).filter((k): k is Node => k !== null);
    const left = excludes.includes(node.state);
    return !left || children.length > 0 ? { ...node, children } : null;
  };
  return nodes.map(kept).filter((n): n is Node => n !== null);
}

/** Everything else the reader arrived with, kept across a submission. A `get` form replaces
 *  the whole query with its own fields, so a parameter nobody wrote a field for is a
 *  parameter narrowing the tree silently threw away. The filter's own is left out: the
 *  select is the field for that one. */
const carried = (url: URL, filter: Filter): string =>
  [...url.searchParams]
    .filter(([name]) => name !== filter.param)
    .map(([n, v]) => `<input type="hidden" name="${escape(n)}" value="${escape(v)}">`)
    .join("");

/** The filter: the word the declaration gives it, one select holding its answers, and the
 *  control that sends the one picked.
 *
 *  It is a `method="get"` form, which is the whole mechanism. A select does not navigate on
 *  its own, and what would make it — a handler on its change — is script; this page has
 *  none, so the reader presses the submit and the browser puts the answer on the query
 *  itself. Nothing here needs JavaScript to work, and what the form arrives at is an address
 *  the reader could have typed: narrowing stays a reading a person can send and bookmark.
 *
 *  A `get` form is still a reading and not a verb. Every verb that changes wecode is the
 *  cli's; this one changes the query string and nothing else — which is why `action` is the
 *  page's own path and the rest of the query rides along as hidden fields rather than being
 *  thrown away, a `get` submission replacing the whole query with its own.
 *
 *  The label wraps the select, so the word is what the control is named by rather than a
 *  sentence that happens to sit beside it, and the held answer is `selected`: the page says
 *  what it is narrowed to without being opened. */
function filterRow(url: URL, filter: Filter): string {
  const on = chosen(url, filter);
  const drawn = filter.options
    .map((o) => `<option value="${escape(o.value)}" data-ui="${o.id}"` +
      `${o === on ? " selected" : ""}>${escape(o.says)}</option>`)
    .join("");
  return (
    `<form class="filter" method="get" action="${escape(url.pathname)}" data-ui="${filter.id}">` +
    `${carried(url, filter)}<label>${escape(filter.says)}` +
    `<select name="${escape(filter.param)}">${drawn}</select></label>` +
    `<button type="submit" data-ui="${filter.submitId}">${escape(filter.submit)}</button></form>`
  );
}

/** The whole page: the section the declaration names, the filter, and the tree under
 *  whatever the query left of the record. */
export function treeSection(nodes: readonly Node[], url: URL, levels?: Levels, ui?: Ui): string {
  const said = ui ?? loadUi();
  const roots = narrowed(nodes, url, said);
  const narrowedToNothing = roots.length === 0 && nodes.length > 0;
  const body = narrowedToNothing ? `<p class="empty">${NOTHING_MATCHES}</p>`
    : treeBranches(roots, levels, said);
  return (
    `<section class="tree" data-ui="${SECTION}"><h2>${SAYS_SECTION}</h2>` +
    `${filterRow(url, said.filter)}${body}</section>`
  );
}

/** The whole document: the tree page, drawn at the target, in the shell design.yaml says. */
export function treePage(ns: readonly Node[], url = NOWHERE, levels?: Levels, ui?: Ui): Reply {
  return html(documentAt(treeSection(ns, url, levels, ui), url.pathname));
}

/** This page declares no `READS`: the record is what a page reads unless it says otherwise,
 *  and the record is exactly what a tree is. See `discover.ts`.
 *
 *  The page, bound to a way of reading the record now. Read fresh on every request, for the
 *  reason the board is: work moves without anybody reloading. */
export const treeAt = (nodes: () => readonly Node[], levels?: Levels, ui?: Ui): Page =>
  shelled((url) => treeSection(nodes(), url, levels, ui));
