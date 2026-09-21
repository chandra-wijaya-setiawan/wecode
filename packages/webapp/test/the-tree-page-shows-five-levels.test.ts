/** The tree page: the record as nested lists, cut to the five levels that are work.
 *
 *  The nodes are hand-made rather than read out of a workspace, for the reason the board's
 *  and the decisions page's rows are: what is held here is the page and the transport, and
 *  that the tree is the record's shape is `@wecode/core`'s `tree()` and is tested where
 *  that function lives.
 *
 *  Two things this file exists for. The first is that the depth is the design's: the five
 *  levels are read off `shared.outline.levels` in design.yaml and not off this page, so an
 *  edited design moves the page. The second is that the omitted levels are *gone* rather
 *  than folded — a task hangs under its story even though the record puts a requirement,
 *  a criterion and an acceptance test in between. */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Rollup } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, answer, serve } from "../src/index.js";
import { discovered, mounted, pathOf } from "../src/pages/discover.js";
import {
  loadLevels,
  shown,
  treeAt,
  treeBranches,
  treePage,
  TreeDesignError,
} from "../src/pages/tree.js";

const DESIGN = fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url));
const TEXT = readFileSync(DESIGN, "utf8");
const LEVELS = loadLevels();

/** The design file with one edit, written somewhere else. Reading the levels back out of a
 *  copy is the only way to say the page came from the file: an assertion against the real
 *  config cannot tell a reader from a literal that happens to agree with it. */
function edited(from: string, to: string): string {
  expect(TEXT, from).toContain(from);
  const at = join(mkdtempSync(join(tmpdir(), "wecode-tree-")), "design.yaml");
  writeFileSync(at, TEXT.replace(from, to));
  return at;
}

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

/** A record five levels deep with the four proof levels in between, as the ledger keeps
 *  it: project → release → epic → story → requirement → criteria → acceptance test →
 *  task. */
