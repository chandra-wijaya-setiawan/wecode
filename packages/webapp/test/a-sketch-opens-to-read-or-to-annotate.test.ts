/** A sketch opens to read, or it opens to annotate, and which of the two is in the target.
 *
 *  The criteria this file is written from, whole: *"A row's last column reads view then edit,
 *  and the word open is on no row. `?open=<id>` and `?open=<id>&mode=view` are one document,
 *  and its frame is the sandboxed srcdoc it is today, byte for byte. `?open=<id>&mode=edit`
 *  serves the same sketch under the same header, its drawing in a same-origin frame that
 *  references the four `/review/*` files, with the header's switch carrying between the two.
 *  A sketch the record has not got is refused in either mode."*
 *
 *  Four claims, and each is a `describe` below, in the order the criteria makes them. A fifth
 *  asks the board a person actually opens, for the one claim no fragment can answer.
 *
 *  Four readings the criteria leaves open, decided here so a reader can disagree in one place:
 *
 *  — *"the word open is on no row"* is about what a reader **sees**, not about the target: the
 *    criteria itself spells both destinations `?open=<id>…`, so `open` is still the parameter
 *    and must be. What goes is the word in the row's last column, so a row is read with its
 *    markup taken out — and the targets are asserted separately, because a row that reads
 *    "view" and links nowhere passes neither.
 *
 *  — *"the sandboxed srcdoc it is today, byte for byte"* is pinned by spelling the element out
 *    here rather than by diffing against a build of yesterday. `SANDBOXED` is the reading
 *    frame's whole contract — `sandbox="allow-scripts"` and no `allow-same-origin`, so a sketch
 *    of a working surface runs its script in an origin of its own and reaches no part of the
 *    board — and annotating gives that up, on purpose, because an overlay that cannot reach a
 *    page cannot annotate it.
 *
 *  — *"the same header"* is the words a reader sees above the drawing, the same in either mode;
 *    which side of the switch is held is an attribute, and makes no second header out of one.
 *
 *  — *"references the four `/review/*` files"* is asked of what a browser ends up with, and
 *    followed rather than grepped: the frame is resolved — its `srcdoc`, or the document at
 *    its `src` — and every `/review/*` file it asks for is fetched, and everything those ask
 *    for in turn, because `overlay.js` imports the other three by the relative specifiers it
 *    compiled with. So a frame may name one file or four; either way a reviewer's browser
 *    reaches all four, fetches no 404 on the way, and what it reaches is *this* sketch's
 *    drawing — the record holds two, at two files, so framing the wrong one is a thing that
 *    can fail here.
 *
 *  Nothing below imports a name the surface does not already export. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addSketch, open, sketches, type Sketch } from "@wecode/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmp } from "../../core/test/tmpdir.js";
import { REVIEW, REVIEW_AT } from "../src/browser/annotate.js";
import { escape } from "../src/pages/board.js";
import { pages } from "../src/pages/discover.js";
import { answer } from "../src/server.js";

// ─── a workspace with something drawn in it ─────────────────────────────────────────

const HOME = tmp("wecode-sketch-opens-");

/** A drawing on the disk, because a frame hands over the file the record points at. It holds
 *  an ampersand and a quotation mark on purpose: `srcdoc` carries an escaped document, and
 *  "byte for byte" is worth nothing against bytes that cannot tell an escape from a copy. It
 *  names its own sketch, and the two rows below point at different files: a fixture sharing
 *  one file cannot tell the drawing asked for from whichever the board framed first. */
const says = (name: string): string => `a sketch of "${name}"`;
const sheet = (name: string): string =>
  `<!doctype html><meta charset="utf-8"><title>a drawing</title>` +
  `<h1>projects &amp; what each waits on</h1><p class="q">${says(name)}</p>`;
const [MINE, THEIRS] = ["the front page", "the dock"];
const [HTML, OTHER_HTML] = [join(HOME, "sketch.html"), join(HOME, "dock.html")];
const DRAWN = sheet(MINE);
writeFileSync(HTML, DRAWN);
writeFileSync(OTHER_HTML, sheet(THEIRS));

/** The record, made the way the cli makes one. None of these words is `open`, `view` or
 *  `edit`: what a row reads is under test, so the columns must not supply the answer. Two
 *  drawings, because "every row" is a claim about more than one — and both are aged nine
 *  days, so their age does not change between two documents fetched a moment apart. */
const DB = join(HOME, "wecode.db");
const drawn = (): readonly Sketch[] => {
  const made = open(DB);
  addSketch(made, { name: MINE, kind: "ui", says: "two projects, one stalled", html: HTML });
  addSketch(made, { name: THEIRS, kind: "ui", says: "a shell under the board", html: OTHER_HTML });
  made.prepare("update sketch set updated_at = ?").run(new Date(Date.now() - 9 * 864e5).toISOString());
  const all = sketches(made);
  made.close();
  return all;
};

