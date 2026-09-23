/** The sketches page: everything drawn before it was work, as a list — and the one a reader
 *  opened, at full width, in a frame.
 *
 *  It is a page *found* under `src/pages/`, served from a reading of its own because a sketch
 *  hangs under nothing and `tree()`'s nodes carry no part of one — and whether that reading is
 *  offered is asked of the binary that ships, since the map in `bin.ts` is the thing in
 *  question. The bar's two acts *type* at the dock and send nothing, which is the whole design
 *  of them: it is proved against the real route with a stand-in shell on the far end, where a
 *  `keys` frame arrives as the words and nothing submits them. There is no new-sketch control,
 *  and its absence is stated rather than assumed. That the page wears the shell and is scoped
 *  where the design says are general statements elsewhere, which go green again the day this
 *  page is deleted — so what is particular to it is said here too, by hand. */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addSketch, open, sketches, type Sketch } from "@wecode/core";
import { decode } from "@wecode/painter/dist/client/terminal.js";
import { beforeAll, describe, expect, it } from "vitest";
import { tmp } from "../../core/test/tmpdir.js";
import { PageError, pages } from "../src/pages/discover.js";
import {
  CONTROLS, DOCKED, loadBanner, loadLook, SHELL_AT, shellAt, type Opens, type Shelled,
} from "../src/pages/shell.js";
import {
  clauseOf, FRAMES, framed, KIND, loadUi, opened, PARAM, READS, sketchesList, sketchesPage,
  SketchesUiError, stateOf, touched, typed,
} from "../src/pages/sketches.js";
import { answer } from "../src/server.js";

const UI = loadUi();
const LOOK = loadLook();
const RULES = LOOK.pages["sketches"] as Record<string, string>;
const UI_YAML = fileURLToPath(new URL("../config/ui.yaml", import.meta.url));
/** A fixed now, so the words for "when it was touched" are read rather than raced. */
const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const AGO = (ms: number): string => new Date(NOW - ms).toISOString();

const drawing = (id: number, over: Partial<Sketch> = {}): Sketch => ({
  id, name: `sketch ${id}`, kind: "ui", says: "one line saying what it is for", story_id: null,
  html: `/nowhere/sketch-${id}.html`, created_at: AGO(60_000), updated_at: AGO(60_000), ...over,
});

/** The page's markup at a target with the clock held still, one row of it, and the body of
 *  the one module script it carries. */
const listOf = (all: readonly Sketch[], query = ""): string =>
  sketchesList(all, new URL(`http://localhost/sketches${query}`), UI, NOW);

function rowOf(body: string, id: number): string {
  const at = body.indexOf(`<li id="sketch-${id}"`);
  expect(at, `no row for #${id}`).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("</li>", at));
}

