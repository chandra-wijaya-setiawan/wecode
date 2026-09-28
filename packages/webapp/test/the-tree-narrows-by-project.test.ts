/** The tree narrowed to one project, proven off the served `/tree`.
 *
 *  Sketch #7 — `~/.wecode/workspaces/cws/sketches/the-tree-you-can-read.html`, signed in review
 *  — settles what this is: project, release and epic are where a story *lives* rather than what
 *  anybody works on, so they narrow the tree from above it instead of nesting rungs inside it.
 *  The sketch draws that as one `<select>` in the bar whose answers are the projects' own slugs
 *  and whose first answer is all of them, which is the shape the `show` filter beside it already
 *  has: a select in a `method=get` form, because a select goes nowhere until something submits
 *  it and this page has no script to send it.
 *
 *  Four claims, one `describe` each. The control is `packages/webapp/config/ui.yaml`'s and the
 *  page carries the name the file gives it — read back out of an *edited* copy of that file,
 *  because a literal agreeing with a declaration proves only that two files were written the
 *  same afternoon. `/tree?project=<slug>` serves that project's rows and no other's, and an
 *  absent parameter serves them all. The project choice and the `show` answer hold at once and
 *  each survives the other's submission, so a reader who narrows to a project and then asks for
 *  the finished work is still in the project they were in. And a row's trailing column is its
 *  own state: four spans, three separators, and nothing after the last one — no rollup count,
 *  no role, nothing.
 *
 *  Which block of `ui.yaml` holds the declaration is the declaration's own business, so it is
 *  found by the parameter the criterion fixes — `project` — rather than by a key spelled here.
 *  The addresses are fetched off a running surface rather than read off `treeSection`, because
 *  the claim is about what a reader is sent and about a link they could have typed. The nodes
 *  are hand-made, for the reason the rest of this package's page tests make theirs: what is
 *  held here is the page, and that the tree is the record's shape is `@wecode/core`'s. Their
 *  project labels are slugs, which is what the record's own are. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Rollup } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, serve } from "../src/index.js";
import { loadUi, shown, treeAt, type Ui } from "../src/pages/tree.js";

/** The parameter the criterion fixes, and what travels in it: a project's own slug, so that
 *  `/tree?project=wecode` is a link a person can send, bookmark and type. */
const PARAM = "project";

const UI = fileURLToPath(new URL("../config/ui.yaml", import.meta.url));
const here = createRequire(import.meta.url);
const { parse } = createRequire(here.resolve("@wecode/tui"))("yaml") as { parse: (t: string) => unknown };

const mapOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The one control `tree:` declares on the project parameter: the `data-ui` name the page
 *  carries it into the markup by, and the word the reader is offered it under. Found by the
 *  parameter rather than by a key, because where under `tree:` the declaration sits is a
 *  decision about the file and the parameter is a decision about the address. */
interface Control { readonly id: string; readonly says: string }
function declared(text: string = readFileSync(UI, "utf8")): Control {
  const found: Record<string, unknown>[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const e of v) walk(e); return; }
    const said = mapOf(v);
    if (said["param"] === PARAM) found.push(said);
    for (const kid of Object.values(said)) if (kid !== null && typeof kid === "object") walk(kid);
  };
  walk(mapOf(mapOf(parse(text))["tree"]));
  expect(found.length, `ui.yaml declares ${found.length} tree controls on ?${PARAM}=, not one`).toBe(1);
  const said = found[0] as Record<string, unknown>;
  for (const key of ["id", "says"])
    expect(typeof said[key] === "string" && said[key] !== "", `the project control says no ${key}`).toBe(true);
  return { id: said["id"] as string, says: said["says"] as string };
}

/** Counts nobody asked for, in numbers that appear nowhere else on this page, so a rollup drawn
 *  in a row is a rollup this test can name rather than a digit it has to argue about. */
const NONE: Rollup = { done: 0, open: 0, failed: 0 };
const PLENTY: Rollup = { done: 907, open: 771, failed: 839 };
const COUNTS = ["907", "771", "839"];

const node = (entity: string, id: number, over: Partial<Node> = {}): Node =>
  ({ entity, id, label: `${entity} ${id}`, state: "in_progress", children: [], rollup: NONE, folded: false, ...over });
