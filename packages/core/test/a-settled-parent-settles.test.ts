import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** An epic is not what does the work. Nobody has to start one before its stories are
 *  started, and nothing did: an epic whose stories all reached `delivered` while it still
 *  read `planned` was delivered in fact and stuck in the record, because `deliver` was
 *  only legal from `in_progress` and `start` is not legal from a settled tree.
 *
 *  So `epic.deliver` runs from `planned` too, under the same guard. The guard is what
 *  keeps this honest: it refuses an epic with no stories, and refuses one whose stories
 *  are all dropped, so `planned` cannot deliver on nothing. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-21T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const addStory = (epic: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, epic, "another story", state, T, T,
  );

const addEpic = (slug: string, state: string): number =>
  ins(
    "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, tree.release, "another epic", state, T, T,
  );

/** Put the seeded epic back in `planned` without a transition — the record is what this is
 *  about, and `reopen` only ever lands in `in_progress`. */
const epicIsPlanned = (): void => {
  db.prepare("UPDATE epic SET state = 'planned' WHERE id = ?").run(tree.epic);
};

const settleStory = (id: number, state: string): void => {
  db.prepare("UPDATE story SET state = ? WHERE id = ?").run(state, id);
};

const moves = (changes: readonly { entity: string; id: number; verb: string; from: string; to: string }[]) =>
  changes.map((c) => `${c.entity}#${c.id}:${c.verb}:${c.from}→${c.to}`);

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
  epicIsPlanned();
});

describe("a planned epic delivers once every story under it is settled", () => {
  it("is not deliverable while a story is still open", () => {
    const r = engine.may("epic", tree.epic, "deliver");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("not yet delivered or dropped");
  });

  it("is deliverable from planned once the stories are delivered", () => {
    settleStory(tree.story, "delivered");
    const r = engine.may("epic", tree.epic, "deliver");
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.changes[0]?.from).toBe("planned");
    expect(r.ok === true && r.changes[0]?.to).toBe("delivered");
  });

  it("the sweep delivers it, from planned, on its own", () => {
    settleStory(tree.story, "delivered");
    expect(moves(engine.settle())).toEqual([`epic#${tree.epic}:deliver:planned→delivered`]);
    expect(stateOf(db, "epic", tree.epic)).toBe("delivered");
  });

  it("counts a dropped story as settled, so long as one story was delivered", () => {
    settleStory(tree.story, "dropped");
    const done = addStory(tree.epic, "reset-twice", "delivered");
    expect(moves(engine.settle())).toEqual([`epic#${tree.epic}:deliver:planned→delivered`]);
    expect(stateOf(db, "story", done)).toBe("delivered");
  });

  it("carries up from the story that settled last, without a sweep", () => {
    settleStory(tree.story, "delivered");
    const last = addStory(tree.epic, "reset-twice", "in_progress");
    const r = engine.apply("story", last, "drop", "chief");
    expect(r.ok).toBe(true);
    expect(r.ok === true && moves(r.changes)).toEqual([
      `story#${last}:drop:in_progress→dropped`,
      `epic#${tree.epic}:deliver:planned→delivered`,
    ]);
  });

  it("attributes the sweep's delivery to settle, as an automatic transition", () => {
    settleStory(tree.story, "delivered");
    const [change] = engine.settle();
    expect(change?.actor).toBe("settle");
    expect(change?.automatic).toBe(true);
    expect(change?.reason).toBe(null);
  });

  it("writes the ledger line as planned → delivered", () => {
    settleStory(tree.story, "delivered");
    engine.settle();
    const row = db
      .prepare("SELECT from_state, to_state, actor FROM ledger WHERE entity = 'epic' AND verb = 'deliver'")
      .get() as unknown as { from_state: string; to_state: string; actor: string };
    expect(row).toEqual({ from_state: "planned", to_state: "delivered", actor: "settle" });
  });
});

describe("planned delivers on the same terms in_progress always did", () => {
  it("refuses a planned epic with no stories at all", () => {
    const empty = addEpic("no-stories", "planned");
    const r = engine.may("epic", empty, "deliver");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("nothing proves it");
    expect(engine.settle().filter((c) => c.entity === "epic")).toEqual([]);
  });

  it("refuses a planned epic whose every story was dropped", () => {
    settleStory(tree.story, "dropped");
    const r = engine.may("epic", tree.epic, "deliver");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("drop it rather than delivered it");
    expect(stateOf(db, "epic", tree.epic)).toBe("planned");
  });

  it("leaves a planned epic planned when a sibling epic is the settled one", () => {
    const other = addEpic("recovery-two", "planned");
    addStory(other, "reset-two", "delivered");
    engine.settle();
    expect(stateOf(db, "epic", other)).toBe("delivered");
    expect(stateOf(db, "epic", tree.epic)).toBe("planned");
  });

  it("still delivers an in_progress epic the way it always did", () => {
    db.prepare("UPDATE epic SET state = 'in_progress' WHERE id = ?").run(tree.epic);
    settleStory(tree.story, "delivered");
    expect(moves(engine.settle())).toEqual([`epic#${tree.epic}:deliver:in_progress→delivered`]);
  });

  it("does not open a way out of on_hold: deliver stays illegal there", () => {
    db.prepare("UPDATE epic SET state = 'on_hold' WHERE id = ?").run(tree.epic);
    settleStory(tree.story, "delivered");
    expect(engine.may("epic", tree.epic, "deliver").ok).toBe(false);
    expect(engine.settle().filter((c) => c.entity === "epic")).toEqual([]);
  });
});