function scriptOf(body: string): string {
  const tags = [...body.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  expect(tags, "the list carries no script, or more than one").toHaveLength(1);
  return (tags[0] as RegExpMatchArray)[1] as string;
}

type Act = (typeof UI.acts)[number];
const actNamed = (name: string): Act => {
  const found = UI.acts.find((a) => a.name === name);
  expect(found, `ui.yaml declares no ${name} act`).toBeDefined();
  return found as Act;
};

/** The declaration with one edit, written somewhere else: the only way to say the words came
 *  off the file rather than out of a constant that happens to agree with it. */
function edited(from: string, to: string): string {
  const text = readFileSync(UI_YAML, "utf8");
  expect(text, from).toContain(from);
  const at = join(tmp("wecode-sketches-ui-"), "ui.yaml");
  writeFileSync(at, text.replace(from, to));
  return at;
}
/** The readings `bin.ts` offers, spelled the way it spells them. */
const readings = { record: () => [], board: () => ({}), approvals: () => [], sketches: () => [] };

describe("the page is found under pages/, and served from a reading of its own", () => {
  it("asks for the sketches and not the record, because a sketch hangs under nothing", async () => {
    expect(READS).toBe("sketches");
    const routes = await pages(readings);
    expect(Object.keys(routes)).toContain("/sketches");
    expect(answer(routes, "GET", "/sketches").status).toBe(200);
  });

  it("refuses to mount on a surface that offers no such reading, and says which", async () => {
    const { sketches: _none, ...without } = readings;
    await expect(pages(without)).rejects.toThrow(PageError);
    await expect(pages(without)).rejects.toThrow(/reads sketches, which is not a reading/);
  });
});

describe("the list is the columns the mock draws", () => {
  const all = [drawing(112), drawing(111, { story_id: 491 })];
  const body = listOf(all);

  it("names the mock's columns above the rows, and draws one row per sketch under them", () => {
    const head = body.slice(body.indexOf(`<li class="head">`), body.indexOf("</li>"));
    expect([...head.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1])).toEqual([
      "id", "name", "kind", "state", "touched",
    ]);
    expect([...body.matchAll(/<li id="sketch-(\d+)"/g)].map((m) => Number(m[1]))).toEqual([112, 111]);
  });

  it("gives every sketch a tick of its own, and the head of the list none", () => {
    for (const s of all) {
      expect(rowOf(body, s.id)).toContain(`<input type="checkbox"`);
      expect(rowOf(body, s.id), `#${s.id} is not what its tick picks`).toContain(`value="${s.id}"`);
    }
    expect(body.slice(0, body.indexOf(`<li id=`))).not.toContain("checkbox");
  });

  it("writes the id, the name, what it says, the kind and when it was touched", () => {
    for (const said of [`<span class="id">#112</span>`, `>sketch 112</a>`, `<span class="kind">ui`,
      `<span class="says">one line saying what it is for</span>`,
      `<span class="when">1 min ago</span>`]) expect(rowOf(body, 112), said).toContain(said);
  });

  it("says the story a sketch became, and marks it, which is what the column is read for", () => {
    expect(stateOf(drawing(1))).toBe("sketch");
    expect(stateOf(drawing(1, { story_id: 491 }))).toBe("story #491");
    expect(rowOf(body, 111)).toContain(`<span class="state signed">story #491</span>`);
    expect(rowOf(body, 112)).toContain(`<span class="state">sketch</span>`);
  });

  it("carries the whole of what a sketch says of itself, and lets the look cut it to two", () => {
    // Cut in the markup instead and the row would lose the record's own words; cut by the
    // look and a reader still gets them by opening the sketch.
    const said = "a".repeat(400);
    expect(rowOf(listOf([drawing(9, { says: said })]), 9)).toContain(said);
    expect(RULES["section.sketches .name .says"]).toContain("-webkit-line-clamp: 2");
  });

  it("says how long ago in words a person reads, not a timestamp to subtract", () => {
    for (const [ago, words] of [[30_000, "just now"], [4 * 60_000, "4 min ago"],
      [90 * 60_000, "an hour ago"], [5 * 3_600_000, "5 hours ago"], [30 * 3_600_000, "yesterday"],
      [3 * 86_400_000, "3 days ago"]] as const) expect(touched(AGO(ago), NOW), words).toBe(words);
    expect(touched("not a time", NOW)).toContain("no time the record can read");
  });

  it("says so when nothing is drawn, and writes a person's own words as words", () => {
    expect(listOf([])).toContain("nothing drawn yet");
    expect(listOf([])).not.toContain("<ul");
    const quoted = listOf([drawing(3, { name: `a <script> & "quotes"` })]);
    expect(quoted).not.toContain("<script>a");
    expect(quoted).toContain(`a &lt;script&gt; &amp; &quot;quotes&quot;`);
  });
});

