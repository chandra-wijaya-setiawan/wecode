/** The tasks page: every task in one list on the left, the selected one in full on the right.
 *
 *  The nodes are hand-made rather than read out of a workspace, for the reason the board's,
 *  the tree's and the decisions page's rows are: what is held here is the page and the
 *  transport, and that the record's shape is a tree is `@wecode/core`'s `tree()` and is
 *  tested where that function lives.
 *
 *  Three things this file holds. A task is found wherever the ledger put it, however many
 *  proof levels sit above it. The selection is in the target and nowhere else, so a link to
 *  one task is a link a person can send. And what has no answer — no tasks, a stale id —
 *  is said rather than drawn as an empty column. */
import type { Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Node, Rollup } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, answer, serve } from "../src/index.js";
import { discovered, mounted, pathOf } from "../src/pages/discover.js";
import { items, picked, tasksAt, tasksInbox, tasksPage } from "../src/pages/tasks.js";

const NONE: Rollup = { done: 0, open: 0, failed: 0 };

const node = (entity: string, id: number, over: Partial<Node> = {}): Node => ({
  entity,
  id,
  label: `${entity} ${id}`,
  state: "planned",
  children: [],
  rollup: NONE,
  folded: false,
  ...over,
});

/** A record with the four proof levels between a story and its task, as the ledger keeps
 *  it: project → release → epic → story → requirement → criteria → acceptance test → task. */
