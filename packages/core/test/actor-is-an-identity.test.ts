/** The actor of a transition is an identity — who did it — and the reason it was given is
 *  a separate thing with a name and a field of its own.
 *
 *  Half of the story is here and half is not. The ledger still keeps who and why in its one
 *  `actor` column, and will until a migration gives the reason a column of its own:
 *  `packages/core/sql/**` and `Repo.setState` are outside this story's scope, so that half
 *  cannot be made green here. What is proved is everything short of the column — the
 *  identity is parsed and checked in one place, the reason is a parameter and a field
 *  rather than something a caller sticks on the front of a name, and the text the ledger
 *  keeps is the two of them joined at exactly one expression per writing boundary. When the
 *  column arrives, that expression is what it replaces, and these tests are what say so. */
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ANYBODY,
  CASCADE,
  Engine,
  NO_ACTOR,
  SETTLE,
  TWO_REASONS,
  identity,
  restate,
} from "../src/index.js";
import { recordAttemptCommit } from "./db.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
  recordRed(db, tree.acceptance);
});

const lastLedger = (): { actor: string; verb: string } =>
  db.prepare("SELECT actor, verb FROM ledger ORDER BY id DESC LIMIT 1").get() as unknown as {
    actor: string;
    verb: string;
  };

describe("identity(): the one place a ledger string is read back as who and why", () => {
  it("reads a bare name as an identity with no reason", () => {
    expect(identity("chandra")).toEqual({ actor: "chandra", reason: null });
    expect(identity("agent/mairead")).toEqual({ actor: "agent/mairead", reason: null });
  });

  it("splits a packed actor into who and why", () => {
    expect(identity("chief: the first two attempts ran out of budget")).toEqual({
      actor: "chief",
      reason: "the first two attempts ran out of budget",
    });
  });

  it("keeps a reason that contains the separator whole", () => {
    expect(identity('chief: was "ship: the binary"')).toEqual({
      actor: "chief",
      reason: 'was "ship: the binary"',
    });
  });

  it("names nobody when there is no name", () => {
    expect(identity("").actor).toBe("");
    expect(identity("   ").actor).toBe("");
    expect(identity(": a reason with nobody behind it").actor).toBe("");
  });
});

describe("apply() takes the identity and the reason apart", () => {
  it("reports each as its own field of the change", () => {
    const r = engine.apply("task", tree.task, "start", "chief", "the mailer host is up now");
    expect(r.ok).toBe(true);
    expect(r.ok && r.changes[0]).toMatchObject({
      actor: "chief",
      reason: "the mailer host is up now",
    });
  });

  it("leaves the reason null when the caller gave none", () => {
    const r = engine.apply("task", tree.task, "start", "chief");
    expect(r.ok && r.changes[0]?.actor).toBe("chief");
    expect(r.ok && r.changes[0]?.reason).toBe(null);
  });

  it("refuses a transition with nobody behind it, and writes nothing", () => {
    const r = engine.apply("task", tree.task, "start", "  ");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toBe(NO_ACTOR);
    expect(stateOf(db, "task", tree.task)).toBe("planned");
  });

  it("refuses an actor that packs a reason when a reason was also passed", () => {
    const r = engine.apply("task", tree.task, "start", "chief: because", "because");
    expect(!r.ok && r.why).toBe(TWO_REASONS);
    expect(stateOf(db, "task", tree.task)).toBe("planned");
  });

  it("checks who is asking before it reads the row", () => {
    const r = engine.apply("task", 9999, "start", "");
    expect(!r.ok && r.why).toBe(NO_ACTOR);
  });

  it("still takes an already-packed actor, and identifies the identity in it", () => {
    // `wecode task retry --reason` packs the two halves through `attributedTo`, in
    // cli/src/run.ts, which is outside this story's scope. It keeps working.
    const r = engine.apply("task", tree.task, "start", "operator: a third attempt is worth it");
    expect(r.ok && r.changes[0]).toMatchObject({
      actor: "operator",
      reason: "a third attempt is worth it",
    });
  });
});

describe("the ledger line: one expression joins the two halves back", () => {
  it("writes who and why into the column the schema still gives them both", () => {
    engine.apply("task", tree.task, "start", "chief", "the mailer host is up now");
    expect(lastLedger()).toEqual({ verb: "start", actor: "chief: the mailer host is up now" });
  });

  it("writes the bare identity when there is no reason", () => {
    engine.apply("task", tree.task, "start", "chief");
    expect(lastLedger()).toEqual({ verb: "start", actor: "chief" });
  });

  it("is byte-identical whether the caller packed the reason or passed it", () => {
    engine.apply("task", tree.task, "start", "operator: a third attempt is worth it");
    const packedByCaller = lastLedger().actor;

    const second = freshDb();
    const other = seed(second);
    new Engine(second).apply("task", other.task, "start", "operator", "a third attempt is worth it");
    const passedApart = (
      second.prepare("SELECT actor FROM ledger ORDER BY id DESC LIMIT 1").get() as unknown as {
        actor: string;
      }
    ).actor;

    expect(passedApart).toBe(packedByCaller);
  });

  it("puts an identity on every line it writes, never a sentence with nobody's name", () => {
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    engine.apply("acceptance_test", tree.acceptance, "pass", "runner", "the mail arrived");

    const rows = db.prepare("SELECT actor FROM ledger").all() as unknown as { actor: string }[];
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(identity(row.actor).actor).not.toBe("");
  });
});

describe("a transition nobody invoked still has an identity", () => {
  // There is an automatic change to attribute only if the task can finish, and `finish`
  // asks for a commit of the task's own as well as settled tests.
  beforeEach(() => recordAttemptCommit(db, tree.task));

  it("attributes a cascaded change to the cascade", () => {
    engine.apply("task", tree.task, "start", "chief");
    const r = engine.apply("task_test", tree.taskTest, "pass", "runner");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const automatic = r.changes.filter((c) => c.automatic);
    expect(automatic.length).toBeGreaterThan(0);
    for (const c of automatic) {
      expect({ actor: c.actor, reason: c.reason }).toEqual({ actor: CASCADE, reason: null });
    }
  });

  it("attributes a settled change to the sweep that fired it", () => {
    engine.apply("task", tree.task, "start", "chief");
    db.prepare("UPDATE task_test SET state = 'passed' WHERE id = ?").run(tree.taskTest);
    const changes = engine.settle();
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect({ actor: c.actor, reason: c.reason }).toEqual({ actor: SETTLE, reason: null });
    }
  });

  it("attributes a question to nobody in particular", () => {
    const r = engine.may("task", tree.task, "start");
    expect(r.ok && r.changes[0]).toMatchObject({ actor: ANYBODY, reason: null });
  });
});

describe("restate() keeps the reason apart too", () => {
  it("joins the identity and the old wording at the one boundary that writes the row", () => {
    restate(db, "task", tree.task, "send the reset mail promptly", "chief");
    expect(lastLedger()).toEqual({ verb: "restate", actor: 'chief: was "send the reset mail"' });
  });

  it("refuses a correction with nobody behind it", () => {
    expect(() => restate(db, "task", tree.task, "something else", " ")).toThrow(NO_ACTOR);
    expect(db.prepare("SELECT count(*) AS n FROM ledger").get()).toEqual({ n: 0 });
  });

  it("refuses an actor that brought its own reason: this verb's reason is the old wording", () => {
    expect(() =>
      restate(db, "task", tree.task, "something else", "chief: I typed it wrong"),
    ).toThrow(TWO_REASONS);
    expect(db.prepare("SELECT count(*) AS n FROM ledger").get()).toEqual({ n: 0 });
  });
});
