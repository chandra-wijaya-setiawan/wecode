/** The four controls the definition declares under `tasks.detail` — `transcript`, `diff`,
 *  `retry` and `drop` — and what the page offers in their place, which is nothing.
 *
 *  Every one of the four is a verb, and what changes wecode is the cli's. So the four are
 *  declared and deliberately not drawn: they wait on the operator to say whether this
 *  surface acts at all. That is worth a file of its own, because "not yet" is the kind of
 *  decision a later change undoes by accident — somebody wiring a retry button has to make
 *  this file red to do it, and red is the moment to go and get the answer.
 *
 *  What is held here is only the withholding. That the detail draws the task it is given —
 *  its words, its state, its story, its proofs — and that `tasks.detail` itself is drawn
 *  under the item, is the surface, and is proved against the definition in
 *  `the-tasks-page-is-an-inbox`. Nothing about the drawn shape is restated here.
 *
 *  The nodes are hand-made rather than read out of a workspace, for the reason that file's
 *  are: what is held is the page and the transport. */
import type { Server } from "node:http";
import type { Node, Rollup } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, serve } from "../src/index.js";
import { tasksAt, tasksInbox, tasksPage } from "../src/pages/tasks.js";

const NONE: Rollup = { done: 0, open: 0, failed: 0 };

const node = (entity: string, id: number, over: Partial<Node> = {}): Node =>
  ({ entity, id, label: `${entity} ${id}`, state: "planned", children: [], rollup: NONE, folded: false, ...over });

/** A task under the proof levels the ledger keeps between a story and its task. */
const LEVELS = ["project", "release", "epic", "story", "requirement", "acceptance_criteria", "acceptance_test"];
const deep = (tasks: readonly Node[]): Node =>
  (LEVELS.reduceRight<Node[]>((kids, entity, i) => [node(entity, i + 1, { children: kids })], tasks as Node[])[0] as Node);

const task = (id: number, over: Partial<Node> = {}): Node => node("task", id, over);

const at = (query = ""): URL => new URL(`http://localhost/tasks${query}`);

/** The right-hand column of a body: the detail section, or the empty paragraph that stands
 *  in for it when the record holds nothing to select. Never the filter bar above them,
 *  whose chips are links by design and are held to that where the filter is proved. */
const columnOf = (body: string): string => {
  const found = body.indexOf(`<section class="detail"`);
  return body.slice(found === -1 ? body.indexOf(`<p class="empty">`) : found);
};

/** The four, by the id the definition declares each under and the words it gives it. Written
 *  out here rather than read off `packages/webapp/config/ui.yaml` for the reason the drawn
 *  nodes are written out in `the-tasks-page-is-an-inbox`: that file is not in this tree. When
 *  it lands, this table is what it is read against. */
const WITHHELD: readonly (readonly [string, string])[] = [
  ["tasks.detail.transcript", "read transcript"],
  ["tasks.detail.diff", "open diff"],
  ["tasks.detail.retry", "retry with reason"],
  ["tasks.detail.drop", "drop"],
];

/** The three of the four whose words are their own. "drop" is a word a document may say for
 *  a dozen reasons — a dropped task's state, for one — so the drop control is held by its
 *  id everywhere and by its word only inside the column, where nothing else says it. */
const PHRASES = WITHHELD.filter(([, says]) => says !== "drop").map(([, says]) => says);

const proofs = [node("task_test", 9, { label: "the page is served", state: "passed" })];
const record = [deep([task(8, { label: "wire the route", state: "in_progress", children: proofs })])];

/** Every shape the right-hand column takes, so the withholding is proved on all of them
 *  rather than on the one and assumed of the rest. A reader reaches each by following an
 *  ordinary link: a task, a link that has gone stale, a target that names no number, a
 *  narrowing that admits nothing, and a workspace with no task in it yet. */
const COLUMNS: readonly (readonly [string, string])[] = [
  ["a task selected", columnOf(tasksInbox(record, at("?task=8")))],
  ["a stale link", columnOf(tasksInbox(record, at("?task=404")))],
  ["a target naming nothing", columnOf(tasksInbox(record, at("?task=nine")))],
  ["a filter admitting nothing", columnOf(tasksInbox(record, at("?project=nowhere")))],
  ["a record holding no task", columnOf(tasksInbox([deep([])], at()))],
];

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("the four controls the definition declares are not drawn", () => {
  it("draws none of the four, by its id, beside the task they would act on", () => {
    const body = tasksInbox(record, at("?task=8"));
    for (const [id] of WITHHELD) expect(body, id).not.toContain(`data-ui="${id}"`);
  });

  it("says none of their words either, so none of them is drawn under some other name", () => {
    const page = tasksPage(record, at("?task=8")).body;
    for (const says of PHRASES) expect(page, says).not.toContain(says);
    expect(columnOf(page)).not.toContain("drop");
  });

  it("draws none of them in any shape the column takes, not only the one with a task in it", () => {
    for (const [when, column] of COLUMNS) {
      for (const [id] of WITHHELD) expect(column, `${id} with ${when}`).not.toContain(id);
    }
  });

  /** The ids are withheld and so is anything that would act without one: a control drawn
   *  bare, before the definition's name was hung on it, is the same undecided verb. */
  it("puts no verb of any kind in the column, named or unnamed", () => {
    for (const [when, column] of COLUMNS) {
      for (const verb of ["<form", "<button", "<input", "<select", "<textarea", "onclick", "method="]) {
        expect(column, `${verb} with ${when}`).not.toContain(verb);
      }
    }
  });

  it("offers not even a link out of the column, which is how a verb would arrive as a GET", () => {
    for (const [when, column] of COLUMNS) expect(column, when).not.toContain("<a ");
  });

  /** Every rule above is a `not.toContain` over a slice, and a slice that missed would
   *  satisfy all of them saying nothing. So each is checked to be the column it names. */
  it("is reading a column and not an empty string in each of the five", () => {
    expect(COLUMNS).toHaveLength(5);
    for (const [when, column] of COLUMNS) {
      expect(column, when).toMatch(/^(<section class="detail"|<p class="empty">)/);
      expect(column, when).toContain("</section>");
    }
  });
});

describe("nothing is served for them either", () => {
  it("answers a post to the page with a 405, so the four are absent and not merely unlabelled", async () => {
    const server = await serve({ "/tasks": tasksAt(() => record) });
    servers.push(server);
    const res = await fetch(`${addressOf(server)}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "id=8&action=retry",
    });
    expect(res.status).toBe(405);
    expect(await res.text()).toContain("POST is not served at /tasks");
  });

  it("serves a document the four are missing from, so none is drawn only over a socket", async () => {
    const server = await serve({ "/tasks": tasksAt(() => record) });
    servers.push(server);
    const body = await (await fetch(`${addressOf(server)}/tasks?task=8`)).text();
    expect(body).toContain(`id="detail-8"`);
    for (const [id] of WITHHELD) expect(body, id).not.toContain(id);
    for (const says of PHRASES) expect(body, says).not.toContain(says);
  });
});
