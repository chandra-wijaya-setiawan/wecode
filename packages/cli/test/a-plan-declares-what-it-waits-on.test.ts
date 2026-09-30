import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Maker } from "@wecode/core";
import { keysFor, ordering, record, storiesIn, storyRungs, type Rung } from "../src/plan/depends.js";
import { freshDb, seed } from "../../core/test/helpers.js";

/** A plan file says what its stories are waiting on, and which of the ones that are not
 *  waiting to do first — migration 017's two halves, read off the file that declares them.
 *
 *  Until now every edge in a plan file was containment: the ladder it draws is the shape of
 *  the work, and two stories under one epic are drawn side by side whatever the operator
 *  knows about their order. `depends` is the fact that one cannot start until another has
 *  finished. `priority` is the preference about which of the startable ones goes first.
 *
 *  Proved against the file's own text rather than against a hand-built object, through the
 *  same `yaml` parser `plan.ts` hands the document to: `priority: 2` arriving as a number
 *  and `depends:` arriving as a list are facts about the grammar a person writes, and a
 *  fixture that skipped the parse would not be checking them.
 *
 *  What is not here: the two lines in `plan.ts` that call this. That file is outside this
 *  task's scope — and so is the plan.ts row of `packages/core/config/project.yaml`, which is
 *  a ratchet sitting exactly at its current length — so the wiring is stated in the module's
 *  header for the hand that has them, and nothing below pretends it is done. */

const SOURCE = readFileSync(fileURLToPath(new URL("../src/plan/depends.ts", import.meta.url)), "utf8");

let db: DatabaseSync;
let epic: number;
/** A story that was in the record before the file was written, for the `depends: <id>` case. */
let already: number;

beforeEach(() => {
  db = freshDb();
  const rows = seed(db);
  epic = rows.epic;
  already = rows.story;
});

/** A story row, as if an earlier plan had made it. */
const existing = (title: string): number => new Maker(db).story(epic, title);

/** What `create` hands back for a file whose root is an epic: the epic, and its stories in
 *  the order the file listed them. Built by hand here because `create` is `plan.ts`'s. */
const underEpic = (...ids: readonly number[]): Rung => ({
  kind: "epic",
  id: epic,
  children: ids.map((id) => ({ kind: "story", id, children: [] })),
});

const edges = (): readonly { story_id: number; depends_on_id: number }[] =>
  db.prepare("SELECT story_id, depends_on_id FROM story_depends_on ORDER BY story_id, depends_on_id").all() as {
    story_id: number;
    depends_on_id: number;
  }[];

const priorityOf = (id: number): number =>
  (db.prepare("SELECT priority FROM story WHERE id = ?").get(id) as { priority: number }).priority;

/** The fixture the happy path uses, shaped the way a real plan file is shaped — requirements,
 *  criteria and tasks and all — so that finding the stories in it is a claim about a document
 *  somebody would actually write and not about a two-key stub. */
const SHOP = `
epic: the shop
stories:
  - story: the cart holds items
    priority: 1
    requirements:
      - requirement: a cart keeps one line per item
        criteria:
          - statement: two of the same item is one line
            test: vitest run packages/web/test/cart.test.ts
            tasks:
              - title: add the cart
                scope: [packages/web/src/cart.ts]
  - story: checkout takes payment
    priority: 2
    depends:
      - the cart holds items
    requirements:
      - requirement: a card is charged once
        criteria: [{ statement: a retry charges nothing twice }]
`;