const ALL = drawn();
/** The one that is opened below, and a number the record has not got, for the refusal. */
const OPENED = ALL.find((s) => s.name === MINE) as Sketch;
const MISSING = ALL.reduce((n, s) => Math.max(n, s.id), 0) + 1;

/** The surface, mounted on a reading of that record — the questions `bin.ts` offers, so that
 *  what is asked below is the page as it is served and not a fragment built by hand. */
const ROUTES = await pages({
  record: () => [], board: () => ({}), approvals: () => [], sketches: () => ALL,
});

/** A target, spelled the way the criteria spells one. */
const at = (id: number, mode?: "view" | "edit"): string =>
  `/sketches?open=${id}${mode === undefined ? "" : `&mode=${mode}`}`;

const bodyAt = (target: string): string => answer(ROUTES, "GET", target).body;

// ─── reading a document without knowing its markup ──────────────────────────────────

/** The reverse of the page's own `escape`, for reading an attribute back as what it holds. */
const unescaped = (text: string): string =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** What a reader sees, markup taken out. An attribute is not a word on a page: every `>` in
 *  `srcdoc` is escaped, so a tag ends where it looks to and no drawing's words leak in. */
const visible = (markup: string): string =>
  markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const framesIn = (body: string): readonly string[] =>
  [...body.matchAll(/<iframe\b[^>]*>/g)].map((m) => m[0]);

/** The frame the drawing is in. Reading and annotating cannot be one element, so neither is
 *  named here — a frame is a frame. */
function frameOf(body: string): string {
  const all = framesIn(body);
  expect(all, "the open view draws no drawing, or draws more than one").toHaveLength(1);
  return all[0] as string;
}

/** The open view and nothing around it. Scoped, not read off the whole reply: the shell's
 *  palette holds `--good: #3d6b4f`, so `toContain("#3")` is answered by a colour. */
function openOf(body: string): string {
  const from = body.indexOf(`data-ui="sketches.open"`);
  expect(from, "this is not an open view at all").toBeGreaterThan(-1);
  const to = body.indexOf("</section>", from);
  return body.slice(from, to === -1 ? body.length : to);
}

/** Everything above the drawing, which is the header the criteria says both modes share. */
const headerOf = (body: string): string =>
  openOf(body).slice(0, openOf(body).indexOf(frameOf(body)));

function rowOf(body: string, id: number): string {
  const from = body.indexOf(`<li id="sketch-${id}"`);
  expect(from, `no row for #${id}`).toBeGreaterThan(-1);
  return body.slice(from, body.indexOf("</li>", from));
}

/** The sandbox an element declares, or `null` for none — a frame of this origin. */
function sandboxOf(frame: string): string | null {
  const said = /sandbox="([^"]*)"/.exec(frame);
  return said === null ? null : (said[1] as string);
}

/** Does this markup offer a way to the target the criteria spells for a reading? `view` is
 *  reachable two ways: `?open=<id>` and `?open=<id>&mode=view` are one document. */
const goesTo = (markup: string, id: number, mode: "view" | "edit"): boolean =>
  [...markup.matchAll(/href="([^"]*)"/g)]
    .map((m) => new URL(unescaped(m[1] as string), "http://localhost/sketches"))
    .some((url) => {
      if (url.searchParams.get("open") !== String(id)) return false;
      const said = url.searchParams.get("mode");
      return mode === "edit" ? said === "edit" : said === null || said === "view";
    });

// ─── the row ────────────────────────────────────────────────────────────────────────

describe("a row's last column reads view then edit", () => {
  const body = bodyAt("/sketches");

  it("ends every row with view and then edit", () => {
    for (const s of ALL) {
      expect(visible(rowOf(body, s.id)), `row #${s.id}`).toMatch(/\bview\b[^a-z]+\bedit\b$/);
    }
  });

  it("shows the word open on no row", () => {
    for (const s of ALL) {
      expect(visible(rowOf(body, s.id)), `row #${s.id} still reads "open"`).not.toMatch(/\bopen\b/);
    }
  });

  it("still sends each word somewhere, so a row that reads view is a row that opens", () => {
    for (const s of ALL) {
      const row = rowOf(body, s.id);
      expect(goesTo(row, s.id, "view"), `row #${s.id} offers no way to read it`).toBe(true);
      expect(goesTo(row, s.id, "edit"), `row #${s.id} offers no way to annotate it`).toBe(true);
    }
  });
});

// ─── reading ────────────────────────────────────────────────────────────────────────