describe("one bar above the list, and no way to draw a sketch from it", () => {
  const body = listOf([drawing(112)]);

  it("offers the two acts the declaration holds and no third, because a sketch is drawn "
    + "by the orchestrator", () => {
    const buttons = [...body.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(buttons).toEqual(UI.acts.map((a) => a.says));
    expect(buttons).toContain("Make a story from it");
    expect(buttons).toContain("Remove");
    expect(body.indexOf(`class="bar"`)).toBeLessThan(body.indexOf(`<ul class="sketches"`));
    // The absence of a verb and not of a word: the page takes no form at all, and says on
    // the bar why there is nothing here that draws one.
    expect(body).not.toContain("<form");
    expect(body).toContain(UI.hint);
  });

  it("starts with the acts turned off, because nothing is picked yet", () => {
    for (const act of UI.acts) {
      const at = body.indexOf(`data-ui="${act.id}"`);
      expect(at, act.id).toBeGreaterThan(-1);
      expect(body.slice(at, body.indexOf(">", at)), act.id).toContain("disabled");
    }
    expect(body).toContain(`data-ui="${UI.pickedId}">${UI.none}<`);
  });
});

/** A shell that keeps what it was handed, so "unsent" is a thing a statement can read. */
class Pretend implements Shelled {
  output = "";
  running = true;
  exit = null;
  readonly heard: string[] = [];
  readonly submitted: string[] = [];
  keys = (input: string): void => void this.heard.push(input);
  prompt = (text: string): void => void this.submitted.push(text);
  close = (): Promise<number> => ((this.running = false), Promise.resolve(0));
}

describe("make a story from it types the instruction at the dock, unsent", () => {
  const story = actNamed("story");
  const remove = actNamed("remove");
  const one = drawing(112, { name: "tasks inbox, three densities", html: "/w/sketches/tasks.html" });
  const two = drawing(111, { name: "where the dock sits", html: "/w/sketches/dock.html" });

  it("names the sketch, its words and where the drawing is, because the agent never sees it", () => {
    const said = typed(story, [one]);
    for (const part of ["#112", "tasks inbox, three densities", "/w/sketches/tasks.html"]) {
      expect(said, part).toContain(part);
    }
    // One instruction for the whole of what was ticked, and not one per tick.
    const both = typed(story, [one, two]);
    expect(both.startsWith(story.lead)).toBe(true);
    expect(both).toContain("#112");
    expect(both).toContain("#111");
    expect(both).toContain(story.joins);
  });

  it("types the cli's own verb for removal, one command per picked sketch", () => {
    expect(typed(remove, [one])).toBe("wecode sketch drop 112");
    expect(typed(remove, [one, two])).toBe("wecode sketch drop 112; wecode sketch drop 111");
  });

  it("hands each row its clauses, so the browser composes out of words a test has read", () => {
    const row = rowOf(listOf([one]), 112);
    const at = row.indexOf(`data-words="`) + `data-words="`.length;
    const said = JSON.parse(
      row.slice(at, row.indexOf(`"`, at)).replace(/&quot;/g, `"`).replace(/&amp;/g, "&"),
    ) as Record<string, string>;
    expect(said["story"]).toBe(clauseOf(story, one));
    expect(said["remove"]).toBe(clauseOf(remove, one));
  });

  it("goes up as the painter's keys frame, built the same way on both sides of the wire", () => {
    expect(KIND).toBe("keys");
    expect(decode(framed("what was typed"))).toEqual({ kind: KIND, data: "what was typed" });
    // The line the browser runs, run: a second encoder that agrees today is a second one to
    // keep right, and this is the statement that there is only one.
    expect((new Function(`return ${FRAMES}`)() as (d: string) => string)("what was typed"))
      .toBe(framed("what was typed"));
  });

  it("arrives at the dock's own far end as the words, with nothing submitting them", () => {
    const shells: Pretend[] = [];
    const opens: Opens = () => {
      const made = new Pretend();
      shells.push(made);
      return made;
    };
    const shell = shellAt(() => "/w", opens);
    const routes = { [SHELL_AT]: shell.route };
    // The script asks for the screen first, which is what opens the shell: a frame posted at
    // a shell nobody started is refused, and the point is that the words arrive.
    expect(answer(routes, "GET", `${SHELL_AT}?from=0`).status).toBe(200);
    const said = typed(story, [one, two]);
    expect(answer(routes, "POST", SHELL_AT, framed(said)).status).toBe(200);

    const far = shells[0] as Pretend;
    expect(far.heard).toEqual([said]);
    // Unsent: a `prompt` frame is the one the far end submits for you, and none was sent.
    expect(far.submitted).toEqual([]);
    expect(far.heard.join("")).not.toContain("\r");
    shell.close();
  });
});

describe("the script wires the bar to that route and to no other", () => {
  const script = scriptOf(listOf([drawing(112)]));

  it("posts to the dock's far end and names no path of its own", () => {
    expect(script).toContain(`method: "POST"`);
    // A second way into the shell is a second screen the next word could land on, which is
    // why `browser/annotate.ts` names `SHELL_AT` rather than opening one.
    expect([...script.matchAll(/"\/[a-z.?=+]*"/g)].map((m) => m[0])).toEqual([
      JSON.stringify(SHELL_AT),
    ]);
  });

  it("reaches for the rows, the acts, the count and the dock's own control", () => {
    for (const said of [
      `[data-ui="sketches.list.item"]`, `[data-ui="sketches.bar"]`,
      `[data-ui="${UI.pickedId}"]`, "dataset.words",
      JSON.stringify(CONTROLS.open), `classList.contains(${JSON.stringify(DOCKED)})`,
    ]) expect(script, said).toContain(said);
  });

  it("is javascript an engine can parse, because a script a browser chokes on wires nothing", () => {
    // Compiled and not run: what matters about a served script is that a browser gets past
    // it, and there is no browser here for it to reach into.
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("opening one is this page with a sketch chosen", () => {
  let one: Sketch;

  beforeAll(() => {
    const at = join(tmp("wecode-sketches-drawn-"), "tasks.html");
    writeFileSync(at, "<!doctype html><p>three densities</p>\n");
    one = drawing(112, { html: at });
  });

  it("reads which one off the target, the way the tasks page reads its task", () => {
    const all = [one, drawing(111)];
    const url = (q: string): URL => new URL(`http://localhost/sketches${q}`);
    expect(PARAM).toBe("open");
    expect(opened(all, url(""))).toBeNull();
    expect(opened(all, url("?open=111"))).toBe(all[1]);
    expect(opened(all, url("?open=999"))).toBe(999);
  });

  it("gives the list way to the drawing at full width, with the link back above it", () => {
    const body = listOf([one, drawing(111)], `?${PARAM}=112`);
    expect(body).not.toContain(`<ul class="sketches"`);
    expect(body).not.toContain(`class="bar"`);
    expect(body).toContain(`<a href="?" data-ui="sketches.open.back"`);
    expect(body.indexOf("sketches.open.back")).toBeLessThan(body.indexOf("<iframe"));
    expect(body).toContain("three densities");
    // Handed over whole, so no path of this board answers with a file off the disk; and in
    // an origin of its own, so a sketch of a working surface runs without reaching the board.
    expect(body).toContain("srcdoc=");
    expect(body).toContain(`sandbox="allow-scripts"`);
    expect(RULES["section.sketches .open iframe.drawing"]).toContain("width: 100%");
  });

  it("says where it looked when the row is there and the drawing is not, or the row is not", () => {
    const gone = listOf([drawing(9, { html: "/nowhere/gone.html" })], `?${PARAM}=9`);
    expect(gone).toContain("no drawing on this machine at /nowhere/gone.html");
    expect(gone).not.toContain("<iframe");
    const stale = listOf([one], `?${PARAM}=999`);
    expect(stale).toContain("no sketch #999 in the record");
    expect(stale).toContain(`<a href="?" data-ui="sketches.open.back"`);
  });

  it("is still the whole document, banner and dock and all", () => {
    const { body, status } = sketchesPage([one], new URL(`http://localhost/sketches?open=112`));
    expect(status).toBe(200);
    expect(body).toContain("<h1>wecode</h1>");
    expect(body).toContain(`id="terminal"`);
    expect(body.trimEnd().endsWith("</html>")).toBe(true);
  });
});

describe("the design and the declaration carry it", () => {
  it("names it in the banner, last, and scopes it a shape and a block of its own", () => {
    const order = loadBanner();
    expect(order[order.length - 1]).toEqual({ page: "sketches", says: "Sketches", at: "/sketches" });
    expect(LOOK.roots["sketches"]).toEqual(["section.sketches"]);
    expect(Object.keys(RULES).length).toBeGreaterThan(0);
    const map = fileURLToPath(new URL("../../core/config/components.yaml", import.meta.url));
    expect(readFileSync(map, "utf8"), "the surface's component claims it").toContain("pages/sketches");
  });

  it("takes the bar's words off the file, so an edited declaration re-words the bar", () => {
    const re = edited("      says: Remove", "      says: Take it out");
    expect(UI.acts.map((a) => a.says)).toContain("Remove");
    expect(sketchesList([drawing(1)], new URL("http://localhost/sketches"), loadUi(re), NOW))
      .toContain("Take it out");
  });

  it("refuses a declaration that offers no acts, or an act that says nothing", () => {
    const none = edited("  acts:\n", "  absent:\n");
    expect(() => loadUi(none)).toThrow(SketchesUiError);
    expect(() => loadUi(none)).toThrow(/offers no acts/);
    expect(() => loadUi(edited(`      row: "wecode sketch drop %id%"\n`, ""))).toThrow(
      /acts\[1\]\.row says nothing/,
    );
  });
});

describe("it answers on a real workspace, out of the binary that ships", () => {
  it("draws the record's own rows, served by the binary that has to offer the reading", async () => {
    // The readings map in `bin.ts` is the thing in question and it is not importable — the
    // file owns a process. So the process is what is asked: a board that did not offer
    // `sketches` throws out of `pages()` before it listens, and there is no line to read.
    const db = join(tmp("wecode-sketches-db-"), "wecode.db");
    const made = open(db);
    const html = join(dirname(db), "one.html");
    writeFileSync(html, "<!doctype html><p>a drawing</p>\n");
    addSketch(made, { name: "where the dock sits", kind: "ui", says: "right edge", html });
    expect(sketches(made)).toHaveLength(1);
    made.close();

    const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    const child = spawn(process.execPath, [bin, "--db", db, "--port", "0"], {
      cwd: dirname(db),
      env: { ...process.env, WECODE_HOME: join(dirname(db), "home") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => (out += chunk));
    }
    const listening = /http:\/\/\S+/;
    try {
      for (let n = 0; n < 200 && !listening.test(out); n++) {
        await new Promise((resume) => setTimeout(resume, 100));
      }
      const at = listening.exec(out);
      expect(at, `the board never listened\n${out}`).not.toBeNull();
      const body = await (await fetch(`${(at as RegExpExecArray)[0]}/sketches`)).text();
      expect(body).toContain("where the dock sits");
      expect(body).toContain("right edge");
      expect(body).toContain(`<a href="/sketches">Sketches</a>`);
    } finally {
      child.kill("SIGTERM");
    }
  }, 30_000);
});
