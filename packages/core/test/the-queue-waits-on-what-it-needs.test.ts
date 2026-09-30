/** The allocator's pass, step 3: *drop any whose prerequisite has not finished* — and then,
 *  among the ones left, which to try first.
 *
 *  Both facts are about a story and both are asked of a task, because a task is what the
 *  allocator hands to a worker. So each proof here builds whole stories — requirement,
 *  criteria, acceptance test, task — and asks `readyCandidates` about the tasks at the
 *  bottom of them.
 *
 *  The edges and the priorities arrive as a `StoryQueue` value, the way `depends.ts` holds
 *  them; `depends.ts` is not re-exported through `index.ts`, so `dependsOn` is imported from
 *  the module itself. The prerequisite's *state* is the one thing the caller cannot say: it
 *  is read from the record, so every release below is proved by moving a story in the
 *  database and asking again. */
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, UNORDERED, open, readyCandidates, type StoryQueue } from "../src/index.js";
import { NO_DEPENDENCIES, dependsOn } from "../src/depends.js";
import { tmp } from "./tmpdir.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let epic: number;

/** A ready task under an existing story, with its own requirement, criteria and acceptance
 *  test so no two tasks share a parent and the climb from a task has exactly one answer. */
function readyTaskUnder(story: number, name: string, write: string): number {
  const criteria = make.criteria(make.requirement(story, `${name} requirement`), `${name} criteria`);
  const at = make.acceptanceTest(criteria, `${name} proof`, "script", "bash x.sh");
  const task = make.task(at, `${name} work`, { scope: { write: [write], tools: [] }, role: "engineer" });
  engine.apply("task_test", make.taskTest(task, `${name} unit`, "script", "vitest run"), "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  return task;
}

/** A whole story with one ready task under it. */
function storyWithTask(name: string, write: string): { story: number; task: number } {
  const story = make.story(epic, name);
  return { story, task: readyTaskUnder(story, name, write) };
}

/** Put a story in a state. The queue reads a prerequisite's state out of the record, so a
 *  fixture that means to settle one has to write it there. */
const setState = (story: number, state: string): void => {
  db.prepare("UPDATE story SET state = ? WHERE id = ?").run(state, story);
};

const ids = (queue?: StoryQueue): readonly number[] =>
  readyCandidates(db, queue).map((c) => c.id);

const needs = (dependent: number, prerequisite: number): StoryQueue => ({
  depends: dependsOn(NO_DEPENDENCIES, dependent, prerequisite),
  priority: {},
});

const ranked = (priority: Record<number, number>): StoryQueue => ({
  depends: NO_DEPENDENCIES,
  priority,
});

beforeEach(() => {
  db = open(join(tmp(), "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const project = make.project(make.workspace("acme", "/acme"), "storefront", "/repo");
  epic = make.epic(make.release(project, "1.0.0"), "checkout");
});

describe("a task whose story waits on another is no candidate", () => {
  it("leaves out the waiting story's task, and keeps the prerequisite's own", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");

    // nothing has settled `cart`: a freshly made story is `planned`
    expect(ids(needs(checkout.story, cart.story))).toEqual([cart.task]);
    expect(ids(needs(checkout.story, cart.story))).not.toContain(checkout.task);
  });

  /** The queue is something a caller opts into. `board`'s queued panel is held against the
   *  bare `readyCandidates(db)` elsewhere, so an undeclared queue must drop nothing at all —
   *  the same list, whether the default is taken or spelled. */
  it("keeps both when no queue is declared, by default and by UNORDERED alike", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");
    const both = [cart.task, checkout.task];

    expect(readyCandidates(db).map((c) => c.id)).toEqual(both);
    expect(ids(UNORDERED)).toEqual(both);
    expect(ids({ depends: NO_DEPENDENCIES, priority: {} })).toEqual(both);
  });

  /** Settled is *succeeded or dropped*, so every other state the story machine has is a
   *  state that holds the queue — `failed`-like states included. Spelled as the whole list
   *  rather than one example, so a state added to the machine and quietly treated as
   *  finished would have to be added here too. */
  it("keeps waiting through every story state that is not settled", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");
    const queue = needs(checkout.story, cart.story);

    for (const state of ["planned", "in_progress", "on_hold"]) {
      setState(cart.story, state);
      expect(ids(queue), state).toEqual([cart.task]);
    }
  });

  /** An edge to a story that is not there cannot ever be discharged, and "no such story"
   *  reads exactly like "has not finished yet". Waiting is the answer that does not start
   *  work on the strength of a row nobody can find. */
  it("waits on a prerequisite no row answers for", () => {
    const checkout = storyWithTask("checkout", "src/checkout/**");

    expect(ids(needs(checkout.story, 9999))).toEqual([]);
  });

  /** Direct prerequisites only. If checkout needs cart and cart needs payments, checkout is
   *  held up by cart alone: cart cannot settle before payments does, so payments is already
   *  accounted for. Delivering cart therefore frees checkout even with payments still open —
   *  which is the rule `depends.ts` chose, proved rather than assumed. */
  it("waits on its direct prerequisite only, not the chain behind it", () => {
    const payments = storyWithTask("payments", "src/payments/**");
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");
    const queue: StoryQueue = {
      depends: dependsOn(dependsOn(NO_DEPENDENCIES, checkout.story, cart.story), cart.story, payments.story),
      priority: {},
    };

    expect(ids(queue)).toEqual([payments.task]);
    setState(cart.story, "delivered");
    expect(ids(queue)).toEqual([payments.task, checkout.task]);
  });
});