/** The frame the reading view draws today, whole. Written out rather than derived: what the
 *  criteria protects is this element, not a rule that survives a sandbox widened by a token. */
const SANDBOXED =
  `<iframe class="drawing" data-ui="sketches.open.drawing" sandbox="allow-scripts" ` +
  `title="${escape(OPENED.name)}" srcdoc="${escape(DRAWN)}"></iframe>`;

describe("?open=<id> and ?open=<id>&mode=view are one document", () => {
  it("answers the same bytes at both targets", () => {
    expect(bodyAt(at(OPENED.id, "view"))).toBe(bodyAt(at(OPENED.id)));
  });

  it("draws the sandboxed srcdoc it is today, byte for byte, at both", () => {
    for (const target of [at(OPENED.id), at(OPENED.id, "view")]) {
      expect(bodyAt(target), target).toContain(SANDBOXED);
      expect(frameOf(bodyAt(target)), target).toBe(SANDBOXED.slice(0, SANDBOXED.indexOf("></") + 1));
    }
  });

  it("keeps the drawing off this origin, so a sketch's own script reaches no board", () => {
    expect(sandboxOf(frameOf(bodyAt(at(OPENED.id, "view"))))).toBe("allow-scripts");
  });

  it("loads no part of the review loop into a sketch nobody is annotating", () => {
    const body = bodyAt(at(OPENED.id, "view"));
    for (const [what, file] of Object.entries(REVIEW)) {
      expect(body, `the reading view fetches ${what}`).not.toContain(file);
    }
  });
});

// ─── annotating ─────────────────────────────────────────────────────────────────────

describe("?open=<id>&mode=edit serves the same sketch, to annotate", () => {
  const view = bodyAt(at(OPENED.id, "view"));
  const edit = bodyAt(at(OPENED.id, "edit"));

  it("says the same sketch under the same header in either mode", () => {
    const said = visible(headerOf(edit));
    for (const fact of [`#${OPENED.id}`, OPENED.name, OPENED.says, OPENED.kind, OPENED.html]) {
      expect(said, `annotating never says ${fact}`).toContain(fact);
    }
    // Word for word the reading view's: which side of the switch is held is an attribute, and
    // a header that grew a word when a reader changed mode is two headers rather than one.
    expect(said, "annotating wears a header of its own").toBe(visible(headerOf(view)));
  });

  it("draws it in a frame of this origin, and not in the reader's sandbox", () => {
    const frame = frameOf(edit);
    expect(frame, "annotating gets the reading sandbox").not.toBe(frameOf(view));
    const box = sandboxOf(frame);
    const reachable = box === null || box.includes("allow-same-origin");
    expect(reachable, `no overlay can reach a drawing framed as sandbox="${String(box)}"`).toBe(true);
  });

  it("carries the reader between the two from the header's own switch", () => {
    expect(goesTo(headerOf(view), OPENED.id, "edit"), "no way to annotate from reading").toBe(true);
    expect(goesTo(headerOf(edit), OPENED.id, "view"), "no way back to reading").toBe(true);
  });

  it("names both readings in that switch, the way a row names them", () => {
    for (const [mode, body] of Object.entries({ view, edit })) {
      const said = visible(headerOf(body));
      expect(said, `${mode}'s header offers no "view"`).toMatch(/\bview\b/);
      expect(said, `${mode}'s header offers no "edit"`).toMatch(/\bedit\b/);
    }
  });
});

// ─── a sketch that is not there ─────────────────────────────────────────────────────

describe("a sketch the record has not got is refused in either mode", () => {
  for (const target of [at(MISSING), at(MISSING, "view"), at(MISSING, "edit")]) {
    it(`draws nothing and says which number it was asked for, at ${target}`, () => {
      const body = bodyAt(target);
      const said = visible(openOf(body));
      expect(said, "the number the target named is never said back").toContain(`#${MISSING}`);
      expect(framesIn(body), "a sketch that is not in the record is framed anyway").toEqual([]);
      for (const [what, file] of Object.entries(REVIEW)) {
        expect(body, `${what} is served over a sketch that does not exist`).not.toContain(file);
      }
    });
  }
});

// ─── and the board a person opens serves it ─────────────────────────────────────────

/** What a reviewer's browser fetches cannot be proved against a fragment: whether the frame
 *  and the review loop are on the board at all only the thing that ships can answer. So this
 *  spawns the built binary, the way `the-binary-starts-and-answers.test.ts` does. */
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const PATIENCE = 20_000;

let child: ChildProcess;
let board = "";

