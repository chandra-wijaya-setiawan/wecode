/** The tasks page: the nodes ui.yaml declares for it, drawn — a filter that narrows through
 *  the query string, the admitted tasks as one-line rows, and the selected one in full.
 *
 *  The nodes are hand-made rather than read out of a workspace, for the reason the board's
 *  and the tree's rows are: what is held here is the page and the transport, and that the
 *  record's shape is a tree is `@wecode/core`'s `tree()` and is tested where it lives. */
import type { Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Node, Rollup } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, answer, serve } from "../src/index.js";
import { discovered, mounted, pathOf } from "../src/pages/discover.js";
import { items, picked, tasksAt, tasksInbox, tasksPage } from "../src/pages/tasks.js";

const NONE: Rollup = { done: 0, open: 0, failed: 0 };

const node = (entity: string, id: number, over: Partial<Node> = {}): Node =>
  ({ entity, id, label: `${entity} ${id}`, state: "planned", children: [], rollup: NONE, folded: false, ...over });

/** A record with the four proof levels between a story and its task, as the ledger keeps
 *  it, outermost first. Ids run 1..7 down the chain; the tasks carry their own. */
const LEVELS = ["project", "release", "epic", "story", "requirement", "acceptance_criteria", "acceptance_test"];
const deep = (tasks: readonly Node[], story = "ship the tasks page"): Node =>
  (LEVELS.reduceRight<Node[]>(
    (children, entity, i) =>
      [node(entity, i + 1, { children, ...(entity === "story" ? { label: story } : {}) })],
    tasks as Node[],
  )[0] as Node);

const task = (id: number, over: Partial<Node> = {}): Node => node("task", id, over);

const at = (query = ""): URL => new URL(`http://localhost/tasks${query}`);

/** The left column of a page, without any of the detail beside it. */
const listOf = (body: string): string => body.slice(body.indexOf(`<ul class="inbox"`), body.indexOf("</ul>"));

/** The right column, without any of the list beside it. */
const detailOf = (body: string): string => body.slice(body.indexOf(`<section class="detail"`));

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("the list is every task in the record", () => {
  it("finds a task under however many proof levels the record put above it", () => {
    expect(items([deep([task(8)])]).map((t) => t.id)).toEqual([8]);
  });

  it("keeps the record's own order, and every task of it", () => {
    const three = [deep([task(8), task(9), task(10)])];
    expect(items(three).map((t) => t.id)).toEqual([8, 9, 10]);
    const body = tasksInbox(three, at());
    expect(body.indexOf(`id="task-8"`)).toBeLessThan(body.indexOf(`id="task-9"`));
    expect(body.indexOf(`id="task-9"`)).toBeLessThan(body.indexOf(`id="task-10"`));
  });

  it("carries the story a task is work on, or null, and never a nearer level's words", () => {
    expect(items([deep([task(8)], "ship the tasks page")])[0]?.story).toBe("ship the tasks page");
    expect(items([node("project", 1, { children: [task(8)] })])[0]?.story).toBeNull();
  });

  it("leaves a task's own proofs out of the list and on the task", () => {
    const held = [deep([task(8, { children: [node("task_test", 9)] })])];
    expect(items(held)[0]?.proofs.map((p) => p.id)).toEqual([9]);
    expect(listOf(tasksInbox(held, at()))).not.toContain(`id="task-9"`);
  });

  it("draws a line as the label, its id and the state it is in now", () => {
    const body = tasksInbox([deep([task(8, { label: "wire the route", state: "in_progress" })])], at());
    expect(listOf(body)).toContain(
      `<a href="?task=8"><span class="id">#8</span>` +
        `<span class="label">wire the route</span>` +
        `<span class="state">in_progress</span></a>`,
    );
  });

  it("says so rather than coming back blank when the record holds no task", () => {
    expect(tasksInbox([deep([])], at())).toContain(`<p class="empty">no task in the record yet</p>`);
    expect(tasksInbox([], at())).toContain(`<p class="empty">no task in the record yet</p>`);
    expect(tasksInbox([deep([])], at())).not.toContain(`<ul class="inbox"`);
  });
});

