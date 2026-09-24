/** The dock is a terminal, and not an empty box.
 *
 *  There are three things a reader needs before the dock they open is a shell: a document that
 *  asks for the pane's script, a script at the path it asked for, and a session behind the
 *  route that script polls. Every one of them had passed before and none of them was true
 *  together — `dock()` was proved by calling it, twice over, while the document carried no
 *  script at all and nothing a browser fetched could ever have run it.
 *
 *  So nothing here is imported out of `src/` and no function of this package is called. The
 *  statements below spawn the built binary the way the operator runs it, on a port the system
 *  picks, and then ask it — over HTTP, as a browser would — for those things in the order a
 *  browser meets them: the `<script>` at the foot of the document, once and on every page; the
 *  path it names answering 200 as javascript with the pane, which imports the painter's half
 *  and the emulator at paths this board also answers on; the dock it draws being a sidebar —
 *  an aside and no popover — whose sheet and whose script name one class on the root between
 *  them and whose two controls are drawn and wired as the one row they are; and the route that
 *  script polls opening a pty session, proved by typing into it, reading back what the shell
 *  printed, and restarting it, which no stand-in can fake. Then the board is stopped, because
 *  a test that leaves a login shell running behind it has not finished. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { open } from "@wecode/core";
import { seed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

/** What `wecode-webapp` is: the built file, so that a source which compiles and a binary
 *  which serves a terminal are not allowed to be two different things. */
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** How long a board gets to listen, and how long a shell gets to draw. Generous, because a cold
 *  pty on a loaded machine is not a defect; finite, because a dock that never draws must fail as
 *  itself rather than as the runner's own timeout with nothing said. */
const PATIENCE = 20_000;

/** A board under this file's hand. The process is the unit here — nothing is imported out of
 *  it, and every claim below is a request to it. */
interface Board { readonly at: string; readonly stop: () => Promise<Ended> }
type Ended = { code: number | null; signal: string | null };

const running: Board[] = [];

/** A workspace with one of everything, made once: the board fetched below is drawing real rows,
 *  so a document that is a whole document is a document of the surface. */
let db = "";

beforeAll(() => {
  db = join(tmp("wecode-webapp-terminal-"), "wecode.db");
  const made = open(db);
  seed(made), made.close();
});

afterEach(async () => {
  for (const board of running.splice(0)) await board.stop();
});

/** The binary, spawned and waited for the way a person waits for it: by reading the line it
 *  prints once the socket is listening. Port 0, so the port is one the operating system says is
 *  free — a fixed port would collide with the board the person running these tests very likely
 *  has open on 4321 — and a home of its own, so a board spawned here cannot read theirs. */
