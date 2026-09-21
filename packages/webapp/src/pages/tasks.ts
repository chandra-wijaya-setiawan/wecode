/** Every task in one list, and the one a reader picked in full beside it.
 *
 *  The board answers *what is moving*; the tree answers *where a row sits*. Neither answers
 *  *what is this task* — a task's row on the board is a line, and a line is enough to
 *  notice a task by and not enough to read one. So this page is an inbox: the whole list on
 *  the left because a reader who does not yet know which task they want has to see them
 *  all, and the selected task's detail on the right because a reader who does know wants it
 *  without leaving the list.
 *
 *  Which task is selected is in the target — `/tasks?task=8` — and not in a script. A
 *  selection held in the page would be a selection nobody can link to, bookmark or reload
 *  into, and `renderers.webapp` says this surface has no bars; a list of links is the
 *  browser's own way to pick one of many.
 *
 *  The tasks are read out of `tree()`'s nodes rather than out of a query of their own, for
 *  two reasons. A task's detail is mostly its place — which story it is work on, what
 *  proves it — and the record's shape is exactly what a node carries. And where a workspace
 *  is, is `bin.ts`'s: the nodes arrive as a function, as the board's rows and the tree's
 *  nodes do.
 *
 *  Every element the page draws carries the `data-ui` name the definition gives it, so the
 *  drawn surface and the declaration can be held against one another by name rather than by
 *  eye. The filter is a row of *links*: it narrows the list through the query string, which
 *  is the same place the selection lives, so a narrowed list is a link a person can send.
 *  A form or a button would be a verb, and `renderers.webapp` says this surface has none. */
import type { Node } from "@wecode/core";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { document, shelled } from "./shell.js";

/** Which task the reader picked, as the target spells it. One name, so a link built by the
 *  page and a link typed by a person are the same link. */
export const PARAM = "task";

/** The three axes the filter narrows on, each its own name in the target. Separate params
 *  rather than one, so a reader can hold a state and a project at once. */
export const FILTER = "filter";
export const PROJECT = "project";
export const SEAT = "seat";

/** A task, with the place the record keeps it in. The story is what a task is work on; the
 *  proofs are the task tests hung under it, each with the state it is in now. */
export interface Item {
  readonly id: number;
  readonly label: string;
  readonly state: string;
  /** The story this is work on, or null when the record hangs it under nothing. */
  readonly story: string | null;
  /** The project the whole of it sits under, or null when nothing above it is one. */
  readonly project: string | null;
  readonly proofs: readonly Node[];
}

/** One chip of the filter: the word it is offered under, and which task states it admits.
 *  An empty `admits` is every state — that is what `all` is.
 *
 *  The words are the reader's and the states are the machine's, and they are not the same
 *  vocabulary: `machines.yaml` puts a started task in `ready` and an unstarted one in
 *  `planned`, while a person reading the surface calls those *running* and *ready*. The
 *  mapping is here, once, rather than in the reader's head.
 *
 *  `done today` admits `done`. The record's node carries no time a task finished, so
 *  "today" cannot be read off it; narrowing to `done` is the truthful part of that chip
 *  and the rest waits on a reading that carries a finishing time. */
interface Chip {
  readonly id: string;
  readonly says: string;
  readonly admits: readonly string[];
}

export const CHIPS: readonly Chip[] = [
  { id: "all", says: "all", admits: [] },
  { id: "running", says: "running", admits: ["ready"] },
  { id: "ready", says: "ready", admits: ["planned"] },
  { id: "failed", says: "failed", admits: ["failed"] },
  { id: "done-today", says: "done today", admits: ["done"] },
];

/** What the filter says of an axis the record offers nothing to narrow on. The node is
 *  drawn either way — a declared node that vanishes when the record is thin is a node
 *  nobody can check — but it is drawn as a word and not as a link to an empty list. */
const NO_PROJECT = "no project in the record";
const NO_SEAT = "no seat in the record";

/** What the page says when the record holds no task at all. A page that came back blank
 *  reads as a page that failed. */
const NO_TASKS = "no task in the record yet";

/** What the detail says when the target names a task the record has not got. A reader who
 *  followed a stale link is told so, rather than shown the first task as though they had
 *  asked for it. */
const nothingAt = (id: number): string => `no task #${id} in the record`;


