import type { DatabaseSync } from "node:sqlite";
// The dialect is not on core's public surface — `index.ts` re-exports no `db.js` — so it is
// reached by the path the built package already publishes, which is the route `plan.ts`
// takes to the same module.
import { excluded, queries, table, type Dialect } from "@wecode/core/dist/db.js";

/** What a plan file says about the order its stories are worked in — migration 017.
 *
 *  Containment is the only edge the record had: an epic holds stories, and two stories under
 *  one epic are drawn side by side whatever the operator knows about them. `depends` is the
 *  fact that one of them cannot start until another has finished; `priority` is the
 *  preference about which of the ones that *can* start goes first. They are separate keys
 *  for the reason they are separate columns — a preference must not be able to claim a story
 *  is blocked.
 *
 *  Both live on a story and only on a story: `priority` is a column on `story`, and an edge
 *  joins `story(id)` to `story(id)` at both ends, so an epic carrying either would be an
 *  order nothing can read.
 *
 *  `plan.ts` reaches this module through one import and two calls, each next to a call of
 *  the same shape it already makes:
 *
 *    import { keysFor, ordering, record, type Order } from "./plan/depends.js";
 *
 *    // beside `duplicated(db, …)` and `joined(db, …)`, while nothing has been created yet
 *    const waits = ordering(db, doc, said);
 *
 *    // inside the transaction, after `create` has given every story an id
 *    record(db, waits, rows);
 *
 *  and the allowlists that would otherwise call these keys typos gain `...keysFor(root)` and
 *  `...keysFor(kind)`. Everything that reads the keys, refuses them and writes the rows is
 *  here, so the command file grows by a line rather than by a block.
 *
 *  The split is where it is because of when the answers exist. Everything a person can get
 *  wrong is refused by `ordering`, before a row is written and while `--dry-run` can still
 *  report it; `record` writes what `ordering` already settled and judges nothing. */

interface StoryRow {
  readonly id: number;
  readonly title: string;
  readonly priority: number;
}
const stories = table<StoryRow>("story", ["id", "title", "priority"]);

/** The edge, which is a pair of ids and nothing else: no id of its own, no state, no
 *  timestamps. 017 says why — a dependency is not worked on and is not reported about. */
interface EdgeRow {
  readonly story_id: number;
  readonly depends_on_id: number;
}
const edges = table<EdgeRow>("story_depends_on", ["story_id", "depends_on_id"]);

/** The keys a rung of this kind may carry, for `plan.ts`'s unknown-key refusal and for its
 *  `--help`. Asked by kind rather than exported as a flat list so that the one place that
 *  knows these belong to a story is this module. */
export const keysFor = (kind: string): readonly string[] => (kind === "story" ? KEYS : []);

const KEYS: readonly string[] = ["depends", "priority"];

/** One story this file is waiting on. Either a story already in the record, named by id, or
 *  one this same file is making, named by where it sits in the file — that one has no id
 *  until `create` has run, and this is how the two are carried side by side until it has. */
export interface Waited {
  readonly id: number | null;
  readonly at: number | null;
}

/** What one story in the file asked for, ready to write. `where` is how a refusal about it
 *  points at it, in the wording `plan.ts` prints the rest of a plan's faults in. */
export interface Order {
  readonly where: string;
  readonly depends: readonly Waited[];
  /** Absent in the file, and nothing is written: the column's own default already says
   *  "nobody has ranked this", and writing 0 over it would be this module claiming somebody
   *  had. */
  readonly priority: number | null;
}

/** Every story the file describes, in the order it describes them.
 *
 *  Found by descending the document rather than by walking the ladder: a story in a plan
 *  file is a mapping carrying a `story` key, whether it is the root, one of an epic's, or
 *  one of an epic's under a release — and a second copy of which key holds whose children
 *  is a copy that can drift from the one `plan.ts` keeps. Pre-order, because that is the
 *  order `create` walks, which is what lets the ids line up with these by position. */
export function storiesIn(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) {
    for (const e of v) storiesIn(e, out);
    return out;
  }
  if (v === null || typeof v !== "object") return out;
  const m = v as Record<string, unknown>;
  if ("story" in m) out.push(m);
  for (const value of Object.values(m)) storiesIn(value, out);
  return out;
}

/** One rung of what `create` made: its kind, the id it now has, and the rungs under it.
 *  Structural, the way `plan/refusals.ts` takes a task, so `plan.ts` keeps its own shapes
 *  and this module need not be opened when a field it does not read is added to them. */
export interface Rung {
  readonly kind: string;
  readonly id: number;
  readonly children: readonly Rung[];
}

/** The stories among them, pre-order — the same order `storiesIn` reads the file in. */
export function storyRungs(l: Rung, out: Rung[] = []): Rung[] {
  if (l.kind === "story") out.push(l);
  for (const c of l.children) storyRungs(c, out);
  return out;
}

/** A root given as a number joins that existing row, and a quoted number is still a number:
 *  read the way `plan.ts` reads the same scalar, so `story: 407` and `story: "407"` are one
 *  story here and there. */
function asId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** A whole number, however the file quoted it — `priority: 3` and `priority: "3"` are one
 *  rank, the way `story: 407` and `story: "407"` are one story, and a module that read the
 *  same scalar two ways would be a module a person has to remember the rule of. Negative is
 *  a rank: 017 leaves the scale unbounded in both directions on purpose, so that a story can
 *  always be squeezed above another without renumbering the ones below it. */
function asWhole(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** A value as a refusal should print it: a string in quotes, so an empty one and a missing
 *  one do not read the same. */
const shown = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : String(v));

/** The sentence a story was given, when the file is making it rather than joining one. */
const sentence = (m: Record<string, unknown>): string | null => {
  const named = m["story"];
  return asId(named) === null && typeof named === "string" && named.trim() !== "" ? named.trim() : null;
};