describe("the selection is in the target", () => {
  const record = [deep([task(8), task(9)])];

  it("takes the task the target names, and the first one when the target names none", () => {
    expect((picked(items(record), at("?task=9")) as { id: number }).id).toBe(9);
    expect((picked(items(record), at()) as { id: number }).id).toBe(8);
  });

  it("marks the selected line and no other, and links every line to itself", () => {
    const list = listOf(tasksInbox(record, at("?task=9")));
    expect(list).toContain(`<li id="task-9" class="picked" data-ui="tasks.list.item">`);
    expect(list).toContain(`<li id="task-8" data-ui="tasks.list.item">`);
    expect([...list.matchAll(/class="picked"/g)]).toHaveLength(1);
    expect(list).toContain(`href="?task=8"`);
    expect(list).toContain(`href="?task=9"`);
  });

  it("tells a reader who followed a stale link, rather than showing them another task", () => {
    const body = tasksInbox(record, at("?task=404"));
    expect(detailOf(body)).toContain("no task #404 in the record");
    expect(detailOf(body)).not.toContain("task 8");
    expect(listOf(body)).not.toContain("picked");
  });

  it("treats a target that is not a number as naming nothing", () => {
    expect(detailOf(tasksInbox(record, at("?task=nine")))).toContain("no task selected");
  });
});

describe("the detail is the selected task in full", () => {
  const proven = [
    node("task_test", 9, { label: "the page is served", state: "passed" }),
    node("task_test", 10, { label: "the list is every task", state: "planned" }),
  ];
  const one = task(8, { label: "wire the route", state: "in_progress", children: proven });
  const record = [deep([one], "ship the tasks page")];
  const detail = detailOf(tasksInbox(record, at("?task=8")));

  it("leads with the task's own words and its id, then its state and its story", () => {
    expect(detail).toContain(`<h2><span class="id">#8</span>wire the route</h2>`);
    expect(detail).toContain(`<dd class="state">in_progress</dd>`);
    expect(detail).toContain(`<dd>ship the tasks page</dd>`);
  });

  it("says what proves it, each proof in the state it is in now", () => {
    expect(detail).toContain(`<li id="proof-9">#9 · the page is served · <span class="state">passed</span></li>`);
    expect(detail).toContain(`<li id="proof-10">#10 · the list is every task · <span class="state">planned</span></li>`);
  });

  it("says so rather than a blank when nothing proves it, or nothing above it is a story", () => {
    expect(detailOf(tasksInbox([deep([task(8)])], at()))).toContain("nothing proves it yet");
    const loose = [node("project", 1, { children: [task(8)] })];
    expect(detailOf(tasksInbox(loose, at()))).toContain("hangs under no story");
  });

  it("writes a person's own words as words and not as markup", () => {
    const body = tasksInbox([deep([task(8, { label: `a <script> & "quotes"` })])], at());
    expect(body).not.toContain("<script>");
    expect(body).toContain(`a &lt;script&gt; &amp; &quot;quotes&quot;`);
  });
});

describe("the list is left and the detail is right", () => {
  const body = tasksInbox([deep([task(8)])], at());

  it("puts both columns in one grid, the list first", () => {
    expect(body).toContain(`<div class="inbox">`);
    expect(body.indexOf(`<ul class="inbox"`)).toBeLessThan(body.indexOf(`<section class="detail"`));
  });

  it("closes every element it opens", () => {
    for (const [open, close] of [["<ul", "</ul>"], ["<li", "</li>"], ["<div", "</div>"], ["<section", "</section>"]] as const) {
      const shut = [...body.matchAll(new RegExp(close, "g"))].length;
      expect([...body.matchAll(new RegExp(open, "g"))]).toHaveLength(shut);
    }
  });

  it("lays the two columns out as columns, and stacks them on a narrow viewport", () => {
    const page = tasksPage([deep([task(8)])], at()).body;
    expect(page).toContain("div.inbox { display: grid; grid-template-columns: minmax(0, 18rem) minmax(0, 1fr)");
    expect(page).toContain("@media (max-width: 48rem)");
  });
});

