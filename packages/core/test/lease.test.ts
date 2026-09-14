import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  heldMessage,
  leaseAgeMs,
  leaseIsStale,
  readLease,
  releaseLease,
  renewLease,
  runnerId,
  STALE_INTERVALS,
  takeLease,
  type Lease,
} from "../src/index.js";
import { freshDb } from "./helpers.js";

const EVERY = 15_000;
const T0 = "2026-09-14T10:00:00.000Z";
const at = (msAfter: number): string => new Date(Date.parse(T0) + msAfter).toISOString();

let db: DatabaseSync;

beforeEach(() => {
  db = freshDb();
});

describe("the runner lease", () => {
  it("starts with nobody holding it", () => {
    expect(readLease(db)).toBeNull();
  });

  it("is taken by the first runner, which is then the holder of record", () => {
    const taken = takeLease(db, "a", EVERY, T0);
    expect(taken.ok).toBe(true);
    expect(readLease(db)).toEqual({ holder: "a", intervalMs: EVERY, takenAt: T0, heartbeat: T0 });
  });

  it("refuses a second runner while the first is live, and names it", () => {
    takeLease(db, "a", EVERY, T0);
    const taken = takeLease(db, "b", EVERY, at(20_000));
    expect(taken.ok).toBe(false);
    if (taken.ok) return;
    expect(taken.held.holder).toBe("a");
    expect(taken.ageMs).toBe(20_000);
    expect(readLease(db)?.holder).toBe("a"); // a refusal does not disturb the holder
  });

  it("holds only one row, so a second runner cannot insert its own", () => {
    takeLease(db, "a", EVERY, T0);
    takeLease(db, "b", EVERY, at(10 * STALE_INTERVALS * EVERY));
    expect(db.prepare("SELECT count(*) AS n FROM runner_lease").get()).toEqual({ n: 1 });
    expect(() =>
      db
        .prepare("INSERT INTO runner_lease (id,holder,interval_ms,taken_at,heartbeat) VALUES (2,?,?,?,?)")
        .run("c", EVERY, T0, T0),
    ).toThrow();
  });

  it("counts staleness in the holder's own intervals, not the taker's", () => {
    const held: Lease = { holder: "a", intervalMs: EVERY, takenAt: T0, heartbeat: T0 };
    expect(leaseIsStale(held, at(STALE_INTERVALS * EVERY))).toBe(false);
    expect(leaseIsStale(held, at(STALE_INTERVALS * EVERY + 1))).toBe(true);
    expect(leaseAgeMs(held, at(1234))).toBe(1234);
  });

  it("lets a runner take over a lease whose heartbeat has missed three intervals", () => {
    takeLease(db, "a", EVERY, T0);
    const early = takeLease(db, "b", EVERY, at(2 * EVERY));
    expect(early.ok).toBe(false);

    const late = takeLease(db, "b", EVERY, at(STALE_INTERVALS * EVERY + 1));
    expect(late.ok).toBe(true);
    expect(readLease(db)?.holder).toBe("b");
  });

  it("renews the heartbeat of the holder, and only of the holder", () => {
    takeLease(db, "a", EVERY, T0);
    expect(renewLease(db, "a", at(EVERY))).toBe(true);
    expect(readLease(db)?.heartbeat).toBe(at(EVERY));

    expect(renewLease(db, "b", at(2 * EVERY))).toBe(false);
    expect(readLease(db)?.heartbeat).toBe(at(EVERY)); // b's renewal moved nothing
  });

  it("keeps a renewing holder from ever going stale", () => {
    takeLease(db, "a", EVERY, T0);
    for (let tick = 1; tick <= 10; tick += 1) renewLease(db, "a", at(tick * EVERY));
    expect(takeLease(db, "b", EVERY, at(10 * EVERY)).ok).toBe(false);
  });

  it("tells a holder that lost the lease that it is no longer of record", () => {
    takeLease(db, "a", EVERY, T0);
    takeLease(db, "b", EVERY, at(STALE_INTERVALS * EVERY + 1));
    expect(renewLease(db, "a", at(STALE_INTERVALS * EVERY + 2))).toBe(false);
  });

  it("renews rather than deadlocks when the same runner takes it twice", () => {
    takeLease(db, "a", EVERY, T0);
    const again = takeLease(db, "a", EVERY, at(EVERY));
    expect(again.ok).toBe(true);
    expect(readLease(db)?.heartbeat).toBe(at(EVERY));
  });

  it("releases the lease so the next runner need not wait out three intervals", () => {
    takeLease(db, "a", EVERY, T0);
    releaseLease(db, "a");
    expect(readLease(db)).toBeNull();
    expect(takeLease(db, "b", EVERY, at(1)).ok).toBe(true);
  });

  it("ignores a release from a runner that does not hold it", () => {
    takeLease(db, "a", EVERY, T0);
    releaseLease(db, "b");
    expect(readLease(db)?.holder).toBe("a");
  });

  it("names the holder and its age in the refusal message", () => {
    takeLease(db, "a-host/4242", EVERY, T0);
    const taken = takeLease(db, "b", EVERY, at(20_000));
    expect(taken.ok).toBe(false);
    if (taken.ok) return;
    const message = heldMessage(taken.held, taken.ageMs);
    expect(message).toContain("a-host/4242");
    expect(message).toContain("20s ago");
    expect(message).toContain("every 15s");
    expect(message).toContain(T0);

    const old: Lease = { holder: "a", intervalMs: 60_000, takenAt: T0, heartbeat: T0 };
    expect(heldMessage(old, 90_000)).toContain("1m30s ago");
  });

  it("names a runner by a host and a pid, so a person can go and look", () => {
    expect(runnerId(4242)).toMatch(/^.+\/4242$/);
    expect(runnerId(1)).not.toBe(runnerId(2));
  });
});