const deepTask = (task: Node = node("task", 8)): Node =>
  node("project", 1, {
    children: [
      node("release", 2, {
        children: [
          node("epic", 3, {
            children: [
              node("story", 4, {
                children: [
                  node("requirement", 5, {
                    children: [
                      node("acceptance_criteria", 6, {
                        children: [node("acceptance_test", 7, { children: [task] })],
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

/** The `<li>` of one node, without its descendants' rows — an assertion about a row is not
 *  an assertion about the tree under it. */
function rowOf(body: string, entity: string, id: number): string {
  const at = body.indexOf(`<li id="${entity}-${id}">`);
  expect(at, `the page has no row for ${entity} #${id}`).toBeGreaterThan(-1);
  const rest = body.slice(at);
  const ends = rest.indexOf("<ul>");
  return ends === -1 ? rest.slice(0, rest.indexOf("</li>")) : rest.slice(0, ends);
}

/** How deep a node's row sits in nested lists, counted in `<ul>`s open above it. */
function nesting(body: string, entity: string, id: number): number {
  const before = body.slice(0, body.indexOf(`<li id="${entity}-${id}">`));
  return [...before.matchAll(/<ul/g)].length - [...before.matchAll(/<\/ul>/g)].length;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("how deep the tree goes is the design's", () => {
  it("shows the five levels that are work", () => {
    expect(LEVELS.shows).toEqual(["project", "release", "epic", "story", "task"]);
    expect(LEVELS.shows).toHaveLength(5);
  });

  it("omits the four levels that are proof", () => {
    expect(LEVELS.omits).toEqual([
      "requirement",
      "acceptance_criteria",
      "acceptance_test",
      "task_test",
    ]);
  });

  it("moves when the design moves", () => {
    const at = edited(
      "      shows: [project, release, epic, story, task]",
      "      shows: [project, epic, story, task]",
    );
    const moved = loadLevels(at);
    expect(moved.shows).toEqual(["project", "epic", "story", "task"]);
    // A level named by neither list is still drawn: a row nobody decided about is kept.
    const body = treeBranches([deepTask()], moved);
    expect(body).toContain(`<li id="release-2">`);
  });

  it("refuses a design that declares no levels, and names what is missing", () => {
    const at = edited("      shows: [project, release, epic, story, task]", "");
    expect(() => loadLevels(at)).toThrow(TreeDesignError);
    expect(() => loadLevels(at)).toThrow(/no shows/);
  });
});

describe("the omitted levels are gone, not folded", () => {
  const roots = shown([deepTask()]);

  it("hangs a task under the story it is work on", () => {
    const story = roots[0]?.children[0]?.children[0]?.children[0];
    expect(story?.entity).toBe("story");
    expect(story?.children.map((c) => c.entity)).toEqual(["task"]);
  });

  it("leaves no row of a proof level anywhere in the page", () => {
    const body = treeBranches([deepTask()]);
    for (const omitted of LEVELS.omits) expect(body).not.toContain(`<li id="${omitted}-`);
  });

  it("keeps a task that hangs under another task's proof", () => {
    const body = treeBranches([deepTask(node("task", 8, {
      children: [node("task_test", 9)],
    }))]);
    expect(body).toContain(`<li id="task-8">`);
    expect(body).not.toContain(`<li id="task_test-9">`);
  });
});

describe("the tree is nested lists, five deep", () => {
  const body = treeBranches([deepTask()]);

  it("opens one list for the roots and one per level under them", () => {
    expect(body).toContain(`<ul class="tree">`);
    expect(nesting(body, "project", 1)).toBe(1);
    expect(nesting(body, "release", 2)).toBe(2);
    expect(nesting(body, "epic", 3)).toBe(3);
    expect(nesting(body, "story", 4)).toBe(4);
    expect(nesting(body, "task", 8)).toBe(5);
  });

  it("closes every list it opens", () => {
    expect([...body.matchAll(/<ul/g)]).toHaveLength([...body.matchAll(/<\/ul>/g)].length);
    expect([...body.matchAll(/<li/g)]).toHaveLength([...body.matchAll(/<\/li>/g)].length);
  });

  it("draws sibling roots as separate trees in the one list", () => {
    const two = treeBranches([node("project", 1), node("project", 2)]);
    expect(nesting(two, "project", 1)).toBe(1);
    expect(nesting(two, "project", 2)).toBe(1);
    expect([...two.matchAll(/<ul/g)]).toHaveLength(1);
  });

  it("says so rather than coming back blank when the record is empty", () => {
    expect(treeBranches([])).toBe(`<p class="empty">nothing in the record yet</p>`);
  });
});

describe("a row is a sentence", () => {
  it("leads with the label, then the id, the kind and the state", () => {
    const body = treeBranches([node("story", 4, { label: "ship the tree page" })]);
    expect(rowOf(body, "story", 4)).toContain(
      `<span class="label">ship the tree page</span> · ` +
        `<span class="id">#4</span> · <span class="kind">story</span> · ` +
        `<span class="state">planned</span>`,
    );
  });

  it("says what hangs under a row, and never says a bucket at nothing", () => {
    const counts = { done: 3, open: 1, failed: 0 };
    const body = treeBranches([node("epic", 3, { rollup: counts })]);
    expect(rowOf(body, "epic", 3)).toContain(`<span class="rollup">3 done, 1 open</span>`);
    expect(rowOf(body, "epic", 3)).not.toContain("failed");
  });

  it("drops the rollup with its separator when nothing hangs under the row", () => {
    const body = treeBranches([node("task", 8)]);
    expect(rowOf(body, "task", 8).endsWith(`<span class="state">planned</span>`)).toBe(true);
    expect(rowOf(body, "task", 8)).not.toContain("rollup");
  });

  it("carries no fold marker — a nested list is already open", () => {
    const body = treeBranches([deepTask()]);
    expect(rowOf(body, "project", 1)).not.toMatch(/[-+]\s*<span class="label"/);
  });

  it("writes a person's own words as words and not as markup", () => {
    const body = treeBranches([node("story", 4, { label: `a <script> & "quotes"` })]);
    expect(body).not.toContain("<script>");
    expect(rowOf(body, "story", 4)).toContain("a &lt;script&gt; &amp; &quot;quotes&quot;");
  });
});

describe("the page is served in the shell", () => {
  it("answers /tree with an html document in the shell", async () => {
    const server = await serve({ "/tree": treeAt(() => [deepTask()]) });
    servers.push(server);
    const res = await fetch(`${addressOf(server)}/tree`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain("<title>wecode</title>");
    // Its tree is inside the shell's one element, not beside it.
    const inside = body.slice(body.indexOf("<main>"), body.indexOf("</main>"));
    expect(inside).toContain(`<li id="task-8">`);
    expect(body).toBe(treePage([deepTask()]).body);
  });

  it("reads the record again on every request", async () => {
    let nodes: readonly Node[] = [];
    const server = await serve({ "/tree": treeAt(() => nodes) });
    servers.push(server);
    expect(await (await fetch(`${addressOf(server)}/tree`)).text()).toContain(
      "nothing in the record yet",
    );
    nodes = [node("project", 1)];
    expect(await (await fetch(`${addressOf(server)}/tree`)).text()).toContain(
      `<li id="project-1">`,
    );
  });

  it("offers no verb, because every verb that changes wecode is the cli's", async () => {
    const body = treePage([deepTask()]).body;
    for (const verb of ["<form", "<button", "<input", "onclick"]) {
      expect(body, `the tree page offers ${verb}`).not.toContain(verb);
    }
  });
});

/** The wiring is the file. `bin.ts` carried a route per page once; discovery replaced that
 *  table, so what is held here is the file being under `pages/`, answering at `/tree`, and
 *  being handed the record — and `bin.ts` naming none of it. */
describe("the surface routes it", () => {
  const BIN = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");
  const PAGES = fileURLToPath(new URL("../src/pages", import.meta.url));

  it("binds /tree to the page, reading the record through core's tree()", async () => {
    expect(discovered(readdirSync(PAGES))).toContain("tree");
    expect(pathOf("tree")).toBe("/tree");

    const record = node("project", 1, { label: "the whole record" });
    const module = (await import("../src/pages/tree.js")) as Record<string, unknown>;
    const routes = { [pathOf("tree")]: mounted("tree", module, { record: () => [record] }) };
    const reply = answer(routes, "GET", "/tree");
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("the whole record");
  });

  it("leaves the board where it was", () => {
    expect(discovered(readdirSync(PAGES))).toContain("board");
    expect(pathOf("board")).toBe("/");
  });

  it("is not named in bin.ts, because no page is", () => {
    expect(BIN).not.toContain("treeAt");
    expect(BIN).not.toContain("pages/tree");
  });
});
