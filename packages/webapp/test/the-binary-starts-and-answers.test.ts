/** The binary starts, and answers.
 *
 *  Every other file in this directory proves what the surface says by calling the code that
 *  says it. That is the right way to state what a page is — and it is also how a board that
 *  could not boot at all stayed green: `pages/shell.ts` imported a browser library, node
 *  refused the named export before one byte was served, and a build, a typecheck and
 *  twenty-one passing files had nothing to say about it. A module graph that is only ever
 *  loaded by a test runner is not the module graph the operator runs.
 *
 *  So this file runs the thing that ships. It spawns `dist/bin.js` — the built binary and
 *  not the sources — on a port the operating system picks, waits for the line it prints once
 *  the socket is listening, asks it for two pages over HTTP, and stops it.
 *
 *  What a page *says* is not asked here and must not be: every word of the surface is
 *  already somebody else's statement, and a second copy of it behind a socket would be a
 *  second thing to edit. What is proved here is only that there is a server to say it. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { open } from "@wecode/core";
import { seed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

/** What `wecode-webapp` is: the built file, so that a source which compiles and a binary
 *  which runs are not allowed to be two different things. */
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** How long a board gets to listen before this file calls it dead. Generous, because a slow
 *  machine is not a defect; finite, because a board that never listens must fail as itself
 *  rather than as the runner's own timeout with nothing said. */
const PATIENCE = 20_000;

/** How a board ended: the code it chose, or the signal that ended it instead. Both, because
 *  they are different endings — a code is a board that was asked to go and went, and a
 *  signal is one that had to be killed where it stood. */
interface Left {
  readonly code: number | null;
  readonly signal: string | null;
}

/** A board under this file's hand: where it is, what it has printed, and the way to end it.
 *  The process is the unit here — nothing is imported out of it. */
interface Board {
  readonly at: string;
  readonly said: () => string;
  readonly stop: () => Promise<Left>;
}

const running: Board[] = [];

/** A workspace with one of everything, made once, so that the pages fetched below are
 *  drawing real rows rather than the empty state. */
let db = "";

beforeAll(() => {
  db = join(tmp("wecode-webapp-binary-"), "wecode.db");
  const made = open(db);
  seed(made);
  made.close();
});

afterEach(async () => {
  for (const board of running.splice(0)) await board.stop();
});

/** The binary, spawned, and waited for the way a person waits for it: by reading the line
 *  it prints. That line is written after `serve()` has resolved, which is after the socket
 *  is listening, so it is the one honest signal that the board is up — polling a port would
 *  say "listening" about whatever else happened to be on it.
 *
 *  A process that leaves before it says so is the failure this file exists for, and it is
 *  reported as itself, with whatever it complained about on the way out. */