/** What a refusal calls this story: the sentence it was given, the id it joined, or failing
 *  both its position, so that a story whose own `story` key is the thing that is wrong still
 *  has something to be named by. */
const nameOf = (m: Record<string, unknown>, i: number): string => {
  const joined = asId(m["story"]);
  if (joined !== null) return `story #${String(joined)}`;
  const said = sentence(m);
  return said === null ? `story ${String(i + 1)}` : `story "${said}"`;
};

/** Read `depends` and `priority` off every story in the file, resolve what they name, and
 *  refuse whatever cannot become an edge — all of it, into `say`, the way every other rule
 *  `plan.ts` runs before creating anything reports: a plan read one fault at a time is the
 *  eighteen commands again.
 *
 *  What is refused, and why here rather than anywhere else. A key of the wrong shape, or an
 *  entry that is neither a sentence nor an id, because a `depends` nobody can read plans no
 *  edges and would otherwise pass in silence. A sentence naming no story in this file, and
 *  one naming two, because an edge has exactly one far end and this module may not pick it.
 *  An id naming no story in the record, because the foreign key would raise that as a
 *  rollback in the middle of the one transaction that creates and starts the whole tree,
 *  rather than as a sentence. And a story waiting on itself, which is the one-step cycle
 *  017's CHECK refuses — refused by name here, where the typo that made it costs a keystroke
 *  to fix. Longer cycles are past what this can see without walking the whole record's
 *  graph, and 017 leaves them to the doctor. */
export function ordering(db: DatabaseSync, doc: unknown, say: string[]): readonly Order[] {
  const found = storiesIn(doc);
  const titles = found.map(sentence);
  const q = queries(db);
  return found.map((m, i) => {
    const where = nameOf(m, i);
    return { where, depends: waited(m, i, titles, where, q, say), priority: ranked(m, where, say) };
  });
}

function waited(
  m: Record<string, unknown>,
  self: number,
  titles: readonly (string | null)[],
  where: string,
  q: Dialect,
  say: string[],
): readonly Waited[] {
  const raw = m["depends"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    say.push(`${where}: depends: expected a list of stories, not ${shown(raw)}`);
    return [];
  }
  const out: Waited[] = [];
  const mine = { at: self, id: asId(m["story"]) };
  for (const entry of raw) {
    const one = entryOf(entry, mine, titles, where, q, say);
    if (one !== null) out.push(one);
  }
  return out;
}

/** One entry of a `depends` list. An id if it reads as one, and a sentence otherwise: the
 *  same order `plan.ts` reads a root in, so the two never disagree about what `407` is. */
function entryOf(
  entry: unknown,
  mine: Waited,
  titles: readonly (string | null)[],
  where: string,
  q: Dialect,
  say: string[],
): Waited | null {
  const id = asId(entry);
  if (id !== null) {
    if (id === mine.id) {
      say.push(`${where}: depends: a story cannot wait on itself`);
      return null;
    }
    if (q.selectFrom(stories).select(["id"]).where("id", "=", id).get() === null) {
      say.push(`${where}: depends: no story #${String(id)} in the record`);
      return null;
    }
    return { id, at: null };
  }
  if (typeof entry !== "string" || entry.trim() === "") {
    say.push(`${where}: depends: expected a story's sentence or its id, not ${shown(entry)}`);
    return null;
  }
  const wanted = entry.trim();
  const at = titles.flatMap((t, i) => (t === wanted ? [i] : []));
  if (at.length === 0) {
    say.push(`${where}: depends: no story in this file is called ${JSON.stringify(wanted)}`);
    return null;
  }
  if (at.length > 1) {
    say.push(`${where}: depends: ${String(at.length)} stories in this file are called ${JSON.stringify(wanted)}`);
    return null;
  }
  if (at[0] === mine.at) {
    say.push(`${where}: depends: a story cannot wait on itself`);
    return null;
  }
  return { id: null, at: at[0] as number };
}

function ranked(m: Record<string, unknown>, where: string, say: string[]): number | null {
  const v = m["priority"];
  if (v === undefined) return null;
  const rank = asWhole(v);
  if (rank === null) say.push(`${where}: priority: expected a whole number, lower first, not ${shown(v)}`);
  return rank;
}

/** Write what `ordering` settled: the edges, then the ranks. Judges nothing — every fault a
 *  person could have made was a sentence before this was called — so it is safe to run
 *  inside the transaction `create` and `begin` already share, where a throw leaves nothing.
 *
 *  An edge stated twice is one edge, and 017 made the pair a primary key so that the record
 *  is what says so. Every insert names the conflict rather than being guarded by a count
 *  kept here: the second statement may be the file repeating itself, or it may be a story
 *  the file joined by id already waiting on the story it names — the file agreeing with the
 *  record — and neither is a fault, so both write the pair they already found there. */
export function record(db: DatabaseSync, orders: readonly Order[], made: Rung): void {
  const rungs = storyRungs(made);
  if (rungs.length !== orders.length) {
    throw new Error(
      `the file describes ${String(orders.length)} stories and ${String(rungs.length)} were created`,
    );
  }
  const q = queries(db);
  for (const [i, order] of orders.entries()) {
    const story = (rungs[i] as Rung).id;
    for (const w of order.depends) {
      const on = w.id ?? (rungs[w.at as number] as Rung).id;
      q.insertInto(edges, { story_id: story, depends_on_id: on })
        .onConflict(["story_id", "depends_on_id"], { depends_on_id: excluded<EdgeRow>("depends_on_id") })
        .run();
    }
    if (order.priority !== null) q.update(stories).set({ priority: order.priority }).where("id", "=", story).run();
  }
}