describe("the stories a file describes, and the keys they may carry", () => {
  /** `priority` is a column on `story` and an edge joins `story(id)` to `story(id)` at both
   *  ends. An epic carrying either would be an order nothing in the record can read, so the
   *  allowlist `plan.ts` refuses typos with must not offer them there. */
  it("offers the two keys to a story, and to no other rung", () => {
    expect(keysFor("story")).toEqual(["depends", "priority"]);
    expect(keysFor("epic")).toEqual([]);
    expect(keysFor("release")).toEqual([]);
  });

  it("reads them in the order the file lists them, whatever is nested under them", () => {
    expect(storiesIn(parse(SHOP)).map((m) => m["story"])).toEqual(["the cart holds items", "checkout takes payment"]);
  });

  /** A story is a mapping carrying a `story` key wherever it sits — the root, one of an
   *  epic's, or one of an epic's under a release. Descending for that key rather than
   *  walking the ladder is what keeps a second copy of which key holds whose children out
   *  of this module. */
  it("finds one that is the root, and ones two rungs down", () => {
    expect(storiesIn(parse(`story: the only one\nepic: 12\nrequirements: []\n`)).map((m) => m["story"])).toEqual(["the only one"]);
    const release = `
release: 2.0
epics:
  - epic: the shop
    stories:
      - story: the cart
        requirements: []
      - story: checkout
        requirements: []
  - epic: the warehouse
    stories:
      - story: stock counts
        requirements: []
`;
    expect(storiesIn(parse(release)).map((m) => m["story"])).toEqual(["the cart", "checkout", "stock counts"]);
  });

  /** The ids line up with the stories by position, so the two orders have to be the same
   *  order. `create` walks a rung and then its children; this walks the document the same
   *  way, and this is the claim that says so. */
  it("walks in the same order the created rungs come back in", () => {
    const of = (kind: string, id: number, ...children: readonly Rung[]): Rung => ({ kind, id, children });
    const made = of("release", 9, of("epic", 10, of("story", 11), of("story", 12)), of("epic", 13, of("story", 14)));
    expect(storyRungs(made).map((r) => r.id)).toEqual([11, 12, 14]);
    expect(storyRungs(of("story", 7)).map((r) => r.id)).toEqual([7]);
  });
});

/** The shop, read and then written onto the two rows its stories became — the whole path a
 *  `wecode plan` run takes through this module, refusing nothing on the way. */
const shop = (): { readonly cart: number; readonly checkout: number } => {
  const said: string[] = [];
  const orders = ordering(db, parse(SHOP), said);
  expect(said).toEqual([]);
  const cart = existing("the cart holds items");
  const checkout = existing("checkout takes payment");
  record(db, orders, underEpic(cart, checkout));
  return { cart, checkout };
};

describe("a story waiting on one this same file is making", () => {
  it("becomes an edge to the row that story got, in the direction the names fix", () => {
    const { cart, checkout } = shop();
    // `story_id` is the one that is waiting; `depends_on_id` is the one that has to finish.
    expect(edges()).toEqual([{ story_id: checkout, depends_on_id: cart }]);
  });

  /** The other direction of the same pair, stated separately. An edge table whose two ends
   *  were swapped would satisfy "there is one row" and would have the allocator start
   *  checkout first, so each end is claimed by name. */
  it("leaves the story it waits on waiting on nothing", () => {
    const { cart, checkout } = shop();
    expect(edges().filter((e) => e.story_id === cart)).toEqual([]);
    expect(edges().filter((e) => e.depends_on_id === checkout)).toEqual([]);
  });

  it("carries the rank each story was given, lower first", () => {
    const { cart, checkout } = shop();
    expect(priorityOf(cart)).toBe(1);
    expect(priorityOf(checkout)).toBe(2);
  });
});

describe("a story waiting on one already in the record", () => {
  const file = (waits: string): string =>
    `epic: 1\nstories:\n  - story: the new one\n    depends: [${waits}]\n    requirements: []\n`;

  /** A quoted number is still a number, the way it is for the root `plan.ts` reads: the two
   *  must not disagree about what `407` is. */
  it("names it by id, however the file quoted it", () => {
    const said: string[] = [];
    for (const waits of [String(already), `"${String(already)}"`]) {
      expect(ordering(db, parse(file(waits)), said)[0]?.depends, waits).toEqual([{ id: already, at: null }]);
    }
    expect(said).toEqual([]);

    const mine = existing("the new one");
    record(db, ordering(db, parse(file(String(already))), said), underEpic(mine));
    expect(edges()).toEqual([{ story_id: mine, depends_on_id: already }]);
  });

  /** An edge stated twice is one edge — that is what 017 makes the pair a primary key for,
   *  and the record is what says so. A file repeating itself is not a failed statement. */
  it("writes one row however many times the file says it", () => {
    const said: string[] = [];
    const twice = file(`${String(already)}, "${String(already)}"`);
    const orders = ordering(db, parse(twice), said);
    expect(said).toEqual([]);
    const mine = existing("the new one");
    record(db, orders, underEpic(mine));
    expect(edges()).toEqual([{ story_id: mine, depends_on_id: already }]);
  });

  /** A story the file joined by id may already be waiting on the one it names. That is the
   *  file agreeing with the record, not a fault in it, and it must not be a second row. */
  it("writes no second row over an edge the record already holds", () => {
    const mine = existing("the new one");
    db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)").run(mine, already);
    const said: string[] = [];
    const orders = ordering(db, parse(file(String(already))), said);
    record(db, orders, underEpic(mine));
    expect(edges()).toEqual([{ story_id: mine, depends_on_id: already }]);
  });
});