async function boot(): Promise<Board> {
  // Port 0, so the operating system picks one that is free: a fixed port would collide with
  // the board the person running these tests very likely has open on 4321. A home of its
  // own and a directory of its own too, so a board spawned here cannot read — or be answered
  // by — the workspaces they actually have.
  const child = spawn(process.execPath, [BIN, "--db", db, "--port", "0"], {
    cwd: dirname(db),
    env: { ...process.env, WECODE_HOME: join(dirname(db), "home") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (out += chunk));
  child.stderr.on("data", (chunk: string) => (err += chunk));

  // Waited for from the moment it is spawned, so that stopping a board twice is asking the
  // same ending twice rather than sending a second signal to a process that has already gone
  // and then waiting forever for an exit that has been and gone.
  const left = once(child, "exit") as Promise<[number | null, string | null]>;
  const stop = async (): Promise<Left> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const [code, signal] = await left;
    return { code, signal };
  };

  const board: Board = { at: "", said: () => out, stop };
  running.push(board);

  const at = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the board never listened in ${PATIENCE}ms\n${out}${err}`));
    }, PATIENCE);
    const settle = (act: () => void): void => {
      clearTimeout(timer);
      act();
    };
    child.stdout.on("data", () => {
      const said = /http:\/\/\S+/.exec(out);
      if (said !== null) settle(() => resolve(said[0]));
    });
    child.on("exit", (code) => {
      settle(() =>
        reject(new Error(`the board left with ${String(code)} before it listened\n${err}${out}`)),
      );
    });
  });
  return { ...board, at };
}

/** Whether node can parse a file as a module, and what it says if it cannot. Nothing here
 *  runs the script — there is no browser — but a script served to a browser that is not even
 *  syntax is the same class of defect as a server that will not start. */
async function parses(source: string): Promise<string> {
  const path = join(tmp("wecode-webapp-script-"), "dock.mjs");
  writeFileSync(path, source);
  const child = spawn(process.execPath, ["--check", path], { stdio: ["ignore", "ignore", "pipe"] });
  let complaint = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (complaint += chunk));
  const [code] = (await once(child, "exit")) as [number | null];
  return code === 0 ? "" : complaint;
}

const got = async (board: Board, at: string): Promise<Response> => fetch(`${board.at}${at}`);

/** A whole document, and not a fragment or an error page dressed as one. */
async function documentOf(board: Board, at: string): Promise<string> {
  const reply = await got(board, at);
  expect(reply.status, `${at} answered ${reply.status}`).toBe(200);
  expect(reply.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const body = await reply.text();
  expect(body.startsWith("<!doctype html>"), `${at} is not a document`).toBe(true);
  expect(body.trimEnd().endsWith("</html>")).toBe(true);
  return body;
}

describe("the binary starts and answers", () => {
  it("listens, and prints where it is listening", async () => {
    const board = await boot();
    expect(board.at).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(board.at).not.toContain(":0");
    expect(board.said()).toContain("workspace ");
  });

  it("answers the board, and one other page, with a whole document each", async () => {
    const board = await boot();
    // The board is what the surface opens on; a second page proves the answer is the
    // surface's and not the one route that happens to work.
    expect(await documentOf(board, "/")).toContain("<main>");
    expect(await documentOf(board, "/tasks")).toContain("<main>");
  });

  it("stops when it is told to, and lets the port go", async () => {
    const board = await boot();
    // Asked, and went: a code of its own and no signal. Killed where it stood would be
    // `{ code: null, signal: "SIGTERM" }` — the same dead process to a shell, and a database
    // and a shell's pty that nobody closed.
    expect(await board.stop()).toEqual({ code: 0, signal: null });
    await expect(got(board, "/")).rejects.toThrow();
  });
});

/** The dock's other half, which is the reason the board stopped starting in the first place:
 *  the emulator is a browser library, so it belongs in a file a browser asks for and not in
 *  the module that renders HTML. That the board has those files to give — out of what is on
 *  the operator's disk, and not out of a bundle nothing here builds — is a thing only a
 *  running board can be asked. */
describe("the dock's pane is served to the browser", () => {
  it("serves the pane as javascript that parses", async () => {
    const board = await boot();
    const reply = await got(board, "/terminal.js");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const script = await reply.text();
    expect(await parses(script)).toBe("");
    // The pane it runs is `dock()` itself and the painter's `attach`, imported rather than
    // rewritten: the two files asked for below, and no copy of either.
    expect(script).toContain(`import { attach, encode } from "/terminal.pane.js"`);
    expect(script).toContain(`import { Terminal } from "/terminal.emulator.js"`);
    expect(script).toContain("const dock = function dock(parts, wire, terminal");
    // And it reaches for the dock's own elements, by the selectors the markup is drawn under.
    expect(script).toContain(`[data-ui=\\"shell.dock.output\\"]`);
  });

  it("serves the painter's pane, the emulator and its sheet", async () => {
    const board = await boot();
    for (const [at, type, held] of [
      ["/terminal.pane.js", "text/javascript; charset=utf-8", "export function attach"],
      ["/terminal.emulator.js", "text/javascript; charset=utf-8", "as Terminal"],
      ["/terminal.css", "text/css; charset=utf-8", ".xterm"],
    ] as const) {
      const reply = await got(board, at);
      expect(reply.status, `${at} answered ${reply.status}`).toBe(200);
      expect(reply.headers.get("content-type")).toBe(type);
      expect(await reply.text(), at).toContain(held);
    }
  });
});