async function boot(): Promise<Board> {
  const child = spawn(process.execPath, [BIN, "--db", db, "--port", "0"], {
    cwd: dirname(db),
    env: { ...process.env, WECODE_HOME: join(dirname(db), "home") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.setEncoding("utf8"), child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (out += chunk));
  child.stderr.on("data", (chunk: string) => (err += chunk));

  // Waited for from the moment it is spawned, so stopping a board twice asks the same
  // ending twice rather than waiting forever for an exit that has been and gone.
  const left = once(child, "exit") as Promise<[number | null, string | null]>;
  const stop = async (): Promise<Ended> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const [code, signal] = await left;
    return { code, signal };
  };

  const board: Board = { at: "", stop };
  running.push(board);

  const at = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the board never listened in ${PATIENCE}ms\n${out}${err}`)), PATIENCE);
    const settle = (act: () => void): void => void (clearTimeout(timer), act());
    child.stdout.on("data", () => {
      const said = /http:\/\/\S+/.exec(out);
      if (said !== null) settle(() => resolve(said[0]));
    });
    child.on("exit", (code) =>
      settle(() => reject(new Error(`the board left with ${String(code)} before it listened\n${err}${out}`))));
  });
  return { ...board, at };
}

const got = async (board: Board, at: string): Promise<Response> => fetch(`${board.at}${at}`);

/** A frame going up, as the pane sends one: the painter's wire, by POST, to the route. */
const sent = async (board: Board, frame: unknown): Promise<Response> => fetch(`${board.at}/terminal`, { method: "POST", body: JSON.stringify(frame) });

/** A whole document, and not a fragment or an error page dressed as one. */
async function documentOf(board: Board, at: string): Promise<string> {
  const reply = await got(board, at);
  expect(reply.status, `${at} answered ${reply.status}`).toBe(200);
  expect(reply.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const body = await reply.text();
  expect(body.trimEnd().endsWith("</html>"), `${at} is not a document`).toBe(true);
  return body;
}

/** The script tag a document carries, whole, and the path it names. Read out of the served
 *  document rather than written down here, because the thing in question is the link: a tag
 *  pointing at a path this board does not answer on is the empty box with extra steps. */
function asks(body: string): { readonly tag: string; readonly src: string } {
  const found = /<script [^>]*src="([^"]+)"[^>]*>/.exec(body);
  expect(found, "the document asks for no script").not.toBeNull();
  const [tag, src] = found as RegExpExecArray;
  return { tag, src: src as string };
}

/** One poll of the far end, as the pane polls it: everything drawn since a cursor. */
interface Drawn { readonly at: number; readonly frames: readonly string[] }

async function drawn(board: Board, from: number): Promise<Drawn> {
  const reply = await got(board, `/terminal?from=${from}`);
  expect(reply.status, `the session answered ${reply.status}`).toBe(200);
  expect(reply.headers.get("content-type")).toBe("application/json; charset=utf-8");
  const said = (await reply.json()) as Drawn;
  expect(typeof said.at, "a poll says where the cursor is").toBe("number");
  expect(Array.isArray(said.frames), "a poll says what was drawn").toBe(true);
  return said;
}

/** Everything the session has drawn from the start, as the text inside its frames. The frames
 *  are the painter's wire — `{"kind":"output","chunk":"…"}` — and they are read here the way
 *  the pane's own `receive` reads them, out of JSON, rather than by importing the decoder: what
 *  is being asked is whether a browser holding nothing but this wire could see the shell, and a
 *  browser has no imports from this package either. */
const said = (frames: readonly string[]): string =>
  frames.map((frame) => JSON.parse(frame) as { kind: string; chunk?: string })
    .filter((message) => message.kind === "output").map((message) => message.chunk ?? "").join("");

/** The session, polled from the start until the shell has drawn what is waited for. A pty is a
 *  process: the first poll after the route opens one is very often empty, because the shell has
 *  not reached its own prompt yet, and a statement that read once and gave up would be a
 *  statement about scheduling. */
async function until(board: Board, wanted: string): Promise<string> {
  const deadline = Date.now() + PATIENCE;
  let held = "";
  while (Date.now() < deadline) {
    held = said((await drawn(board, 0)).frames);
    if (held.includes(wanted)) return held;
    await new Promise((resume) => setTimeout(resume, 100));
  }
  expect(held, `the shell never drew ${wanted} in ${PATIENCE}ms`).toContain(wanted);
  return held;
}

describe("the board asks a browser for the dock's script", () => {
  it("carries the tag in the board's document, once, at the foot", async () => {
    const board = await boot();
    const body = await documentOf(board, "/");
    const { tag } = asks(body);
    // A module, because the pane's script imports the emulator and the painter's half; and it
    // is last in the document, after the dock's own markup, so what it reaches for is parsed.
    expect(tag).toContain(`type="module"`);
    expect([...body.matchAll(/<script/g)], "one script, not one per page's worth").toHaveLength(1);
    expect(body.indexOf("<script")).toBeGreaterThan(body.indexOf(`id="terminal"`));
    expect(body.indexOf("<script")).toBeLessThan(body.indexOf("</body>"));
  });

  it("carries it on every page, because there is one dock and one session", async () => {
    const board = await boot();
    // The dock is in the document of every page, so the line that makes it a terminal is too:
    // a reader who opened the tasks page and pressed `terminal` is owed the same shell as one
    // who opened the board.
    const home = asks(await documentOf(board, "/"));
    for (const at of ["/tasks", "/agents", "/tree"]) expect(asks(await documentOf(board, at)).src, at).toBe(home.src);
  });
});

describe("the script the document asks for is served", () => {
  it("answers 200 as javascript with the pane, and everything it imports answers too", async () => {
    const board = await boot();
    const { src } = asks(await documentOf(board, "/"));
    const reply = await got(board, src);
    expect(reply.status, `${src} answered ${reply.status}`).toBe(200);
    expect(reply.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const script = await reply.text();
    expect(script.length, `${src} is empty`).toBeGreaterThan(0);
    // It is the pane and not a placeholder: it opens a terminal on the dock's own elements
    // and it polls the session's route.
    expect(script).toContain(`data-ui=\\"shell.dock.output\\"`);
    expect(script).toContain("/terminal?from=");
    // And the screen is the keyboard — two names, one element — which is what makes the black
    // box the thing a reader clicks and types into rather than a box with a line under it.
    const parts = JSON.parse((/const PARTS = (\{.*\});/.exec(script) as RegExpExecArray)[1] as string) as Record<string, string>;
    expect(Object.keys(parts).sort()).toEqual(["keyboard", "screen"]);
    expect(parts["keyboard"]).toBe(parts["screen"]);
    // It also measures, which is what makes the pane a window rather than a fixed grid: the
    // screen's rectangle, the box xterm's grid fills, and the screen's own trim, each beat.
    for (const held of [".xterm-screen", "getComputedStyle", "grid, trimOf("]) expect(script, held).toContain(held);
    expect(script).toMatch(/fit\(\);\n\s*await pane\.pump\(\)/);
    // And what it imports is served by this same board, at the paths it names. A script that
    // parses and then fails on its first import is a dock that stays an empty box — and a
    // browser reports that in a console nothing here can read.
    const imports = [...script.matchAll(/^import .* from "([^"]+)";$/gm)].map(([, at]) => at);
    expect(imports.length, "the pane imports nothing").toBeGreaterThan(0);
    for (const at of imports) {
      expect(at.startsWith("/"), `${at} is not a path a browser can ask for`).toBe(true);
      const held = await got(board, at);
      expect([held.status, held.headers.get("content-type")?.includes("text/javascript")], at).toEqual([200, true]);
    }
  });
});

/** The sheet in the served document, which is where the whole look is: one board, one file. */
const sheetOf = (body: string): string =>
  body.slice(body.indexOf("<style>") + "<style>".length, body.indexOf("</style>"));

/** One rule out of it, by selector, whole. */
function ruled(sheet: string, selector: string): string {
  const found = new RegExp(`(?:^|\\n)${selector.replace(/[[\]().*+?^$|\\#]/g, "\\$&")} \\{([^}]*)\\}`);
  const held = found.exec(sheet);
  expect(held, `the sheet declares no ${selector}`).not.toBeNull();
  return (held as RegExpExecArray)[1] as string;
}

describe("the dock a browser is served is a sidebar", () => {
  it("draws it as an aside and not a popover, on every page", async () => {
    const board = await boot();
    for (const at of ["/", "/tasks", "/tree"]) {
      const body = await documentOf(board, at);
      expect(body, at).toContain(`<aside id="terminal"`);
      // A popover is the browser's top layer, and the top layer belongs to the document: a
      // reader who followed a link would be served a page with the terminal shut behind them,
      // which is the one thing a session they are watching must not do.
      expect(body, at).not.toContain("popover");
      // …and nothing to type into but the screen: the line along the foot is gone.
      const dock = body.slice(body.indexOf(`<aside id="terminal"`), body.indexOf("</aside>"));
      for (const g of ["<form", "<input", "<label"]) expect(dock, `${at} still draws ${g}`).not.toContain(g);
      // The two ways out are along the top, in the order a reader meets them: restart, then
      // close at the edge where close has always been, and both of them above the screen.
      const [restart, shut, screen] = ["restart", "close", "output"].map((n) => `data-ui="shell.dock.${n}"`);
      expect(dock, `${at} draws no restart`).toContain(restart);
      expect(dock.indexOf(restart), `${at}: restart is not before close`).toBeLessThan(dock.indexOf(shut));
      expect(dock.indexOf(shut), `${at}: the screen is not under both`).toBeLessThan(dock.indexOf(screen));
    }
  });

  it("serves a sheet that opens it on a class the root wears, and makes room beside it", async () => {
    const board = await boot();
    const sheet = sheetOf(await documentOf(board, "/"));
    // Shut is what every document is served in, so the panel is `display: none` until the class
    // goes on — a document served open would flash a terminal on every page of the surface.
    expect(ruled(sheet, "#terminal")).toContain("display: none");
    const shape = /\nhtml\.([a-z-]+) #terminal \{/.exec(sheet);
    expect(shape, "the sheet opens the dock on no class at all").not.toBeNull();
    const held = (shape as RegExpExecArray)[1] as string;
    expect(ruled(sheet, `html.${held} #terminal`)).toContain("display: flex");
    // …and the page is the width that is left: the panel is `position: fixed`, which makes none.
    expect(ruled(sheet, `html.${held} body`)).toContain("padding-right");
    expect(ruled(sheet, "body"), "a shut dock would have every document standing aside").not.toContain("padding-right");
    // The two controls are one row across the top rather than two rows down the panel, and
    // the first takes the slack, so the rule along their feet is the width of the panel.
    expect(ruled(sheet, "#terminal > div")).toContain("display: flex");
    expect(ruled(sheet, "#terminal > div > button:first-child")).toContain("flex: 1");
  });

  it("serves a script that turns that class from the controls, and remembers which way", async () => {
    const board = await boot();
    const body = await documentOf(board, "/");
    const script = await (await got(board, asks(body).src)).text();
    // The class in the script is the class the sheet opens on. Two spellings of one word is
    // a dock whose button does nothing at all, and nothing in either file would say so.
    const held = (/\nhtml\.([a-z-]+) #terminal \{/.exec(sheetOf(body)) as RegExpExecArray)[1];
    expect(script).toContain(`const DOCKED = "${held as string}"`);
    expect(script).toContain("classList.toggle(DOCKED");
    expect(script).toContain("window.document.documentElement");
    // And what it listens to is markup this document holds: a selector for an element the
    // board never draws is a script that throws before it wires anything.
    const controls = /const CONTROLS = (\{.*\});/.exec(script);
    expect(controls, "the script names no controls").not.toBeNull();
    const named = JSON.parse((controls as RegExpExecArray)[1] as string) as Record<string, string>;
    expect(Object.keys(named).sort()).toEqual(["open", "restart", "shut"]);
    for (const [name, selector] of Object.entries(named)) {
      const attribute = selector.slice(1, -1).replace(/[[\]().*+?^$|\\]/g, "\\$&");
      expect([...body.matchAll(new RegExp(attribute, "g"))], selector).toHaveLength(1);
      expect(script).toContain(`one(CONTROLS.${name})`);
    }
    expect([...script.matchAll(/addEventListener\("click"/g)]).toHaveLength(3);
    // Two of the three turn the dock and the third turns the session, so it is the pane's act
    // and not the sidebar's — and nothing at all before the dock was ever opened, because a
    // board nobody opened the dock on has no shell to end.
    expect(script).toMatch(/one\(CONTROLS\.restart\)\.addEventListener\("click", \(\) => void pane\?\.restart\(\)\)/);
    // And the pane takes its cursor back to nought and wipes the screen before the frame goes
    // up: what comes down after it is a new session's first byte and not the old one's next,
    // so a pane that kept its cursor would ask from past the end of a stranger's screen.
    expect(script).toMatch(/at = 0;\s*pane\.terminal\.reset\(\);\s*await wire\.send\(encode\(\{ kind: "restart" \}\)\)/);
    // And which way it was turned is remembered, so a link the reader follows keeps it open.
    expect(script).toContain("window.localStorage");
    expect(script).toMatch(/const REMEMBERED = "wecode\.terminal"/);
    // Read on the way in and written on a turn: a store only ever written is a dock that
    // opens shut, and one only ever read is a dock nobody's last answer reaches.
    expect(script).toContain("getItem(REMEMBERED)");
    expect(script).toContain("setItem(REMEMBERED");
    expect(script.trimEnd().endsWith("sidebar.restore();"), "the script never restores it").toBe(true);
  });
});

describe("the route the script polls opens a session", () => {
  it("answers a poll with a cursor, and runs a real shell in the workspace", async () => {
    const board = await boot();
    // A board nobody has opened the dock on has no shell, so the first poll is what opens one;
    // what it has drawn by then is the pty's business and is not asserted, while the shape of
    // a poll — a cursor, and the frames since it — is what `drawn` asks of every answer here.
    expect((await drawn(board, 0)).at).toBeGreaterThanOrEqual(0);
    // Then the prompt. The shell is opened where the workspace is — `--db` moves it with the
    // board — so the directory it is standing in is the database's own, and that is a fact
    // only a pty running the operator's own shell can produce.
    expect((await until(board, dirname(db))).length).toBeGreaterThan(0);
  });

  it("takes what is typed at it, and draws what the shell printed", async () => {
    const board = await boot();
    await until(board, dirname(db));
    const posted = await sent(board, { kind: "prompt", text: "printf a-real-shell" });
    expect(posted.status, await posted.text()).toBe(200);
    // And the shell ran it. Not the echo of the line — the output of the command, which
    // only a program on the far end of a pty can have written.
    const screen = await until(board, "a-real-shell\r\n");
    expect(screen).toContain("printf a-real-shell");
  });

  it("refuses a POST that is not a frame, rather than guessing at it", async () => {
    const board = await boot();
    const posted = await fetch(`${board.at}/terminal`, { method: "POST", body: "not a frame" });
    expect(posted.status).toBe(400);
    // A count of cells is whole and at least one, so these are not frames either: a pty
    // asked for nought columns is one every program on it draws garbage into.
    for (const bad of [{ cols: 0, rows: 24 }, { cols: 80.5, rows: 24 }, { cols: "80", rows: "24" }])
      expect((await sent(board, { kind: "resize", ...bad })).status, JSON.stringify(bad)).toBe(400);
  });

  /** The one hop nothing above it can fake. A pty keeps composing frames for the size it
   *  was opened at until it is told another, so the arithmetic, the frame and the route are
   *  worth nothing without a `TIOCSWINSZ` on a real descriptor at the end of them — and
   *  `stty size` is the far end reading it back, rows then columns, in the shell's words. */
  it("carries a resize frame through to the pty, under the program reading it", async () => {
    const board = await boot();
    await until(board, dirname(db));
    await sent(board, { kind: "prompt", text: "stty size" });
    await until(board, "30 100"); // the size `painter/src/pty.ts` opens one at
    expect((await sent(board, { kind: "resize", cols: 123, rows: 37 })).status).toBe(200);
    await sent(board, { kind: "prompt", text: "stty size" });
    const screen = await until(board, "37 123");
    // Both answers on one screen, in order: resized underneath the program, not restarted.
    expect(screen.indexOf("30 100")).toBeLessThan(screen.indexOf("37 123"));
  });

  /** The restart, end to end, which is the one thing closing the dock cannot do: the shell that
   *  was there is gone, another is running in its place, and the cursor has gone back with it.
   *  Nothing short of the route can stand in for this — a screen wiped in the browser is still
   *  the same process on the far end, and the process is what had wedged. */
  it("ends the shell on a restart frame and opens another in its place", async () => {
    const board = await boot();
    await until(board, dirname(db));
    // Something only this shell knows: a variable, because a screen can be cleared and a
    // process cannot be made to forget.
    await sent(board, { kind: "prompt", text: "MARK=the-first-shell; printf held=$MARK" });
    const before = await until(board, "held=the-first-shell");
    const posted = await sent(board, { kind: "restart" });
    const said = await posted.text();
    // Taken while the shell is still running, which is the one frame that is — and the cursor
    // comes back with the new shell's screen rather than the length of the old one's.
    expect(posted.status, said).toBe(200);
    expect((JSON.parse(said) as { at: number }).at, "the cursor did not go back").toBeLessThan(before.length);
    const after = await until(board, dirname(db));
    expect(after, "the old shell's screen survived the restart").not.toContain("held=the-first-shell");
    // And a shell rather than a blank panel: it takes what is typed at it, and what answers
    // never heard of what the last one was told.
    await sent(board, { kind: "prompt", text: "printf held=[$MARK]" });
    expect(await until(board, "held=[]")).not.toContain("held=[the-first-shell]");
  });
});

describe("the board lets the shell go", () => {
  it("stops when it is told to, after a session was opened on it", async () => {
    const board = await boot();
    await until(board, dirname(db));
    // Asked, and went: a code of its own and no signal. Killed where it stood would be
    // `{ code: null, signal: "SIGTERM" }` — the same dead process to a shell, and a database
    // and a pty that nobody closed.
    expect(await board.stop()).toEqual({ code: 0, signal: null });
    await expect(got(board, "/")).rejects.toThrow();
  });
});
