/** A runner died about forty minutes in. The log simply stopped: no line saying why, and
 *  nothing on the board but an idle fleet. Two things were missing, and this file holds the
 *  first of them — the process itself says, on its way out, what stopped it.
 *
 *  The runner is spawned for real, from its built entry, and really signalled: a stub could
 *  be made to print anything, and what is in doubt here is whether a dying node process gets
 *  its last line out at all. So the assertions are on the bytes that arrived on the pipe. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { open, readLease, takeLease } from "@wecode/core";
import { tmp } from "../../core/test/tmpdir.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const bin = join(repo, "packages/runner/dist/bin.js");

/** The entry is compiled, so a stale `dist` would prove yesterday's source. `tsc -b` is
 *  incremental and a no-op when nothing moved; when `bin.ts` moved, it is the point. */
beforeAll(() => {
  const built = spawnSync("pnpm", ["exec", "tsc", "-b", "packages/runner"], {
    cwd: repo,
    encoding: "utf8",
  });
  expect(built.stdout + built.stderr, "the runner must build before it can be run").toBe("");
}, 120_000);

/** A workspace of its own, so one test's lease is never another's. Opened and closed once
 *  to create and migrate it: the runner refuses a path that is not already a workspace. */
const workspace = (): string => {
  const db = join(tmp("wecode-stops-"), "wecode.db");
  open(db).close();
  return db;
};

const INTERVAL = 1;

/** A module to `--import` into the runner, which throws at it from a timer a second in —
 *  late enough that the process is past startup and its handlers are up. Returns its path. */
function fault(message: string): string {
  const file = join(tmp("wecode-fault-"), "fault.mjs");
  writeFileSync(file, `setTimeout(() => { throw new Error(${JSON.stringify(message)}); }, 1000);\n`);
  return file;
}

let running: ChildProcessWithoutNullStreams | null = null;

afterEach(() => {
  running?.kill("SIGKILL");
  running = null;
});

interface Started {
  readonly child: ChildProcessWithoutNullStreams;
  /** Everything written to either stream, in arrival order — the log as a reader sees it. */
  readonly log: () => string;
  /** Resolves with the exit code once the process is gone. */
  readonly ended: Promise<number | null>;
}

/** Starts the real runner against `db` and waits until it has said hello, so that a signal
 *  sent next is delivered to a process that is past startup and into its loop. */
async function start(db: string, preload: readonly string[] = []): Promise<Started> {
  const argv = [...preload, bin, "--db", db, "--interval", String(INTERVAL)];
  const child = spawn(process.execPath, argv, { cwd: repo }) as ChildProcessWithoutNullStreams;
  running = child;
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (log += c));
  child.stderr.on("data", (c: string) => (log += c));
  const ended = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  await until(() => log.includes("wecode-runner"), ended);
  return { child, log: () => log, ended };
}

/** Polls until `ready`, or until the process dies first — in which case the log it managed
 *  to write is worth more than a timeout, so the wait ends rather than hanging. */
async function until(ready: () => boolean, ended: Promise<number | null>): Promise<void> {
  let gone = false;
  void ended.then(() => (gone = true));
  for (let i = 0; i < 600 && !ready() && !gone; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The last non-empty line of the log — the final line, literally. */
const finalLine = (log: string): string => {
  const lines = log.split("\n").filter((l) => l.trim() !== "");
  return lines[lines.length - 1] ?? "";
};

describe("a runner that is stopped", () => {
  it("writes a final line naming the signal, and it is the last thing it says", async () => {
    const run = await start(workspace());
    run.child.kill("SIGTERM");
    await run.ended;

    expect(finalLine(run.log())).toMatch(/^\S+ {2}stopped SIGTERM$/);
  });

  it("names SIGINT as SIGINT — the line says which signal, not merely that there was one", async () => {
    const run = await start(workspace());
    run.child.kill("SIGINT");
    await run.ended;

    expect(finalLine(run.log())).toMatch(/^\S+ {2}stopped SIGINT$/);
    expect(run.log()).not.toContain("SIGTERM");
  });

  it("dates the line, so the log says when the runner went as well as why", async () => {
    const run = await start(workspace());
    run.child.kill("SIGTERM");
    await run.ended;

    const [stamp] = finalLine(run.log()).split("  ");
    expect(new Date(stamp ?? "").toISOString(), "a timestamp a reader can line up").toBe(stamp);
  });

  it("says it once, however many signals arrive", async () => {
    const run = await start(workspace());
    run.child.kill("SIGTERM");
    run.child.kill("SIGTERM");
    run.child.kill("SIGINT");
    await run.ended;

    expect(run.log().match(/ {2}stopped /g)).toHaveLength(1);
  });

  it("lets the lease go on the way out, so the seat is not held by a process that is gone", async () => {
    const db = workspace();
    const run = await start(db);
    run.child.kill("SIGTERM");
    await run.ended;

    const store = open(db);
    expect(readLease(store)).toBeNull();
    store.close();
  });

  it("names the holder when the reason is that the lease was taken away", async () => {
    const db = workspace();
    const run = await start(db);

    // A rival takes the workspace from under it. Honestly: it asks at a time by which the
    // held lease has missed its three intervals, which is the only way one is ever taken.
    const store = open(db);
    const later = new Date(Date.now() + 10 * INTERVAL * 1000).toISOString();
    expect(takeLease(store, "rival/1", INTERVAL * 1000, later).ok).toBe(true);
    store.close();

    await run.ended;
    expect(finalLine(run.log())).toMatch(/^\S+ {2}stopped lost the runner lease to rival\/1$/);
  }, 20_000);

  it("names an error it dies of, which is the death that used to leave no line at all", async () => {
    // A signal is a death the operator caused and already knows about; this is the other
    // one. `loop` catches everything a tick throws and carries on, so the crash that ends a
    // runner is by construction one that arrives from outside a tick — a stray timer, a
    // rejected promise nobody awaited. That is injected here rather than provoked: what is
    // under test is the handler, and the only honest way to reach it is to throw at it.
    const run = await start(workspace(), ["--import", fault("the disk went away")]);

    expect(await run.ended, "a runner that threw must not exit as though it had finished").toBe(1);
    expect(finalLine(run.log())).toMatch(/^\S+ {2}stopped Error: the disk went away$/);
  }, 20_000);
});