const deep = (tasks: readonly Node[], story = "ship the tasks page"): Node =>
  node("project", 1, {
    children: [
      node("release", 2, {
        children: [
          node("epic", 3, {
            children: [
              node("story", 4, {
                label: story,
                children: [
                  node("requirement", 5, {
                    children: [
                      node("acceptance_criteria", 6, {
                        children: [node("acceptance_test", 7, { children: tasks })],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });

const task = (id: number, over: Partial<Node> = {}): Node => node("task", id, over);

const at = (query = ""): URL => new URL(`http://localhost/tasks${query}`);

/** The left column of a page, without any of the detail beside it. */
const listOf = (body: string): string =>
  body.slice(body.indexOf(`<ul class="inbox">`), body.indexOf("</ul>"));

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
    const body = tasksInbox([deep([task(8), task(9), task(10)])], at());
    expect(items([deep([task(8), task(9), task(10)])]).map((t) => t.id)).toEqual([8, 9, 10]);
    expect(body.indexOf(`id="task-8"`)).toBeLessThan(body.indexOf(`id="task-9"`));
    expect(body.indexOf(`id="task-9"`)).toBeLessThan(body.indexOf(`id="task-10"`));
  });

  it("carries the story a task is work on, and never a nearer level's words", () => {
    expect(items([deep([task(8)], "ship the tasks page")])[0]?.story).toBe("ship the tasks page");
  });

  it("says so rather than a story when the record hangs a task under none", () => {
    expect(items([node("project", 1, { children: [task(8)] })])[0]?.story).toBeNull();
  });

  it("leaves a task's own proofs out of the list and on the task", () => {
    const one = items([deep([task(8, { children: [node("task_test", 9)] })])])[0];
    expect(one?.proofs.map((p) => p.id)).toEqual([9]);
    expect(listOf(tasksInbox([deep([task(8, { children: [node("task_test", 9)] })])], at()))).not.toContain(
      `id="task-9"`,
    );
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
    expect(tasksInbox([deep([])], at())).toBe(`<p class="empty">no task in the record yet</p>`);
    expect(tasksInbox([], at())).toBe(`<p class="empty">no task in the record yet</p>`);
  });
});

describe("the selection is in the target", () => {
  const record = [deep([task(8), task(9)])];

  it("takes the task the target names", () => {
    const one = picked(items(record), at("?task=9"));
    expect(typeof one === "object" && one?.id).toBe(9);
  });

  it("selects the first task when the target names none", () => {
    const one = picked(items(record), at());
    expect(typeof one === "object" && one?.id).toBe(8);
  });

  it("marks the selected line and no other", () => {
    const list = listOf(tasksInbox(record, at("?task=9")));
    expect(list).toContain(`<li id="task-9" class="picked">`);
    expect(list).toContain(`<li id="task-8">`);
    expect([...list.matchAll(/class="picked"/g)]).toHaveLength(1);
  });

  it("links every line to itself, so one task is a link a person can send", () => {
    const list = listOf(tasksInbox(record, at("?task=9")));
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
  const record = [
    deep(
      [
        task(8, {
          label: "wire the route",
          state: "in_progress",
          children: [
            node("task_test", 9, { label: "the page is served", state: "passed" }),
            node("task_test", 10, { label: "the list is every task", state: "planned" }),
          ],
        }),
      ],
      "ship the tasks page",
    ),
  ];
  const detail = detailOf(tasksInbox(record, at("?task=8")));

  it("leads with the task's own words and its id", () => {
    expect(detail).toContain(`<h2><span class="id">#8</span>wire the route</h2>`);
  });

  it("says the state it is in and the story it is work on", () => {
    expect(detail).toContain(`<dd class="state">in_progress</dd>`);
    expect(detail).toContain(`<dd>ship the tasks page</dd>`);
  });

  it("says what proves it, each proof in the state it is in now", () => {
    expect(detail).toContain(`<li id="proof-9">#9 · the page is served · <span class="state">passed</span></li>`);
    expect(detail).toContain(`<li id="proof-10">#10 · the list is every task · <span class="state">planned</span></li>`);
  });

  it("says so rather than an empty list when nothing proves the task yet", () => {
    expect(detailOf(tasksInbox([deep([task(8)])], at()))).toContain("nothing proves it yet");
  });

  it("says so rather than a blank when the task hangs under no story", () => {
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
    expect(body.startsWith(`<div class="inbox">`)).toBe(true);
    expect(body.indexOf(`<ul class="inbox">`)).toBeLessThan(body.indexOf(`<section class="detail"`));
  });

  it("closes every element it opens", () => {
    for (const [open, close] of [["<ul", "</ul>"], ["<li", "</li>"], ["<div", "</div>"]] as const) {
      expect([...body.matchAll(new RegExp(open, "g"))]).toHaveLength(
        [...body.matchAll(new RegExp(close, "g"))].length,
      );
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
    expect(inside).toContain(`<li id="task-8" class="picked">`);
    expect(body).toBe(tasksPage([deep([task(8)])], at()).body);
  });

  it("serves the task the query names, over a socket", async () => {
    const server = await serve({ "/tasks": tasksAt(() => [deep([task(8), task(9)])]) });
    servers.push(server);
    const body = await (await fetch(`${addressOf(server)}/tasks?task=9`)).text();
    expect(body).toContain(`<li id="task-9" class="picked">`);
    expect(body).toContain(`id="detail-9"`);
  });

  it("reads the record again on every request", async () => {
    let nodes: readonly Node[] = [deep([])];
    const server = await serve({ "/tasks": tasksAt(() => nodes) });
    servers.push(server);
    expect(await (await fetch(`${addressOf(server)}/tasks`)).text()).toContain(
      "no task in the record yet",
    );
    nodes = [deep([task(8)])];
    expect(await (await fetch(`${addressOf(server)}/tasks`)).text()).toContain(`<li id="task-8"`);
  });

  it("offers no verb, because every verb that changes wecode is the cli's", () => {
    const body = tasksPage([deep([task(8)])], at()).body;
    for (const verb of ["<form", "<button", "<input", "onclick"]) {
      expect(body, `the tasks page offers ${verb}`).not.toContain(verb);
    }
  });
});

/** The wiring is the file, not a table. `bin.ts` held a route per page once; discovery
 *  replaced it, so what is asserted here is the three conventions a page keeps — the file
 *  is under `pages/`, it answers at `/tasks`, and it is served the record — and that
 *  `bin.ts` names none of it. */
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
    const map = readFileSync(
      fileURLToPath(new URL("../../core/config/components.yaml", import.meta.url)),
      "utf8",
    );
    expect(map).toContain("pages/tasks");
  });
});