describe("settling the prerequisite releases it", () => {
  it("offers the task the moment the prerequisite is delivered", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");
    const queue = needs(checkout.story, cart.story);
    expect(ids(queue)).not.toContain(checkout.task);

    setState(cart.story, "delivered");

    expect(ids(queue)).toEqual([cart.task, checkout.task]);
  });

  /** A dropped story is never going to be delivered. If the queue waited for it anyway,
   *  everything behind it would be held for ever — so `dropped` settles, and that is why the
   *  rule is spelled *settled* and not *delivered*. */
  it("offers it on a dropped prerequisite too, so a dropped story cannot deadlock the queue", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");
    const queue = needs(checkout.story, cart.story);

    setState(cart.story, "dropped");

    expect(ids(queue)).toContain(checkout.task);
  });

  /** The state is read every time, not remembered. A prerequisite reopened is a prerequisite
   *  unsettled again, and the task it holds goes back to waiting. */
  it("holds it again once the prerequisite reopens", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");
    const queue = needs(checkout.story, cart.story);

    setState(cart.story, "delivered");
    expect(ids(queue)).toContain(checkout.task);

    setState(cart.story, "in_progress");
    expect(ids(queue)).not.toContain(checkout.task);
  });

  /** The dependency is the story's, so it holds every task under it and releases every task
   *  under it — not merely the one that happens to be first. */
  it("holds and then releases every task under the waiting story", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");
    const second = readyTaskUnder(checkout.story, "checkout totals", "src/totals/**");
    const queue = needs(checkout.story, cart.story);

    expect(ids(queue)).toEqual([cart.task]);

    setState(cart.story, "delivered");

    expect(ids(queue)).toEqual([cart.task, checkout.task, second].sort((a, b) => a - b));
  });
});

describe("priority orders the rest", () => {
  /** Lower first, as migration 017 spells the column. The ids here run the other way, so an
   *  implementation that ignored priority would come back in exactly the reverse order. */
  it("puts the lower priority first, against id order", () => {
    const first = storyWithTask("cart", "src/cart/**");
    const second = storyWithTask("checkout", "src/checkout/**");
    const third = storyWithTask("payments", "src/payments/**");

    const queue = ranked({ [first.story]: 3, [second.story]: 2, [third.story]: 1 });

    expect(ids(queue)).toEqual([third.task, second.task, first.task]);
  });

  it("falls back to id within one priority, so two candidates never tie", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");

    const queue = ranked({ [cart.story]: 7, [checkout.story]: 7 });

    expect(ids(queue)).toEqual([cart.task, checkout.task].sort((a, b) => a - b));
  });

  /** 0 is "nobody has ranked this", and it sorts in among the others rather than at one end —
   *  the reason the column is `DEFAULT 0 NOT NULL` and not nullable. */
  it("ranks a story nobody ranked at 0, between a negative and a positive", () => {
    const urgent = storyWithTask("cart", "src/cart/**");
    const unranked = storyWithTask("checkout", "src/checkout/**");
    const later = storyWithTask("payments", "src/payments/**");

    const queue = ranked({ [urgent.story]: -1, [later.story]: 1 });

    expect(ids(queue)).toEqual([urgent.task, unranked.task, later.task]);
  });

  it("orders by priority first and id second, together", () => {
    const a = storyWithTask("cart", "src/cart/**");
    const b = storyWithTask("checkout", "src/checkout/**");
    const c = storyWithTask("payments", "src/payments/**");
    const d = storyWithTask("shipping", "src/shipping/**");

    // two at 1 and two at 2; within each pair the ids decide
    const queue = ranked({ [a.story]: 2, [b.story]: 1, [c.story]: 2, [d.story]: 1 });

    expect(ids(queue)).toEqual([b.task, d.task, a.task, c.task]);
  });

  /** Priority is a story's, so two tasks under one story carry the same one and the id
   *  decides between them. */
  it("gives two tasks under one story that story's priority, id deciding between them", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const sibling = readyTaskUnder(cart.story, "cart totals", "src/totals/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");

    // the sibling's id falls between the two stories' tasks, so ranking cart last moves both
    // of its tasks past checkout's rather than only the one the ids would have put there
    const queue = ranked({ [cart.story]: 5, [checkout.story]: 1 });

    expect(ids(queue)).toEqual([checkout.task, cart.task, sibling]);
  });

  /** Dropping happens before ordering: a waiting task is not merely sorted last, it is not a
   *  candidate, however urgent somebody said it was. */
  it("drops a waiting task however high its priority", () => {
    const cart = storyWithTask("cart", "src/cart/**");
    const checkout = storyWithTask("checkout", "src/checkout/**");

    const queue: StoryQueue = {
      depends: dependsOn(NO_DEPENDENCIES, checkout.story, cart.story),
      priority: { [checkout.story]: -100, [cart.story]: 100 },
    };

    expect(ids(queue)).toEqual([cart.task]);
    setState(cart.story, "delivered");
    // released, and now its priority does apply
    expect(ids(queue)).toEqual([checkout.task, cart.task]);
  });
});
