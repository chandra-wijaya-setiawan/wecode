#!/usr/bin/env node
/** The cockpit, wired to a terminal. Everything decided lives in App, everything drawn in
 *  screens.tsx; this file only owns the terminal — raw keys in, a frame out, and a
 *  terminal left the way it was found however the process ends. */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { useEffect, useReducer } from "react";
import { render, useInput, useStdin } from "ink";
import { currentDatabase, databaseOf, currentWorkspace, listWorkspaces, open } from "@wecode/core";
import { App } from "./app.js";
import { Cockpit } from "./screens.js";
import { loadViews } from "./views.js";

const CSI = "\u001b[";
const HOME = `${CSI}2J${CSI}H`;
const HIDE = `${CSI}?25l`;
const SHOW = `${CSI}?25h`;
/** Work moves without a keystroke, so the frame cannot only be redrawn by one. */
const TICK = 2000;

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.emitWarning(w);
});

const { values } = parseArgs({
  options: { workspace: { type: "string" }, db: { type: "string" } },
});

const dbPath =
  values.db ?? (values.workspace === undefined ? currentDatabase() : databaseOf(values.workspace));

// Never create one. A board is for looking at work that exists, and open() would happily
// write an empty workspace wherever you happened to be standing.
if (!existsSync(dbPath)) {
  const known = listWorkspaces();
  process.stderr.write(
    `no wecode workspace at ${dbPath}\n` +
      (known.length === 0
        ? "  wecode onboard   in a repository, to make one\n"
        : `  workspaces: ${known.join(", ")}\n  wecode-tui --workspace <name>\n`),
  );
  process.exit(1);
}

const db = open(dbPath);
const app = new App(db, loadViews());
// The frame has one line for a message and no other place to say where you are, so the
// workspace is the first thing it says and the first key replaces it.
app.status = `workspace ${values.workspace ?? currentWorkspace()}`;

const ETX = "\u0003";

/** An App is not React state — a key mutates it in place — so a redraw is a bump of a
 *  counter nothing reads. */
function Frame({ leave }: { readonly leave: (code: number) => void }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // Ink reports this off a tty flag that is undefined rather than false on a pipe, and it
  // only leaves useInput alone for an exactly-false isActive.
  const { isRawModeSupported, stdin } = useStdin();
  const raw = isRawModeSupported === true;

  const keys = (input: string): void => {
    for (const k of input) {
      if (k === ETX) return leave(0);
      app.key(k);
      if (app.quit) return leave(0);
    }
    redraw();
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return leave(0);
      if (key.return) app.key("enter");
      else if (key.escape) app.key("esc");
      else if (key.downArrow) app.key("j");
      else if (key.upArrow) app.key("k");
      // A paste arrives as one input of several characters. Each is a key.
      else return keys(input);
      if (app.quit) return leave(0);
      redraw();
    },
    { isActive: raw },
  );

  // A pipe is not a terminal and has no raw mode, so useInput refuses it. The cockpit is
  // still drivable that way — that is how it is tested — so the keys are read directly.
  useEffect(() => {
    if (raw) return;
    const onData = (chunk: Buffer | string): void => keys(chunk.toString());
    stdin?.on("data", onData);
    return () => {
      stdin?.off("data", onData);
    };
  }, [raw, stdin]);

  useEffect(() => {
    const timer = setInterval(() => {
      app.refresh();
      redraw();
    }, TICK);
    return () => clearInterval(timer);
  }, []);

  // The terminal is the size it is now; a resize is another reason to redraw.
  useEffect(() => {
    process.stdout.on("resize", redraw);
    return () => {
      process.stdout.off("resize", redraw);
    };
  }, []);

  return (
    // The same fallbacks Ink lays out against, so the frame is never wider than the
    // buffer it is written into.
    <Cockpit app={app} width={process.stdout.columns ?? 80} height={process.stdout.rows ?? 24} />
  );
}

let closed = false;
/** The one way out. A terminal left in raw mode with no cursor is a shell the operator has
 *  to kill, so every exit — a key, a signal, an error — comes through here. Ink's teardown
 *  runs first: the last frame is its to write, and the cursor is ours to give back. */
const leave = (code: number): void => {
  if (closed) return process.exit(code);
  closed = true;
  instance.unmount();
  void instance.waitUntilExit().then(() => {
    process.stdout.write(`${SHOW}${HOME}`);
    db.close();
    process.exit(code);
  });
};

process.stdout.write(HIDE);

// Ink writes nothing until it exits when it decides it is not talking to a terminal. The
// cockpit is watched through a pipe as readily as on a tty — by a test, by a tee — and a
// board that only appears once the process is dead is no board.
const instance = render(<Frame leave={leave} />, {
  stdout: process.stdout,
  stdin: process.stdin,
  interactive: true,
  exitOnCtrlC: false,
  patchConsole: false,
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => leave(0));
