/** The lease goes stale after three of the holder's own intervals. Renewed at the end of a
 *  tick, a tick longer than three intervals makes a working runner look dead; on its own
 *  timer it does not. These tests hold the beat against the real lease, with the clock
 *  faked, so "the tick is slow" and "the process is gone" stop being the same observation. */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaseIsStale, open, readLease, renewLease, takeLease } from "@wecode/core";
import { startHeartbeat } from "../src/heartbeat.js";
import { tmp } from "../../core/test/tmpdir.js";
import { join } from "node:path";

const EVERY = 15_000;
const T0 = "2026-09-19T10:00:00.000Z";
/** Longer than three intervals: the point past which the old, end-of-tick renewal was late. */
const A_LONG_TICK = 4 * EVERY;

let db: DatabaseSync;

/** Wall-clock time as the lease reads it, driven by the same fake timers the beat runs on. */
const at = (): string => new Date(Date.now()).toISOString();
const stale = (): boolean => {
  const l = readLease(db);
  return l !== null && leaseIsStale(l, at());
};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(T0) });
  db = open(join(tmp(), "wecode.db"));
  expect(takeLease(db, "me", EVERY, at()).ok).toBe(true);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

/** The lease as the beat renews it: the holder's clock is the fake one, not `now()`'s. */
const port = (holder = "me") => ({
  everyMs: EVERY,
  renew: () => renewLease(db, holder, at()),
});

describe("the heartbeat", () => {
  it("beats on its own clock while a tick that never returns is still running", async () => {
    const hb = startHeartbeat(port());
    // No tick ever completes in here — nothing calls back, nothing awaits. The old renewal
    // point is never reached.
    await vi.advanceTimersByTimeAsync(A_LONG_TICK);
    expect(stale(), "a runner working through a long tick looks dead").toBe(false);
    expect(readLease(db)?.heartbeat).toBe(at());
    hb.stop();
  });

  it("goes stale when the beat is the thing that stopped", async () => {
    const hb = startHeartbeat(port());
    await vi.advanceTimersByTimeAsync(EVERY);
    hb.stop();
    await vi.advanceTimersByTimeAsync(A_LONG_TICK);
    expect(stale(), "a process that is gone must still lose its lease").toBe(true);
  });

  it("beats once per interval, and not once per tick", async () => {
    const beats: string[] = [];
    const hb = startHeartbeat({ ...port(), renew: () => (beats.push(at()), true) });
    await vi.advanceTimersByTimeAsync(3 * EVERY);
    expect(beats).toEqual([
      "2026-09-19T10:00:15.000Z",
      "2026-09-19T10:00:30.000Z",
      "2026-09-19T10:00:45.000Z",
    ]);
    hb.stop();
  });

  it("stops, and says so, when the lease is taken from under the holder", async () => {
    const lost = vi.fn();
    const hb = startHeartbeat({ ...port(), onLost: lost });
    // Three intervals of silence would be needed for a rival to take it honestly; the beat
    // only has to notice that the holder of record is someone else.
    vi.setSystemTime(Date.parse(T0) + 4 * EVERY);
    expect(takeLease(db, "rival", EVERY, at()).ok).toBe(true);

    await vi.advanceTimersByTimeAsync(EVERY);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(hb.running()).toBe(false);
    expect(readLease(db)?.holder).toBe("rival");

    // And it does not beat on: a lost lease is not renewed a second time.
    await vi.advanceTimersByTimeAsync(A_LONG_TICK);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("beats out of turn on the way in, so the first tick starts on a fresh lease", async () => {
    const hb = startHeartbeat(port());
    vi.setSystemTime(Date.parse(T0) + 2 * EVERY);
    hb.beat();
    expect(readLease(db)?.heartbeat).toBe("2026-09-19T10:00:30.000Z");
    hb.stop();
  });

  it("stops when the runner is asked to stop", async () => {
    const stop = new AbortController();
    const hb = startHeartbeat({ ...port(), signal: stop.signal });
    stop.abort();
    expect(hb.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(A_LONG_TICK);
    expect(stale()).toBe(true);
  });

  it("is not a reason for the process to stay alive", () => {
    const hb = startHeartbeat(port());
    expect(vi.getTimerCount()).toBe(1);
    hb.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
