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
 *  nodes do. */
import type { Node } from "@wecode/core";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { document, shelled } from "./shell.js";

/** Which task the reader picked, as the target spells it. One name, so a link built by the
 *  page and a link typed by a person are the same link. */
export const PARAM = "task";

/** A task, with the place the record keeps it in. The story is what a task is work on; the
 *  proofs are the task tests hung under it, each with the state it is in now. */
export interface Item {
  readonly id: number;
  readonly label: string;
  readonly state: string;
  /** The story this is work on, or null when the record hangs it under nothing. */
  readonly story: string | null;
  readonly proofs: readonly Node[];
}

/** What the page says when the record holds no task at all. A page that came back blank
 *  reads as a page that failed. */
const NO_TASKS = "no task in the record yet";

/** What the detail says when the target names a task the record has not got. A reader who
 *  followed a stale link is told so, rather than shown the first task as though they had
 *  asked for it. */
const nothingAt = (id: number): string => `no task #${id} in the record`;

/** This page's own presentation: two columns, the list scrolling on its own so the detail
 *  stays put. It collapses to one column on a narrow viewport, list first — a list that
 *  cannot be reached is worse than a detail that has to be scrolled to. The document's
 *  margins, type and banner are the shell's and none of them is here. */
const STYLE = `
  div.inbox { display: grid; grid-template-columns: minmax(0, 18rem) minmax(0, 1fr);
              gap: 1.25rem; align-items: start }
  @media (max-width: 48rem) { div.inbox { grid-template-columns: minmax(0, 1fr) } }
  ul.inbox { list-style: none; margin: 0; padding: 0; max-height: 70vh; overflow-y: auto }
  ul.inbox li { min-width: 0 }
  ul.inbox a { display: block; padding: .2rem .4rem; color: #ddd; text-decoration: none;
               border-left: 2px solid transparent; overflow-wrap: anywhere }
  ul.inbox a:hover { background: #1a1a1a }
  ul.inbox li.picked a { border-left-color: #6cf; background: #1a1a1a }
  ul.inbox .id { color: #888; margin-right: .5rem }
  ul.inbox .state { color: #6cf; margin-left: .5rem }
  section.detail { border: 1px solid #333; border-radius: 4px; padding: .75rem 1rem;
                   min-width: 0 }
  section.detail h2 { font-size: 1rem; font-weight: 600; margin: 0 0 .5rem;
                      overflow-wrap: anywhere }
  section.detail h2 .id { color: #888; margin-right: .6rem }
  dl { display: grid; grid-template-columns: 6rem 1fr; gap: .2rem .75rem; margin: 0 }
  dt { color: #888 }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere }
  dd.none { color: #666 }
  dd ul { list-style: none; margin: 0; padding: 0 }
  dd .state { color: #6cf }
  p.empty { margin: 0; color: #666 }
`;

/** Every task the record holds, outermost first and in the record's own order, each
 *  carrying the story it hangs under.
 *
 *  A task is found wherever it sits: the ledger puts a requirement, a criterion and an
 *  acceptance test between a story and its tasks, and a task hung under another task's
 *  proof is still a task. What is *not* walked into is a task's own children — those are
 *  its proofs and belong in its detail, not as rows of the inbox. */
export function items(nodes: readonly Node[], story: string | null = null): readonly Item[] {
  return nodes.flatMap((n) => {
    if (n.entity === "task") {
      return [{ id: n.id, label: n.label, state: n.state, story, proofs: n.children }];
    }
    return items(n.children, n.entity === "story" ? n.label : story);
  });
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

/** One line of the inbox. The label leads because the label is what the task is; the state
 *  trails because it is what changes under it. */
const line = (task: Item, picked: boolean): string =>
  `<li id="task-${task.id}"${picked ? ` class="picked"` : ""}>` +
  `<a href="?${PARAM}=${task.id}"><span class="id">#${task.id}</span>` +
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
    `<section class="detail" id="detail-${task.id}">` +
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
  `<section class="detail"><p class="empty">${escape(said)}</p></section>`;

/** What the page says: the list and the detail, side by side, and nothing around them. The
 *  frame is the shell's. */
export function tasksInbox(nodes: readonly Node[], url: URL): string {
  const all = items(nodes);
  if (all.length === 0) return `<p class="empty">${NO_TASKS}</p>`;
  const one = picked(all, url);
  const id = typeof one === "object" && one !== null ? one.id : null;
  return (
    `<div class="inbox">` +
    `<ul class="inbox">${all.map((t) => line(t, t.id === id)).join("")}</ul>` +
    (one === null
      ? nothing(`no task selected`)
      : typeof one === "number"
        ? nothing(nothingAt(one))
        : detail(one)) +
    `</div>`
  );
}

/** The whole document: the inbox, in the shell design.yaml declares. */
export function tasksPage(nodes: readonly Node[], url: URL): Reply {
  return html(document(tasksInbox(nodes, url), STYLE));
}

/** The page, bound to a way of reading the record now. Read fresh on every request, for the
 *  reason the board is: work moves without anybody reloading. */
export const tasksAt = (nodes: () => readonly Node[]): Page =>
  shelled((url) => tasksInbox(nodes(), url), STYLE);
