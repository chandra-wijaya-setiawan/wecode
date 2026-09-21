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
 *  a criterion and an acceptance test in between.
 *
 *  The parts the page draws around that tree — the section, the filter row and its chips —
 *  are `packages/webapp/config/ui.yaml`'s, and are held to it by the `data-ui` name each
 *  one carries. */
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
  type Chip,
  chipHref,
  chips,
  loadLevels,
  narrowed,
  shown,
  treeAt,
  treeBranches,
  treePage,
  treeSection,
  TreeDesignError,
} from "../src/pages/tree.js";

const at = (query = ""): URL => new URL(`http://localhost/tree${query}`);

function drawn(body: string, name: string): string {
  const found = [...body.matchAll(new RegExp(`<[a-z0-9]+([^>]*\\bdata-ui="${name}"[^>]*)>`, "g"))];
  expect(found.length, `the page draws ${found.length} of ${name}, not one`).toBe(1);
  return (found[0] as RegExpMatchArray)[1] as string;
}

/** What the element with this `data-ui` name says — its own text, not its children's. */
function saysOf(body: string, name: string): string {
  const open = body.search(new RegExp(`<[a-z0-9]+[^>]*\\bdata-ui="${name}"[^>]*>`));
  expect(open, `the page draws no ${name}`).toBeGreaterThan(-1);
  const rest = body.slice(body.indexOf(">", open) + 1);
  return rest.slice(0, rest.search(/<|$/));
}

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

/** A record with the four proof levels in between, as the ledger keeps it. */
const under = (parent: Node, child: Node): Node => ({ ...parent, children: [child] });
const deepTask = (task: Node = node("task", 8)): Node =>
  [
    ["project", 1], ["release", 2], ["epic", 3], ["story", 4], ["requirement", 5],
    ["acceptance_criteria", 6], ["acceptance_test", 7],
  ].reduceRight<Node>((kid, [e, id]) => under(node(e as string, id as number), kid), task);

/** The `<li>` of one node, without its descendants' rows. */
function rowOf(body: string, entity: string, id: number): string {
  const at = body.indexOf(`<li id="${entity}-${id}" `);
  expect(at, `the page has no row for ${entity} #${id}`).toBeGreaterThan(-1);
  const rest = body.slice(at);
  const ends = rest.indexOf("<ul>");
  return ends === -1 ? rest.slice(0, rest.indexOf("</li>")) : rest.slice(0, ends);
}