describe("a story that says nothing about its order", () => {
  const SILENT = `epic: 1\nstories:\n  - story: the quiet one\n    requirements: []\n`;

  it("gets no edge at all", () => {
    const said: string[] = [];
    const orders = ordering(db, parse(SILENT), said);
    expect(said).toEqual([]);
    expect(orders).toEqual([{ where: 'story "the quiet one"', depends: [], priority: null }]);

    const mine = existing("the quiet one");
    record(db, orders, underEpic(mine));
    expect(edges()).toEqual([]);
  });

  /** A rank the file does not mention is not a rank of 0. `story.priority` defaults to 0
   *  because 0 says "nobody has ranked this", so writing 0 back over a story somebody had
   *  ranked would be this module claiming they had not — and a file may join a story by id
   *  to hang a new requirement off it without having any opinion about its order. */
  it("leaves a rank somebody had already set exactly where it was", () => {
    const mine = existing("the quiet one");
    db.prepare("UPDATE story SET priority = ? WHERE id = ?").run(7, mine);

    const said: string[] = [];
    record(db, ordering(db, parse(SILENT), said), underEpic(mine));

    expect(said).toEqual([]);
    expect(priorityOf(mine)).toBe(7);
  });

  it("starts unranked when nobody has said, which is what 0 means", () => {
    expect(priorityOf(existing("nobody has said"))).toBe(0);
  });

  /** A rank below the unranked ones. 017 leaves the scale unbounded in both directions, so
   *  that a story can be squeezed above another without renumbering the ones below it — and
   *  a quoted number is the same rank, the way it is the same story for `depends`. */
  it("takes a rank either side of 0, however the file quoted it", () => {
    for (const [rank, expected] of [["-1", -1], ['"2"', 2]] as const) {
      const said: string[] = [];
      const mine = existing(`ranked ${rank}`);
      record(db, ordering(db, parse(`epic: 1\nstories:\n  - story: x\n    priority: ${rank}\n`), said), underEpic(mine));
      expect(said, rank).toEqual([]);
      expect(priorityOf(mine), rank).toBe(expected);
    }
  });
});

/** Everything a person can get wrong, refused before a row exists — which is why `ordering`
 *  takes the same `say` every other rule `plan.ts` runs before creating anything writes
 *  into. Each case names the sentence it is refused with: a refusal nobody can act on is
 *  the same as no refusal. */