/** Every task the record holds, outermost first and in the record's own order, each
 *  carrying the story it hangs under.
 *
 *  A task is found wherever it sits: the ledger puts a requirement, a criterion and an
 *  acceptance test between a story and its tasks, and a task hung under another task's
 *  proof is still a task. What is *not* walked into is a task's own children — those are
 *  its proofs and belong in its detail, not as rows of the inbox. */
export function items(
  nodes: readonly Node[],
  story: string | null = null,
  project: string | null = null,
): readonly Item[] {
  return nodes.flatMap((n) => {
    if (n.entity === "task") {
      return [{ id: n.id, label: n.label, state: n.state, story, project, proofs: n.children }];
    }
    return items(
      n.children,
      n.entity === "story" ? n.label : story,
      n.entity === "project" ? n.label : project,
    );
  });
}

/** The tasks the target's filter admits, in the record's own order. Every axis narrows, so
 *  a state and a project together are both, and an axis the target does not name narrows
 *  nothing. A `filter` the chips do not offer admits everything rather than nothing: a
 *  typed target should show the list, not an empty column. */
export function admitted(all: readonly Item[], url: URL): readonly Item[] {
  const chip = CHIPS.find((c) => c.id === url.searchParams.get(FILTER));
  const project = url.searchParams.get(PROJECT);
  return all.filter(
    (t) =>
      (chip === undefined || chip.admits.length === 0 || chip.admits.includes(t.state)) &&
      (project === null || t.project === project),
  );
}

/** Which task the reader is looking at: the one the target names, else the first in the
 *  list. A list with nothing selected would make the commonest arrival — `/tasks`, typed —
 *  the one that shows nothing. */
export function picked(all: readonly Item[], url: URL): Item | number | null {
  const said = url.searchParams.get(PARAM);
  if (said === null) return all[0] ?? null;
  const id = Number(said);
  if (!Number.isInteger(id)) return null;
  return all.find((t) => t.id === id) ?? id;
}

/** A target with some axes of the filter set over what the current one holds. The selection
 *  is dropped: a narrowed list may not hold the task that was picked, and a link that
 *  selects a task the list no longer shows is a link to a contradiction. */
const to = (url: URL, over: Readonly<Record<string, string | null>>): string => {
  const said = new URLSearchParams();
  for (const key of [FILTER, PROJECT, SEAT]) {
    const held = key in over ? over[key] : url.searchParams.get(key);
    if (held !== null && held !== undefined && held !== "") said.set(key, held);
  }
  const query = said.toString();
  return query === "" ? "?" : `?${query}`;
};

/** A target that picks a task without letting go of the filter the reader is holding. */
const selects = (url: URL, id: number): string => {
  const held = to(url, {});
  return held === "?" ? `?${PARAM}=${id}` : `${held}&${PARAM}=${id}`;
};

/** One chip. A link when it narrows to something, a word when there is nothing to narrow
 *  to — never a button: this surface takes no verbs. */
const tag = (id: string, says: string, href: string | null, on: boolean): string => {
  const name = ` data-ui="tasks.filter.${id}"`;
  if (href === null) return `<span class="tag none"${name}>${escape(says)}</span>`;
  return `<a class="tag${on ? " on" : ""}"${name} href="${href}">${escape(says)}</a>`;
};

/** Every project the record hangs a task under, once each and in the record's own order. */
const projectsOf = (all: readonly Item[]): readonly string[] => [
  ...new Set(all.map((t) => t.project).filter((p): p is string => p !== null)),
];

/** The filter: the five states the definition names, then one chip per project the record
 *  offers, then the seat.
 *
 *  Nothing the record carries names the seat a task was worked at — a node is an entity, a
 *  label and a state — so the seat chip is drawn as the word and narrows nothing. Making it
 *  narrow needs a reading of the seats in `bin.ts`, not a change here. */
function filter(all: readonly Item[], url: URL): string {
  const now = url.searchParams.get(FILTER) ?? "all";
  const states = CHIPS.map((c) =>
    tag(c.id, c.says, to(url, { [FILTER]: c.id === "all" ? null : c.id }), now === c.id),
  );
  const picked = url.searchParams.get(PROJECT);
  const names = projectsOf(all);
  const projects =
    names.length === 0
      ? [tag("project", NO_PROJECT, null, false)]
      : names.map((n) =>
          tag("project", n, to(url, { [PROJECT]: n === picked ? null : n }), n === picked),
        );
  return (
    `<div class="filter" data-ui="tasks.filter"><span class="says">filter:</span>` +
    [...states, ...projects, tag("seat", NO_SEAT, null, false)].join("") +
    `</div>`
  );
}