const under = (entity: string, id: number, kid: Node): Node => node(entity, id, { children: [kid] });
const projectOf = (id: number, slug: string, kid: Node): Node =>
  node("project", id, { label: slug, rollup: PLENTY, children: [kid] });

/** Three projects, because narrowing to the middle of three is the reading that a filter which
 *  keeps the first, or drops only the named one, cannot pass. Two of the slugs share a prefix,
 *  so a slug matched by its beginning rather than whole is a slug matched wrong. Every project
 *  has work still owed under it, so the `show` answer never empties the list of projects and the
 *  two narrowings can be read apart. One project also holds finished work, which is what makes
 *  `show=all` say something different from `show=open` inside a single project. */
const WECODE = projectOf(1, "wecode", under("release", 2, node("epic", 3, { children: [
  node("story", 4, { rollup: PLENTY, children: [node("task", 5, { state: "done" })] }),
  node("story", 6, { state: "delivered" }),
] })));
const WEB = projectOf(7, "wecode-web", under("release", 8, under("epic", 9, node("story", 10, { state: "planned" }))));
const CONDUIT = projectOf(11, "conduit-realworld",
  under("release", 12, under("epic", 13, under("story", 14, node("task", 15, { state: "failed" })))));
const RECORD: readonly Node[] = [WECODE, WEB, CONDUIT];
const SLUGS = RECORD.map((p) => p.label);

/** Every row a record draws, parents before what hangs under them: the order the document
 *  holds them in, each named the way its `<li>` is. */
const keysOf = (ns: readonly Node[]): readonly string[] =>
  ns.flatMap((n) => [`${n.entity}-${n.id}`, ...keysOf(n.children)]);
/** The same, thinned the way the page thins it: the tree is anchored at the story, so the
 *  three rungs above it and the requirement are not rows. Taken from `shown` rather than
 *  listed here, so these expectations move when the design does. */
const drawnKeys = (ns: readonly Node[]): readonly string[] => keysOf(shown(ns));
/** What is still owed under wecode, as the page draws it. The tree is anchored at the story,
 *  so the project, release and epic above it are not rows — which project a reader is looking
 *  at is the picker's answer, asked once, rather than three rungs answering on every row. The
 *  done task and the delivered story are out; the story above the done task stays, being work
 *  still owed itself. */
const OPEN_WECODE = ["story-4", "story-10", "task-11", "acceptance_criteria-12"];

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((done) => s.close(done)); });

/** A running surface holding one record, and a way of asking it for an address — either a query
 *  written here or the whole address a form said it would land on. */
async function serving(record: readonly Node[] = RECORD, ui?: Ui): Promise<(at: string) => Promise<string>> {
  const server = await serve({ "/tree": treeAt(() => record, undefined, ui) });
  servers.push(server);
  return async (at) => await (await fetch(`${addressOf(server)}${at.startsWith("/") ? at : `/tree${at}`}`)).text();
}

/** An attribute's value as the markup carries it, back in the words it was written in. */
const plain = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, `"`).replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const rowsOf = (body: string): readonly string[] =>
  [...body.matchAll(/<li id="([^"]+)" data-ui="tree\.node">/g)].map((m) => m[1] as string);
/** One row's own markup, which ends where the list of what hangs under it begins. */
function rowOf(body: string, key: string): string {
  const found = body.indexOf(`<li id="${key}" `);
  expect(found, `the page has no row for ${key}`).toBeGreaterThan(-1);
  const rest = body.slice(found);
  const ends = ["<ul>", "</li>"].map((t) => rest.indexOf(t)).filter((i) => i > -1);
  return rest.slice(0, Math.min(...ends));
}
const listOf = (body: string): string =>
  body.slice(body.indexOf(`<ul class="tree">`), body.lastIndexOf("</ul>") + "</ul>".length);

/** One select of a form: what it is named in the address, which answer it is holding shut, and
 *  the answers it offers as a value and the words a reader picks it by. */