describe("the page is served in the shell", () => {
  it("answers /tasks with an html document in the shell", async () => {
    const server = await serve({ "/tasks": tasksAt(() => [deep([task(8)])]) });
    servers.push(server);
    const res = await fetch(`${addressOf(server)}/tasks`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain("<title>wecode</title>");
    const inside = body.slice(body.indexOf("<main>"), body.indexOf("</main>"));
    expect(inside).toContain(`<li id="task-8" class="picked" data-ui="tasks.list.item">`);
    expect(body).toBe(tasksPage([deep([task(8)])], at()).body);
  });

  it("serves the task the query names, over a socket", async () => {
    const server = await serve({ "/tasks": tasksAt(() => [deep([task(8), task(9)])]) });
    servers.push(server);
    const body = await (await fetch(`${addressOf(server)}/tasks?task=9`)).text();
    expect(body).toContain(`<li id="task-9" class="picked" data-ui="tasks.list.item">`);
    expect(body).toContain(`id="detail-9"`);
  });

  it("reads the record again on every request", async () => {
    let nodes: readonly Node[] = [deep([])];
    const server = await serve({ "/tasks": tasksAt(() => nodes) });
    servers.push(server);
    expect(await (await fetch(`${addressOf(server)}/tasks`)).text()).toContain("no task in the record yet");
    nodes = [deep([task(8)])];
    expect(await (await fetch(`${addressOf(server)}/tasks`)).text()).toContain(`<li id="task-8"`);
  });

  /** The shell's terminal dock is the one verb the document carries, so the page is left
   *  with the rule that outlives approval 1561: no script, because none is served. */
  it("offers no verb of its own, because the dock is the only way in", () => {
    const body = tasksPage([deep([task(8)])], at()).body;
    for (const verb of ["onclick"]) expect(body, verb).not.toContain(verb);
  });
});

/** The wiring is the file, not a table: the three conventions a page keeps — under
 *  `pages/`, answering at `/tasks`, served the record — and `bin.ts` naming none of it. */
describe("the surface routes it", () => {
  const BIN = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");
  const PAGES = fileURLToPath(new URL("../src/pages", import.meta.url));

  it("binds /tasks to the page, reading the record through core's tree()", async () => {
    expect(discovered(readdirSync(PAGES))).toContain("tasks");
    expect(pathOf("tasks")).toBe("/tasks");
    const record = deep([node("task", 9, { label: "widen the scope" })]);
    const module = (await import("../src/pages/tasks.js")) as Record<string, unknown>;
    const routes = { [pathOf("tasks")]: mounted("tasks", module, { record: () => [record] }) };
    const reply = answer(routes, "GET", "/tasks");
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("widen the scope");
  });

  it("leaves the pages that were already there where they were", () => {
    const names = discovered(readdirSync(PAGES));
    expect(names).toContain("board");
    expect(names).toContain("tree");
    expect(pathOf("board")).toBe("/");
    expect(pathOf("tree")).toBe("/tree");
  });

  it("is not named in bin.ts, because no page is", () => {
    expect(BIN).not.toContain("tasksAt");
    expect(BIN).not.toContain("pages/tasks");
  });
});

describe("the component map claims the page", () => {
  it("names it among the webapp's modules", () => {
    const where = new URL("../../core/config/components.yaml", import.meta.url);
    const map = readFileSync(fileURLToPath(where), "utf8");
    expect(map).toContain("pages/tasks");
  });
});
/** The nodes `packages/webapp/config/ui.yaml` declares under `tasks`: the id each carries
 *  as its `data-ui`, and the `says` the definition gives it. Written out here rather than
 *  read off that file because the file is not in this tree — it has never landed on master
 *  and this story may not add it. When it lands, this table is what it is read against.
 *  `project` and `seat` are declared with a `repeats` and no `says`. */
const DECLARED: readonly (readonly [string, string | null])[] = [
  ["tasks", "Tasks"],
  ["tasks.filter", "filter:"],
  ["tasks.filter.all", "all"],
  ["tasks.filter.running", "running"],
  ["tasks.filter.ready", "ready"],
  ["tasks.filter.failed", "failed"],
  ["tasks.filter.done-today", "done today"],
  ["tasks.filter.project", null],
  ["tasks.filter.seat", null],
  ["tasks.list", null],
  ["tasks.list.item", null],
  ["tasks.detail", null],
];

const two = [deep([task(8)]), { ...deep([task(9, { state: "ready" })]), id: 11, label: "other" }] as Node[];

describe("every node the definition declares is drawn, by its own name", () => {
  const body = tasksInbox([deep([task(8), task(9, { state: "ready" })])], at());
  const where = (id: string): number => body.indexOf(`data-ui="${id}"`);

  it("draws each declared node, carrying its id and saying what the definition says", () => {
    for (const [id, says] of DECLARED) {
      expect(body, id).toContain(`data-ui="${id}"`);
      if (says !== null) expect(body.slice(where(id), where(id) + 200), id).toContain(says);
    }
  });

  it("nests them as the definition parents them", () => {
    for (const [outer, inner] of [
      ["tasks", "tasks.filter"],
      ["tasks.filter", "tasks.filter.all"],
      ["tasks.filter", "tasks.list"],
      ["tasks.list", "tasks.list.item"],
      ["tasks.list.item", "tasks.detail"],
    ] as const) {
      expect(where(outer), `${outer} before ${inner}`).toBeLessThan(where(inner));
    }
  });

  it("repeats the item once per task admitted, and the project tag once per project", () => {
    expect([...body.matchAll(/data-ui="tasks\.list\.item"/g)]).toHaveLength(2);
    expect([...tasksInbox(two, at()).matchAll(/data-ui="tasks\.filter\.project"/g)]).toHaveLength(2);
    expect(tasksInbox(two, at())).toContain("other");
  });

  it("draws an axis the record offers nothing for as a word, not a link to an empty list", () => {
    // A node is an entity, a label and a state; nothing in it names the seat a task was
    // worked at. So the seat tag is always the word, and a seat filter that bites needs a
    // reading of the seats in `bin.ts` and not a change to this page.
    expect(body).toContain(`<span class="tag none" data-ui="tasks.filter.seat">no seat in the record</span>`);
    const loose = tasksInbox([node("requirement", 1, { children: [task(8)] })], at());
    expect(loose).toContain(`<span class="tag none" data-ui="tasks.filter.project">no project`);
  });

  it("draws none of the four that are verbs, which wait on the operator", () => {
    for (const id of ["transcript", "diff", "retry", "drop"]) expect(body, id).not.toContain(`tasks.detail.${id}`);
    for (const says of ["read transcript", "open diff", "retry with reason"]) expect(body, says).not.toContain(says);
  });
});

describe("the filter narrows the list through the query string", () => {
  const states = ["planned", "ready", "failed", "done", "dropped"];
  const record = [deep(states.map((state, i) => task(8 + i, { state })))];
  const seen = (query: string, nodes: readonly Node[] = record): readonly number[] =>
    [...listOf(tasksInbox(nodes, at(query))).matchAll(/id="task-(\d+)"/g)].map((m) => Number(m[1]));

  it("narrows to what each chip admits, in the reader's words and not the machine's", () => {
    // machines.yaml puts a started task in `ready` and an unstarted one in `planned`; a
    // person reading the surface calls those running and ready. "done today" admits `done`
    // — a node carries no time a task finished, so "today" waits on a reading that does.
    expect(seen("?filter=running")).toEqual([9]);
    expect(seen("?filter=ready")).toEqual([8]);
    expect(seen("?filter=failed")).toEqual([10]);
    expect(seen("?filter=done-today")).toEqual([11]);
  });

  it("shows every task when no chip is held, or when the target names one there is not", () => {
    expect(seen("")).toEqual([8, 9, 10, 11, 12]);
    expect(seen("?filter=all")).toEqual([8, 9, 10, 11, 12]);
    expect(seen("?filter=whenever")).toEqual([8, 9, 10, 11, 12]);
  });

  it("narrows on the project too, and on both axes at once", () => {
    expect(seen("?project=other", two)).toEqual([9]);
    expect(seen("?project=other&filter=running", two)).toEqual([9]);
    expect(seen("?project=other&filter=failed", two)).toEqual([]);
  });

  it("says so rather than drawing an empty column when the filter admits nothing", () => {
    expect(detailOf(tasksInbox(record, at("?project=nowhere")))).toContain("no task the filter admits");
  });

  it("offers every chip as a link and never as a verb", () => {
    const body = tasksInbox(record, at());
    const bar = body.slice(0, body.indexOf(`<div class="inbox">`));
    for (const id of ["all", "running", "ready", "failed", "done-today"]) {
      expect(bar, id).toMatch(new RegExp(`<a class="tag[^"]*" data-ui="tasks\\.filter\\.${id}" href="\\?`));
    }
    for (const verb of ["<form", "<button", "<input", "onclick", "<select"]) expect(bar, verb).not.toContain(verb);
  });

  it("marks the chip the target holds and no other, and marks all when it holds none", () => {
    const one = tasksInbox(record, at("?filter=failed"));
    expect(one).toMatch(/<a class="tag on" data-ui="tasks\.filter\.failed"/);
    expect([...one.matchAll(/class="tag on"/g)]).toHaveLength(1);
    expect(tasksInbox(record, at())).toMatch(/<a class="tag on" data-ui="tasks\.filter\.all"/);
  });

  it("drops the selection as it narrows, and keeps the narrowing as a task is picked", () => {
    const bar = tasksInbox(record, at("?task=11"));
    expect(bar).toContain(`<a class="tag" data-ui="tasks.filter.running" href="?filter=running">`);
    expect(bar).not.toContain(`href="?filter=running&task=11"`);
    expect(listOf(tasksInbox(record, at("?filter=running")))).toContain(`href="?filter=running&task=9"`);
  });

  it("holds every chip to its own narrowing: the target it offers is the one that bites", () => {
    const bar = tasksInbox(record, at());
    for (const id of ["running", "ready", "failed", "done-today"]) {
      const href = bar.slice(bar.indexOf(`data-ui="tasks.filter.${id}"`)).match(/href="([^"]+)"/)?.[1];
      expect(href, id).toBe(`?filter=${id}`);
      expect(seen(href as string).length, id).toBe(1);
    }
  });
});

