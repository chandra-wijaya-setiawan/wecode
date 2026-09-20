/** A test that starts the cockpit as a process owes the machine its death.
 *
 *  Two of the tests in here drive the built binary: `screens.test.ts` pipes it, and
 *  `pty-harness.test.ts` puts it behind util-linux's `script` in a terminal of its own.
 *  Either one can leave a node process running — the assertion fails before the kill, the
 *  harness throws while opening and never hands back the handle to close, or `script` is
 *  killed outright and the node it wrapped is reparented away from the suite. None of that
 *  shows up as a red test. It shows up an hour later as a machine with forty cockpits on
 *  it, each holding a database file open.
 *
 *  So the rule is: every process a test spawns is killed in `afterEach`, and a sweep after
 *  the kill catches anything that got away from its handle. This file is the proof. It
 *  spawns cockpits all three ways — piped, in a pty, and with no handle kept at all — and
 *  then asks the process table whether any of them is still alive.
 *
 *  What makes the question answerable on a machine that is also running other work is the
 *  database path: every cockpit here is pointed at one temporary directory made for this
 *  file, so "a process of ours" is "a process with that path in its command line", and a
 *  cockpit another suite or another session left behind is not mistaken for one of ours. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { open } from "@wecode/core";
import { seed } from "./seed.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

let dir: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wecode-leak-"));
  db = join(dir, "wecode.db");
  const handle = open(db);
  seed(handle);
  handle.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Running {
  readonly pid: number;
  readonly args: string;
}

/** The process table, whole. `ps -e` rather than a walk from this process: an orphan whose
 *  parent was killed is reparented to init and is no longer anybody's descendant, and an
 *  orphan is the leak this is looking for. */
const table = (): Running[] =>
  execFileSync("ps", ["-e", "-o", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
      return row === null ? [] : [{ pid: Number(row[1]), args: row[2] ?? "" }];
    });

/** Every process still alive that this file started, named by the workspace it was pointed
 *  at. The `ps` call itself and the shell around it never mention the path, so nothing here
 *  can see itself. */
const ours = (): Running[] => table().filter((p) => p.args.includes(dir) && p.pid !== process.pid);

const spawned: ChildProcess[] = [];

/** A cockpit as `screens.test.ts` starts one: the binary on a pipe. */
const piped = (): ChildProcess => spawn(process.execPath, [BIN, "--db", db], { stdio: ["pipe", "pipe", "pipe"] });

/** A cockpit as `pty-harness.test.ts` starts one: `script` allocates the terminal and the
 *  binary runs inside it, so there are two processes and only the outer one has a handle. */
const inATerminal = (): ChildProcess =>
  spawn("script", ["-qfec", `stty rows 40 cols 100; exec node '${BIN}' --db '${db}'`, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

/** Wait until the cockpit has said something, so the test is killing a process that got as
 *  far as drawing rather than one that had not started yet. */
const drew = async (child: ChildProcess, ms = 15_000): Promise<void> => {
  let out = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
  });
  const started = Date.now();
  while (!out.includes("q quit")) {
    if (Date.now() - started > ms) throw new Error(`the cockpit drew nothing in ${ms}ms:\n${out}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/** Kill everything this test started and wait for the table to agree. Handles first, since
 *  a handle can be waited on; then the sweep, for whatever had no handle or outlived the
 *  one it had. SIGKILL rather than SIGTERM: this is not a shutdown the cockpit gets to
 *  refuse, and a terminal left dirty is a pty's problem, not the suite's. */
const killEverything = async (ms = 15_000): Promise<void> => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const started = Date.now();
  for (;;) {
    const left = ours();
    if (left.length === 0) return;
    for (const p of left) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        /* it left between the listing and the signal, which is the outcome wanted */
      }
    }
    if (Date.now() - started > ms) throw new Error(`still alive: ${left.map((p) => `${p.pid} ${p.args}`).join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

afterEach(killEverything);

/** What each test leaves for the last one to check. A test cannot look at its own
 *  `afterEach`, so it records the pids it started and the test after it reads them back. */
const started: number[] = [];

const remember = (...children: ChildProcess[]): void => {
  for (const child of children) {
    spawned.push(child);
    if (child.pid !== undefined) started.push(child.pid);
  }
};

describe("a test that spawns a cockpit", () => {
  it("leaves nothing of a piped one behind", async () => {
    const child = piped();
    remember(child);
    await drew(child);
    expect(ours()).toHaveLength(1);
  }, 30_000);

  it("leaves nothing of one in a terminal behind, wrapper and cockpit both", async () => {
    const child = inATerminal();
    remember(child);
    await drew(child);
    // Two processes, one handle: `script` and the node it wrapped. Killing the handle is
    // not enough on its own, which is the whole reason the sweep exists.
    expect(ours()).toHaveLength(2);
  }, 30_000);

  it("leaves nothing of one it never got a handle for behind", async () => {
    // The shape of a harness that throws while starting: the process is up, the test has no
    // way to name it, and only the sweep can find it.
    const child = inATerminal();
    if (child.pid !== undefined) started.push(child.pid);
    await drew(child);
    expect(ours().length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("leaves nothing of one that was already gone behind", async () => {
    const child = piped();
    remember(child);
    await drew(child);
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    // Killing twice is not an error, and the sweep finds nothing to do.
    expect(gone(child.pid ?? 0)).toBe(true);
  }, 30_000);
});

describe("the suite behind it", () => {
  it("has no cockpit of its own still running", () => {
    expect(ours()).toEqual([]);
  });

  it("has killed every process any test before this one started", () => {
    expect(started.length).toBeGreaterThanOrEqual(4);
    expect(started.filter((pid) => !gone(pid))).toEqual([]);
  });
});