interface Select { readonly name: string; readonly held: string; readonly answers: readonly (readonly [string, string])[] }
const valued = (tag: string): string => plain(/value="([^"]*)"/.exec(tag)?.[1] ?? "");
function selectsOf(form: string): readonly Select[] {
  return [...form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].map((m) => {
    const inner = m[2] as string;
    const answers = [...inner.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)]
      .map((o) => [valued(o[1] as string), plain(o[2] as string)] as const);
    const held = [...inner.matchAll(/<option\b([^>]*)>/g)].find((o) => / selected/.test(o[1] as string));
    return {
      name: plain(/name="([^"]*)"/.exec(m[1] as string)?.[1] ?? ""),
      held: held === undefined ? (answers[0]?.[0] ?? "") : valued(held[1] as string),
      answers,
    };
  });
}
const formsOf = (body: string): readonly string[] => [...body.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((m) => m[0]);
/** The one form of the page that offers an answer to this parameter. */
function formWith(body: string, param: string): string {
  const found = formsOf(body).filter((f) => selectsOf(f).some((s) => s.name === param));
  expect(found.length, `the page offers ${found.length} controls named ${param}, not one`).toBe(1);
  return found[0] as string;
}
const controlOf = (body: string, param: string): Select =>
  selectsOf(formWith(body, param)).find((s) => s.name === param) as Select;

/** Where a browser lands on changing one answer of the page's own form and pressing its submit:
 *  the form's action, its hidden fields in the order they are written, and every select it
 *  holds — the one changed at the value picked, the rest exactly as the page is holding them.
 *  No script is consulted, because a `get` form has none; this is the whole mechanism, and it
 *  is what makes a narrowed tree an address the reader could have typed. */
function submits(body: string, param: string, value: string): string {
  const form = formWith(body, param);
  expect(form, `the control named ${param} is not in a get form`).toContain(`method="get"`);
  const query = new URLSearchParams();
  const answers = selectsOf(form).map((s) => s.name);
  for (const m of form.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
    const name = plain(m[1] as string);
    // A field that repeats a name the form already answers is sent twice, and a reader who
    // picks one thing arrives asking for two: the select's field is the field for that one.
    expect(answers, `${name} is both a hidden field and an answer of the same form`).not.toContain(name);
    query.append(name, plain(m[2] as string));
  }
  for (const s of selectsOf(form)) {
    if (s.name === param) expect(s.answers.map(([v]) => v), `no answer of ${param} is ${value}`).toContain(value);
    query.set(s.name, s.name === param ? value : s.held);
  }
  return `${plain(/action="([^"]*)"/.exec(form)?.[1] as string)}?${query}`;
}
/** An address as what it asks for rather than as a string: the path, and the query as pairs in
 *  a settled order, because which field a form writes first is the markup's business. */
const asked = (address: string): readonly unknown[] => {
  const url = new URL(address, "http://localhost");
  return [url.pathname, [...url.searchParams].sort()];
};

describe("the project control is the declaration's, and the page carries the declared name", () => {
  it("declares one control on the project parameter, beside the show filter rather than over it", () => {
    const control = declared();
    expect(control.id, "a data-ui name is a dotted name the markup can carry").toMatch(/^[a-z][\w-]*(\.[\w-]+)+$/);
    // Beside, not instead of: the reading the page already had is untouched, and the two
    // controls are two names, so a page carrying one is not a page carrying both.
    const { filter } = loadUi();
    expect([filter.param, filter.default], "the show filter moved").toEqual(["show", "open"]);
    expect(filter.options.map((o) => o.value), "the show filter's answers moved").toEqual(["open", "all"]);
    expect([control.id, ...filter.options.map((o) => o.id)].includes(filter.id),
      "the project control is the show filter under another name").toBe(false);
  });
  it("draws one element under the declared name, on the control that sends the project", async () => {
    const control = declared();
    const body = await (await serving())("?show=all");
    const marks = [...body.matchAll(new RegExp(`data-ui="${control.id.replace(/\./g, "\\.")}"`, "g"))];
    expect(marks.length, `the page draws ${marks.length} of ${control.id}, not one`).toBe(1);
    // On the control itself or on what holds it, and in the form that sends the project: a
    // declared name carried somewhere else on the page names nothing the reader can use.
    const form = formWith(body, PARAM);
    expect(form, `${control.id} is not on the form that sends the project`).toContain(`data-ui="${control.id}"`);
    const select = /<select name="project"[^>]*>/.exec(form) as RegExpExecArray;
    expect(form.indexOf(`data-ui="${control.id}"`),
      "the declared name is on neither the control nor what holds it").toBeLessThan(select.index + select[0].length);
    expect(plain(body), "the word the declaration gives the control").toContain(control.says);
  });
  /** Read back out of an edited copy of the file: a page with the name written into it passes an
   *  assertion that the name is there, and fails the moment the declaration is restated. */
  it("carries the name the declaration gives the control, and moves when the declaration moves", async () => {
    const text = readFileSync(UI, "utf8");
    const said = declared(text).id;
    const moved = "tree.narrowing-declared-elsewhere";
    const path = join(mkdtempSync(join(tmpdir(), "wecode-project-")), "ui.yaml");
    writeFileSync(path, text.split(said).join(moved));
    expect(declared(readFileSync(path, "utf8")).id, "the edited copy declares something else").toBe(moved);
    const body = await (await serving(RECORD, loadUi(path)))("?show=all");
    expect(body, "the page does not carry the name the declaration gives the control").toContain(`data-ui="${moved}"`);
    expect(body, "the page carries a name the declaration no longer gives it").not.toContain(`data-ui="${said}"`);
  });
});

describe("/tree?project=<slug> serves that project's rows, and an absent one serves them all", () => {
  it("serves one project for the slug the query names, and every project when it names none", async () => {
    const get = await serving();
    expect(rowsOf(await get("?show=all")), "an absent parameter narrowed the record").toEqual(drawnKeys(RECORD));
    for (const p of RECORD)
      expect(rowsOf(await get(`?${PARAM}=${p.label}&show=all`)), p.label).toEqual(drawnKeys([p]));
    // A slug is matched whole: `wecode` is not `wecode-web`, however the two are spelled.
    const one = await get(`?${PARAM}=wecode&show=all`);
    for (const key of [...keysOf([WEB]), ...keysOf([CONDUIT])])
      expect(rowsOf(one), `narrowing to wecode kept ${key}`).not.toContain(key);
    // And the narrowing is not a door that shuts behind the reader: every project is still an
    // answer the control offers, so the one they are in is not the only one they can reach.
    expect(controlOf(one, PARAM).answers.map(([v]) => v), "a narrowed page forgets the other projects")
      .toEqual(expect.arrayContaining([...SLUGS]));
    expect(controlOf(one, PARAM).held, "the page does not say which project it is narrowed to").toBe("wecode");
  });
  it("offers one answer a project and one that gives the rest back, and lands where each says", async () => {
    const get = await serving();
    const body = await get("?show=all");
    const control = controlOf(body, PARAM);
    const named = control.answers.filter(([v]) => SLUGS.includes(v));
    expect(named.map(([v]) => v), "the answers are not the record's projects, by their slugs").toEqual([...SLUGS]);
    for (const [v, says] of named) expect(says, `the answer ${v} does not name its project`).toContain(v);
    const rest = control.answers.filter(([v]) => !SLUGS.includes(v));
    expect(rest.length, `${rest.length} answers name no project, not one — the reader cannot get the rest back`).toBe(1);
    // Every answer is an address, and the address is what it said it was: picked, submitted and
    // fetched, with no browser and no script anywhere in it.
    for (const [v] of named)
      expect(rowsOf(await get(submits(body, PARAM, v))), v).toEqual(drawnKeys([RECORD.find((p) => p.label === v) as Node]));
    expect(rowsOf(await get(submits(body, PARAM, (rest[0] as readonly [string, string])[0]))),
      "the answer that names no project does not give the record back").toEqual(drawnKeys(RECORD));
    for (const v of ["<script", "onchange", "onclick", "onsubmit", "data-href", "javascript:"])
      expect(body, v).not.toContain(v);
    // A form left open takes every field after it with it, so which answers a control sends
    // stops being something the markup says.
    expect([...body.matchAll(/<form\b/g)].length, "the page leaves a form open")
      .toBe([...body.matchAll(/<\/form>/g)].length);
  });
});

describe("the project choice survives alongside the show filter", () => {
  it("narrows on both at once, in either order, and keeps each across the other's submission", async () => {
    const get = await serving();
    // Two axes, and each one narrows: the project alone leaves what is still owed under it, and
    // the project with `show=all` leaves the whole of that project and no other.
    expect(rowsOf(await get(`?${PARAM}=wecode`)), "the show default stopped applying").toEqual(OPEN_WECODE);
    for (const q of [`?${PARAM}=wecode&show=all`, `?show=all&${PARAM}=wecode`])
      expect(rowsOf(await get(q)), q).toEqual(drawnKeys([WECODE]));
    expect(rowsOf(await get(`?show=open&${PARAM}=conduit-realworld`))).toEqual(drawnKeys([CONDUIT]));
    // Asking for the finished work keeps the reader in the project they were reading: the state
    // answer is changed on the page's own form, and the project rides along with it.
    const narrow = await get(`?${PARAM}=wecode`);
    const widened = submits(narrow, "show", "all");
    expect(asked(widened), "widening the states threw the project away")
      .toEqual(["/tree", [[PARAM, "wecode"], ["show", "all"]]]);
    expect(rowsOf(await get(widened))).toEqual(drawnKeys([WECODE]));
    // And the other way round: picking a project keeps the states the reader had asked for.
    const all = await get("?show=all");
    const picked = submits(all, PARAM, "wecode-web");
    expect(asked(picked), "picking a project threw the state answer away")
      .toEqual(["/tree", [[PARAM, "wecode-web"], ["show", "all"]]]);
    expect(rowsOf(await get(picked))).toEqual(keysOf([WEB]));
    // Both answers are what the page is holding shut, so it says both without being opened.
    const both = await get(picked);
    expect([controlOf(both, PARAM).held, controlOf(both, "show").held]).toEqual(["wecode-web", "all"]);
    // Nothing else the reader arrived with is thrown away either.
    const kept = await get(`?${PARAM}=wecode&from=board`);
    expect(asked(submits(kept, "show", "all")))
      .toEqual(["/tree", [["from", "board"], [PARAM, "wecode"], ["show", "all"]]]);
  });
  it("says a narrowing left nothing rather than that the record is empty, and keeps the control", async () => {
    const get = await serving([node("project", 21, { label: "wemail", state: "dropped",
      children: [node("story", 22, { state: "delivered" })] })]);
    const none = await get(`?${PARAM}=wemail`);
    expect([rowsOf(none).length, none.includes("nothing in the record yet")],
      "a record narrowed to nothing reads as a record with nothing in it").toEqual([0, false]);
    // The one control a reader must have in order to undo it is still on the page.
    expect(controlOf(none, PARAM).answers.map(([v]) => v), "the control that would undo it is gone")
      .toContain("wemail");
  });
});

describe("a row's trailing column carries its state and nothing else", () => {
  it("ends every row at one state span, holding that row's own state and no other's", async () => {
    const body = await (await serving())("?show=all");
    const states = new Map<string, string>();
    const walk = (ns: readonly Node[]): void => {
      for (const n of ns) { states.set(`${n.entity}-${n.id}`, n.state); walk(n.children); }
    };
    walk(RECORD);
    expect(rowsOf(body), "the page draws other rows than the record gave it").toEqual(drawnKeys(RECORD));
    for (const key of rowsOf(body)) {
      const row = rowOf(body, key);
      // Four parts, in the design's order, and the state is the last of them — on a leaf and on
      // a row with a whole project under it alike.
      expect([...row.matchAll(/<span [^>]*class="([a-z]+)"/g)].map((m) => m[1]), key)
        .toEqual(["kind", "id", "label", "state"]);
      expect(/<span [^>]*class="state">([^<]*)<\/span>/.exec(row)?.[1], `${key} does not end at its own state`)
        .toBe(states.get(key));
      // They are columns and not a sentence, so nothing joins them: a separator anywhere in a
      // row is the four columns run back together into one line of prose.
      expect([...row.matchAll(/ · /g)].length, `${key} joins its parts into a sentence`).toBe(0);
      const after = row.slice(row.lastIndexOf("</span>") + "</span>".length);
      expect(after.replace("</summary>", "").replace("</div>", ""), `${key} carries something after its state`).toBe("");
    }
  });
  it("counts nothing under a row and names nobody at it: no rollup, no role", async () => {
    const body = await (await serving())("?show=all");
    // The rollup is what used to trail the state — how many done, open and failed hang under the
    // row — and it was a second answer to the question the tree already answers by being a tree.
    // Three rows are given counts nobody could mistake for anything else on the page.
    for (const key of ["story-4", "task-5"]) {
      const row = rowOf(body, key);
      for (const said of [...COUNTS, `class="rollup"`, `class="role"`, "data-role", "rollup"])
        expect(row, `${key} carries ${said}`).not.toContain(said);
    }
    // And nowhere else in the tree either: a count moved off the row is still a count drawn.
    for (const said of [...COUNTS, "rollup"]) expect(listOf(body), said).not.toContain(said);
  });
});