async function boot(): Promise<string> {
  const env = { ...process.env, WECODE_HOME: join(HOME, "home") };
  const how = { cwd: HOME, env, stdio: ["ignore", "pipe", "pipe"] } as const;
  child = spawn(process.execPath, [BIN, "--db", DB, "--port", "0"], how);
  const [out, err] = [child.stdout, child.stderr];
  let [said, complaint] = ["", ""];
  out?.setEncoding("utf8");
  err?.setEncoding("utf8");
  out?.on("data", (chunk: string) => (said += chunk));
  err?.on("data", (chunk: string) => (complaint += chunk));
  // Waited for by reading the line the board prints, which is written after the socket is
  // listening: polling a port would say "listening" about whatever else was on it.
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the board never listened in ${PATIENCE}ms\n${said}${complaint}`));
    }, PATIENCE);
    out?.on("data", () => {
      const where = /http:\/\/\S+/.exec(said);
      if (where === null) return;
      clearTimeout(timer);
      resolve(where[0]);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the board left with ${String(code)} before it listened\n${complaint}`));
    });
  });
}

async function got(path: string): Promise<{ status: number; type: string; body: string }> {
  const reply = await fetch(`${board}${path}`);
  const type = reply.headers.get("content-type") ?? "";
  return { status: reply.status, type, body: await reply.text() };
}

/** What a browser ends up with inside a frame: its `srcdoc`, or the document at its `src` —
 *  which must be this board's, because a frame fetched elsewhere is not same-origin. */
async function framed(frame: string): Promise<string> {
  const doc = /srcdoc="([^"]*)"/.exec(frame);
  if (doc !== null) return unescaped(doc[1] as string);
  const src = /\bsrc="([^"]*)"/.exec(frame);
  expect(src, "the frame carries neither a srcdoc nor a src").not.toBeNull();
  const path = unescaped((src as RegExpExecArray)[1] as string);
  expect(path.startsWith("/"), `the frame is served from ${path}, which is not this board`).toBe(true);
  const reply = await got(path);
  expect(reply.status, `the frame's own ${path} answered ${reply.status}`).toBe(200);
  return reply.body;
}

/** Is what a browser ends up with inside the frame the drawing the target named? A board that
 *  framed whichever was first says the right name in the header and still hands the reviewer
 *  somebody else's page. The other sketch's line is asked for too, so the wrong one has a name. */
function itsOwn(inside: string, mode: string): void {
  expect(inside, `${mode} frames a drawing the target never named`).toContain(says(MINE));
  expect(inside, `${mode} frames the other sketch's drawing`).not.toContain(says(THEIRS));
}

/** Every `/review/*` file a document asks for, and every one those ask for in turn. `overlay.js`
 *  imports its three neighbours relatively, so a frame naming one file is a browser fetching four. */
async function reaches(document: string): Promise<ReadonlySet<string>> {
  const asked = (text: string, from: string): readonly string[] => [
    ...[...text.matchAll(new RegExp(`${REVIEW_AT}/[\\w.-]+`, "g"))].map((m) => m[0]),
    ...[...text.matchAll(/["'](\.\/[\w.-]+)["']/g)].map(
      (m) => `${from.slice(0, from.lastIndexOf("/"))}/${(m[1] as string).slice(2)}`,
    ),
  ];
  const seen = new Set<string>();
  const left = [...asked(document, REVIEW_AT)];
  while (left.length > 0) {
    const path = left.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const reply = await got(path);
    expect(reply.status, `${path} is asked for and answers ${reply.status}`).toBe(200);
    expect(reply.type, path).toContain("javascript");
    left.push(...asked(reply.body, path));
  }
  return seen;
}

describe("the board a person opens serves both readings", () => {
  beforeAll(async () => {
    board = await boot();
  }, PATIENCE + 10_000);

  afterAll(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await once(child, "exit");
  });

  it("answers a whole document in either mode", async () => {
    for (const mode of ["view", "edit"] as const) {
      const reply = await got(at(OPENED.id, mode));
      expect(reply.status, mode).toBe(200);
      expect(reply.type, mode).toContain("text/html");
      expect(reply.body.trimEnd().endsWith("</html>"), mode).toBe(true);
    }
  });

  it("reaches all four of the review loop's files from the frame it annotates in", async () => {
    const inside = await framed(frameOf((await got(at(OPENED.id, "edit"))).body));
    itsOwn(inside, "edit");
    const reached = await reaches(inside);
    for (const [what, file] of Object.entries(REVIEW)) {
      expect(reached.has(file), `no reviewer's browser ever fetches ${what} at ${file}`).toBe(true);
    }
  });

  it("asks for none of them in the frame it only reads in", async () => {
    const inside = await framed(frameOf((await got(at(OPENED.id, "view"))).body));
    itsOwn(inside, "view");
    expect(await reaches(inside), "the reading view carries the review loop").toEqual(new Set());
  });
});