/** One line of the inbox, and one line is all of it: the id, the label and the state, each
 *  inline, with nothing in the row that a browser would break onto a second line. The
 *  definition budgets this node one line so a row reads as a task to notice and not as the
 *  whole brief; the label is clipped by the look rather than cut here, so the row keeps its
 *  own words and the reader gets the rest from the detail.
 *
 *  The label leads because the label is what the task is; the state trails because it is
 *  what changes under it. */
const line = (task: Item, picked: boolean, url: URL): string =>
  `<li id="task-${task.id}"${picked ? ` class="picked"` : ""} data-ui="tasks.list.item">` +
  `<a href="${selects(url, task.id)}"><span class="id">#${task.id}</span>` +
  `<span class="label">${escape(task.label)}</span>` +
  `<span class="state">${escape(task.state)}</span></a></li>`;

/** What proves a task, each proof in the state it is in now. A task nothing proves says so
 *  — an empty list reads as a page that failed to draw one. */
function proofs(said: readonly Node[]): string {
  if (said.length === 0) return `<dd class="none">nothing proves it yet</dd>`;
  return (
    `<dd><ul>` +
    said
      .map(
        (p) =>
          `<li id="proof-${p.id}">#${p.id} · ${escape(p.label)}` +
          ` · <span class="state">${escape(p.state)}</span></li>`,
      )
      .join("") +
    `</ul></dd>`
  );
}

/** The selected task, whole. */
function detail(task: Item): string {
  return (
    `<section class="detail" id="detail-${task.id}" data-ui="tasks.detail">` +
    `<h2><span class="id">#${task.id}</span>${escape(task.label)}</h2>` +
    `<dl><dt>state</dt><dd class="state">${escape(task.state)}</dd>` +
    `<dt>story</dt>` +
    (task.story === null
      ? `<dd class="none">hangs under no story</dd>`
      : `<dd>${escape(task.story)}</dd>`) +
    `<dt>proven by</dt>${proofs(task.proofs)}</dl>` +
    `</section>`
  );
}

/** The right-hand column when there is nothing to put in it. */
const nothing = (said: string): string =>
  `<section class="detail" data-ui="tasks.detail"><p class="empty">${escape(said)}</p></section>`;

/** What the filter says when it admits none of the tasks the record holds. Narrowing to
 *  nothing is a thing a reader did, and the page says so rather than reading as broken. */
const NONE_ADMITTED = "no task the filter admits";

/** What the page says: its name, the filter, and under them the list and the detail side by
 *  side. The frame is the shell's.
 *
 *  `tasks.detail.transcript`, `.diff`, `.retry` and `.drop` are declared and are *not*
 *  drawn. Every one of them is a verb, and what changes wecode is the cli's — they wait on
 *  the operator to say whether this surface acts at all. */
export function tasksInbox(nodes: readonly Node[], url: URL): string {
  const all = items(nodes);
  const shown = admitted(all, url);
  const one = shown.length === 0 ? null : picked(shown, url);
  const id = typeof one === "object" && one !== null ? one.id : null;
  const body =
    all.length === 0
      ? `<p class="empty">${NO_TASKS}</p>`
      : `<div class="inbox">` +
        `<ul class="inbox" data-ui="tasks.list">` +
        shown.map((t) => line(t, t.id === id, url)).join("") +
        `</ul>` +
        (shown.length === 0
          ? nothing(NONE_ADMITTED)
          : one === null
            ? nothing(`no task selected`)
            : typeof one === "number"
              ? nothing(nothingAt(one))
              : detail(one)) +
        `</div>`;
  return (
    `<section class="tasks" data-ui="tasks"><h2>Tasks</h2>` + filter(all, url) + body + `</section>`
  );
}

/** The whole document: the inbox, in the shell design.yaml declares. */
export function tasksPage(nodes: readonly Node[], url: URL): Reply {
  return html(document(tasksInbox(nodes, url)));
}

/** The page, bound to a way of reading the record now. Read fresh on every request, for the
 *  reason the board is: work moves without anybody reloading. */
export const tasksAt = (nodes: () => readonly Node[]): Page =>
  shelled((url) => tasksInbox(nodes(), url));