describe("a row reads as one line, which is the budget the definition gives the item", () => {
  const long = "a label a browser would gladly wrap over two or three lines ".repeat(4);
  const whole = listOf(tasksInbox([deep([task(8, { label: long })])], at()));
  const row = whole.slice(whole.indexOf("<li"));

  it("puts nothing in the row a browser would put on a second line, and cuts no words", () => {
    for (const block of ["<div", "<p", "<ul", "<br", "<dl", "<h2", "<section"]) expect(row, block).not.toContain(block);
    expect(row).toContain(long);
  });

  it("is held to the one line by the look, which clips the label rather than wrapping it", () => {
    const sheet = tasksPage([deep([task(8)])], at()).body;
    expect(sheet).toMatch(/ul\.inbox a \{[^}]*white-space: nowrap/);
    expect(sheet).toMatch(/ul\.inbox a \{[^}]*overflow: hidden/);
    expect(sheet).toMatch(/ul\.inbox \.label \{[^}]*text-overflow: ellipsis/);
    expect(sheet).not.toMatch(/ul\.inbox a \{[^}]*overflow-wrap: anywhere/);
  });

  it("gives the detail the whole brief the row has not the room for", () => {
    const body = tasksInbox([deep([task(8, { label: long })])], at());
    expect(detailOf(body)).toContain(long);
    expect(detailOf(body)).toContain("proven by");
  });
});