describe("what is refused, and in the file's own words", () => {
  const refusals = (text: string): readonly string[] => {
    const said: string[] = [];
    ordering(db, parse(text), said);
    return said;
  };

  const withStory = (body: string): string => `epic: 1\nstories:\n  - story: the new one\n${body}    requirements: []\n`;

  it("refuses a depends that is not a list, which would otherwise plan no edges at all", () => {
    expect(refusals(withStory(`    depends: the cart\n`))).toEqual([
      'story "the new one": depends: expected a list of stories, not "the cart"',
    ]);
  });

  it("refuses an entry that is neither a sentence nor an id", () => {
    expect(refusals(withStory(`    depends: [true, ""]\n`))).toEqual([
      'story "the new one": depends: expected a story\'s sentence or its id, not true',
      'story "the new one": depends: expected a story\'s sentence or its id, not ""',
    ]);
  });

  /** An edge has exactly one far end. A sentence matching nothing in the file is the typo
   *  that would otherwise plan an epic with no order in it at all, and one matching two is a
   *  question this module cannot answer for the operator. */
  it("refuses a sentence no story in the file is called, and one two stories are", () => {
    expect(refusals(withStory(`    depends: [the cart]\n`))).toEqual([
      'story "the new one": depends: no story in this file is called "the cart"',
    ]);
    const twins = `
epic: 1
stories:
  - story: the cart
    requirements: []
  - story: the cart
    requirements: []
  - story: checkout
    depends: [the cart]
    requirements: []
`;
    expect(refusals(twins)).toEqual(['story "checkout": depends: 2 stories in this file are called "the cart"']);
  });

  /** The foreign key would refuse this too, but as a rollback in the middle of the one
   *  transaction that creates and starts the whole tree. A sentence costs a keystroke. */
  it("refuses an id no story in the record has", () => {
    expect(refusals(withStory(`    depends: [9999]\n`))).toEqual([
      'story "the new one": depends: no story #9999 in the record',
    ]);
  });

  /** 017's CHECK refuses this, because a story waiting on itself is a row that can never be
   *  discharged. Refused by name here, whichever way the file spelled it. */
  it("refuses a story waiting on itself, by sentence and by id", () => {
    expect(refusals(withStory(`    depends: [the new one]\n`))).toEqual([
      'story "the new one": depends: a story cannot wait on itself',
    ]);
    expect(refusals(`story: ${String(already)}\ndepends: [${String(already)}]\nrequirements: []\n`)).toEqual([
      `story #${String(already)}: depends: a story cannot wait on itself`,
    ]);
  });

  it("refuses a priority that is not a whole number", () => {
    expect(refusals(withStory(`    priority: soon\n`))).toEqual([
      'story "the new one": priority: expected a whole number, lower first, not "soon"',
    ]);
    expect(refusals(withStory(`    priority: 1.5\n`))).toEqual([
      'story "the new one": priority: expected a whole number, lower first, not 1.5',
    ]);
  });

  /** Everything at once. A plan read one fault at a time is the eighteen commands again, so
   *  every story's faults and both keys' faults come back from the single call. */
  it("says all of it in one pass", () => {
    const wrong = `
epic: 1
stories:
  - story: the cart
    priority: later
    requirements: []
  - story: checkout
    priority: 1.5
    depends: [the trolley, 9999]
    requirements: []
`;
    expect(refusals(wrong)).toEqual([
      'story "the cart": priority: expected a whole number, lower first, not "later"',
      'story "checkout": depends: no story in this file is called "the trolley"',
      'story "checkout": depends: no story #9999 in the record',
      'story "checkout": priority: expected a whole number, lower first, not 1.5',
    ]);
  });

  it("writes nothing for a story whose order it refused", () => {
    const said: string[] = [];
    const orders = ordering(db, parse(withStory(`    depends: [9999]\n    priority: soon\n`)), said);
    expect(said).toHaveLength(2);
    const mine = existing("the new one");
    record(db, orders, underEpic(mine));
    expect(edges()).toEqual([]);
    expect(priorityOf(mine)).toBe(0);
  });
});

describe("writing what was read", () => {
  /** `record` runs inside the transaction that creates and starts the tree, after `ordering`
   *  has already had its say, so it judges nothing. The one thing it cannot be asked to
   *  guess at is which story an order belongs to: if the file and the rungs disagree about
   *  how many stories there are, the ids no longer line up by position and every edge would
   *  land on the wrong row. It throws, and the transaction takes the rows back with it. */
  it("refuses to guess when the file and the created rungs disagree on the count", () => {
    const said: string[] = [];
    const orders = ordering(db, parse(SHOP), said);
    const cart = existing("the cart holds items");
    expect(() => {
      record(db, orders, underEpic(cart));
    }).toThrow("the file describes 2 stories and 1 were created");
    expect(edges()).toEqual([]);
  });

  /** Two copies of a schema with no check between them is the defect. `plan.ts`'s own table
   *  declarations are held against `PRAGMA table_info` by `typed-plan`, which reads that
   *  file and only that file — so the declarations in this one are held here. */
  it("asks only for tables and columns the migrations actually built", () => {
    const declared = [...SOURCE.matchAll(/table<\w+>\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map((m) => ({
      table: m[1] as string,
      columns: [...(m[2] as string).matchAll(/"(\w+)"/g)].map((c) => c[1] as string),
    }));
    expect(declared.map((d) => d.table)).toEqual(["story", "story_depends_on"]);
    for (const d of declared) {
      const actual = (db.prepare("SELECT name FROM pragma_table_info(?)").all(d.table) as { name: string }[]);
      expect(d.columns.length).toBeGreaterThan(0);
      expect(actual.map((r) => r.name), d.table).toEqual(expect.arrayContaining(d.columns));
    }
  });
});