/** How deep a node's row sits in nested lists, counted in `<ul>`s open above it. */
function nesting(body: string, entity: string, id: number): number {
  const before = body.slice(0, body.indexOf(`<li id="${entity}-${id}" `));
  return [...before.matchAll(/<ul/g)].length - [...before.matchAll(/<\/ul>/g)].length;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("how deep the tree goes is the design's", () => {
  it("shows the five levels that are work and omits the four that are proof", () => {
    expect(LEVELS.shows).toEqual(["project", "release", "epic", "story", "task"]);
    expect(LEVELS.omits).toEqual(
      ["requirement", "acceptance_criteria", "acceptance_test", "task_test"],
    );
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
    expect(body).toContain(`<li id="release-2" `);
  });

  it("refuses a design that declares no levels, and names what is missing", () => {
    const bare = edited("      shows: [project, release, epic, story, task]", "");
    expect(() => loadLevels(bare)).toThrow(TreeDesignError);
    expect(() => loadLevels(bare)).toThrow(/no shows/);
  });
});

describe("the omitted levels are gone, not folded", () => {
  const roots = shown([deepTask()]);

  it("hangs a task under the story it is work on", () => {
    const story = roots[0]?.children[0]?.children[0]?.children[0];
    expect(story?.entity).toBe("story");
    expect(story?.children.map((c) => c.entity)).toEqual(["task"]);
  });

  it("leaves no row of a proof level anywhere, and keeps a task under one", () => {
    const body = treeBranches([deepTask(node("task", 8, { children: [node("task_test", 9)] }))]);
    for (const omitted of LEVELS.omits) expect(body).not.toContain(`<li id="${omitted}-`);
    expect(body).toContain(`<li id="task-8" `);
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

  it("draws sibling roots as separate trees in the one list, and says so when empty", () => {
    const two = treeBranches([node("project", 1), node("project", 2)]);
    expect(nesting(two, "project", 1)).toBe(1);
    expect(nesting(two, "project", 2)).toBe(1);
    expect([...two.matchAll(/<ul/g)]).toHaveLength(1);
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

  it("says what hangs under a row, never a bucket at nothing, and nothing at all at zero", () => {
    const full = treeBranches([node("epic", 3, { rollup: { done: 3, open: 1, failed: 0 } })]);
    expect(rowOf(full, "epic", 3)).toContain(`<span class="rollup">3 done, 1 open</span>`);
    expect(rowOf(full, "epic", 3)).not.toContain("failed");
    const bare = treeBranches([node("task", 8)]);
    expect(rowOf(bare, "task", 8).endsWith(`<span class="state">planned</span>`)).toBe(true);
    expect(rowOf(bare, "task", 8)).not.toContain("rollup");
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
    expect(inside).toContain(`<li id="task-8" `);
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
      `<li id="project-1" `,
    );
  });

  it("offers no verb, because every verb that changes wecode is the cli's", async () => {
    const body = treePage([deepTask()]).body;
    for (const verb of ["<form", "<button", "<input", "onclick"]) {
      expect(body, `the tree page offers ${verb}`).not.toContain(verb);
    }
  });
});

/** The wiring is the file: under `pages/`, answering at `/tree`, handed the record — and
 *  `bin.ts` naming none of it. */
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

  it("leaves the board where it was, and is named in bin.ts no more than the board is", () => {
    expect(discovered(readdirSync(PAGES))).toContain("board");
    expect(pathOf("board")).toBe("/");
    expect(BIN).not.toContain("treeAt");
    expect(BIN).not.toContain("pages/tree");
  });
});

/** The page is more than its tree: `packages/webapp/config/ui.yaml` declares a section, a
 *  filter row, four chips on it and the row of a record, each by a dotted name. The names
 *  are carried into the markup as `data-ui`, so the declaration and the drawing are held
 *  against each other by name — an assertion on a class proves only that this file and that
 *  one were written on the same afternoon. The fold stays out: it is the operator's
 *  decision and it has not been taken. */
describe("the page draws every part the declaration names", () => {
  const body = treeSection([deepTask()], at());
  it("draws the section and the filter row under it, each saying what it is declared to", () => {
    expect(body).toContain(`<section class="tree" data-ui="tree"><h2>Tree</h2>`);
    expect(saysOf(body, "tree.filter")).toBe("filter:");
    expect(body.indexOf(`data-ui="tree.filter"`)).toBeGreaterThan(body.indexOf(`data-ui="tree"`));
  });

  it("draws the four chips in order, each saying its declared word", () => {
    expect([...body.matchAll(/data-ui="(tree\.filter\.[a-z-]+)"/g)].map((m) => m[1])).toEqual([
      "tree.filter.open", "tree.filter.project", "tree.filter.in-progress", "tree.filter.needs-me",
    ]);
    expect(saysOf(body, "tree.filter.open")).toBe("open");
    expect(saysOf(body, "tree.filter.in-progress")).toBe("+ in progress");
    expect(saysOf(body, "tree.filter.needs-me")).toBe("+ needs me");
  });

  it("says a project chip in the project's own words, one per project", () => {
    // `repeats`: the chip is drawn once per record, so its word is the record's own.
    const two = treeSection(
      [node("project", 1, { label: "wecode" }), node("project", 2, { label: "wemail" })],
      at(),
    );
    const said = [...two.matchAll(/data-ui="tree\.filter\.project" href="([^"]*)">([^<]*)</g)];
    expect(said.map((m) => m[2])).toEqual(["wecode", "wemail"]);
    expect(said.map((m) => m[1])).toEqual(["?project=1", "?project=2"]);
  });

  it("names every row of the record as the declaration's node", () => {
    expect([...body.matchAll(/data-ui="tree\.node"/g)]).toHaveLength(5);
    expect([...body.matchAll(/<li id="/g)]).toHaveLength(5);
    expect(body).toContain(`<li id="task-8" data-ui="tree.node">`);
  });

  it("draws no fold: not a marker on a row, and not a disclosure around one", () => {
    for (const fold of ["<details", "<summary", "aria-expanded", "folded"]) {
      expect(body, `the page draws ${fold}`).not.toContain(fold);
    }
    expect(body).not.toMatch(/[-+\u25b8\u25be]\s*<span class="label"/);
  });
});

describe("the chips are links that narrow through the query string", () => {
  const record = [deepTask(), node("project", 2, { label: "wemail" })];
  const chip = (param: string) => chips(record).find((c) => c.param === param) as Chip;
  it("puts a chip's own parameter on the query, and adds to what is already on", () => {
    expect(chipHref(at(), chip("open"))).toBe("?open=1");
    expect(chipHref(at("?open=1"), chip("in-progress"))).toBe("?open=1&in-progress=1");
  });

  it("takes a chip that is already on back off again", () => {
    expect(chipHref(at("?open=1&needs-me=1"), chip("open"))).toBe("?needs-me=1");
    expect(chipHref(at("?open=1"), chip("open"))).toBe("?");
  });

  it("marks the chips that are on, and offers every one as a link and never a control", () => {
    const body = treeSection(record, at("?open=1&project=2"));
    expect(drawn(body, "tree.filter.open")).toContain(`class="tag on"`);
    expect(drawn(body, "tree.filter.needs-me")).toContain(`class="tag"`);
    expect(body).toContain(`<a class="tag on" data-ui="tree.filter.project" href="?open=1">wemail</a>`);
    for (const verb of ["<form", "<button", "<input", "onclick"]) expect(body).not.toContain(verb);
  });
});

/** What each chip keeps. `open` is the machines' own answer — a state machines.yaml does
 *  not call terminal — the other two are read off the state names it declares. */
describe("a chip narrows the record it draws", () => {
  const record = [
    node("project", 1, { state: "in_progress", children: [
      node("story", 2, { state: "delivered" }),
      node("story", 3, { state: "on_hold" }),
      node("story", 4, { state: "in_progress", children: [node("task", 5, { state: "done" })] }),
    ] }),
    node("project", 6, { label: "wemail", state: "dropped" }),
  ];
  const ids = (nodes: readonly Node[]): readonly number[] =>
    nodes.flatMap((n) => [n.id, ...ids(n.children)]);
  it("keeps everything when nothing is asked for", () => {
    expect(ids(narrowed(record, at()))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("narrows to one project's own tree, whole", () => {
    expect(ids(narrowed(record, at("?project=1")))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(narrowed(record, at("?project=6")))).toEqual([6]);
  });

  it("drops the states the machines call terminal when `open` is on", () => {
    expect(ids(narrowed(record, at("?open=1")))).toEqual([1, 3, 4]);
  });

  it("keeps a row nothing matched when a kept row hangs under it", () => {
    const deep = [node("project", 1, { state: "released", children: [
      node("story", 2, { state: "in_progress" })] })];
    expect(ids(narrowed(deep, at("?open=1")))).toEqual([1, 2]);
  });

  it("keeps work under way, work that has stopped, and the chips added together", () => {
    expect(ids(narrowed(record, at("?in-progress=1")))).toEqual([1, 4]);
    expect(ids(narrowed(record, at("?needs-me=1")))).toEqual([1, 3]);
    expect(ids(narrowed(record, at("?project=1&needs-me=1")))).toEqual([1, 3]);
  });

  it("says the filter emptied the page rather than that the record is empty", () => {
    const body = treeSection([node("project", 6, { state: "dropped" })], at("?in-progress=1"));
    expect(body).toContain("nothing in the record matches this filter");
    expect(body).not.toContain("nothing in the record yet");
    // The chips survive it: a filter that narrowed to nothing is the one you must undo.
    expect(drawn(body, "tree.filter.in-progress")).toContain(`class="tag on"`);
    expect(treeSection([], at("?open=1"))).toContain("nothing in the record yet");
  });

  it("narrows the served page by the query a chip links to", async () => {
    const two = [node("project", 1, { label: "wecode" }), node("project", 2, { label: "wemail" })];
    const server = await serve({ "/tree": treeAt(() => two) });
    servers.push(server);
    const body = await (await fetch(`${addressOf(server)}/tree?project=2`)).text();
    expect(body).toContain(`<li id="project-2" data-ui="tree.node">`);
    expect(body).not.toContain(`<li id="project-1"`);
    expect(body).toBe(treePage(two, new URL("http://localhost/tree?project=2")).body);
  });
});
