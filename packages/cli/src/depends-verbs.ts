/** What a story waits on, from the command line: the two verbs that declare it — `depends`
 *  and `priority` — and the two lines `wecode show story` adds.
 *
 *  Its own file rather than more of run.ts. run.ts is a dispatch and is already at its
 *  row of 515; it and plan.ts are two of the three files that hold a third of this
 *  package's source between them, so the bodies go here and run.ts reaches them through
 *  one import, exactly the way it reaches `verbs/entity.ts` and the rest.
 *
 *  Nothing here opens the workspace or reads argv it was not handed: the database, how a
 *  refusal is said and who is asking arrive as `At`, the same context `verbs/entity.ts`
 *  takes. `show` is lent only the dialect, because the two lines it adds are a read.
 *
 *  ── the record these verbs write ──
 *
 *  A dependency is an edge between two story ids, one row per prerequisite, both columns
 *  NOT NULL: there is no such thing as a null prerequisite, and a story that waits on
 *  nothing says so by holding no row. A priority is a column on `story`, defaulting to 0,
 *  so every story has one and the queue never has to break a tie by which row was written
 *  first.
 *
 *  Both belong to the migration that owns them — `017-story-depends-on.sql`, which is
 *  another task's file and is not in the tree yet. The tables are declared here the way
 *  `verbs/entity.ts` declares every other one: a second copy of the schema, which the
 *  migration is the first copy of. Until it lands these verbs answer "no such table", and
 *  `a-story-says-what-it-waits-on.test.ts` stands the two shapes up itself so the verbs
 *  can be proved against the record they are written for. If the migration spells either
 *  shape differently, that test fails loudly rather than these verbs failing quietly. */
import { parseArgs } from "node:util";
import { queries, table, type Dialect } from "@wecode/core/dist/db.js";
import { instead, elsewhere, story, type At } from "./verbs/entity.js";

/** One prerequisite of one story: `story_id` waits on `prerequisite_id`. */
export type DependsRow = { story_id: number; prerequisite_id: number };

export const storyDependsOn = table<DependsRow>("story_depends_on", [
  "story_id", "prerequisite_id",
]);

/** `story` again, narrowed to the one column this file writes. Narrow rather than the
 *  whole row from `verbs/entity.ts`, because that list is held against `PRAGMA table_info`
 *  by `typed-run.test.ts` and is the migration's to grow, not this file's. */
type PriorityRow = { id: number; priority: number };
const priorities = table<PriorityRow>("story", ["id", "priority"]);

/** A title, cut to the width the rest of the cli cuts one to. */
const label = (title: string): string => (title.length > 44 ? `${title.slice(0, 43)}…` : title);

const titleOf = (q: Dialect, id: number): string | null => {
  const row = q.selectFrom(story).select(["title"]).where("id", "=", id).get();
  return row === null ? null : row.title;
};

/** The stories this one waits on. */
const waitsOn = (q: Dialect, id: number): number[] =>
  q
    .selectFrom(storyDependsOn)
    .select(["prerequisite_id"])
    .where("story_id", "=", id)
    .all()
    .map((r) => r.prerequisite_id);

/** The stories waiting on this one. */
const waitedOnBy = (q: Dialect, id: number): number[] =>
  q
    .selectFrom(storyDependsOn)
    .select(["story_id"])
    .where("prerequisite_id", "=", id)
    .all()
    .map((r) => r.story_id);

/** The shortest chain of prerequisites from `from` to `target`, or null when there is
 *  none. Breadth first, so the path a refusal names is the shortest one there is rather
 *  than whichever the walk stumbled down — a person reading "#3 → #2 → #1" can check it.
 *  `seen` is what stops bad data already holding a ring from spinning here forever. */
function chain(q: Dialect, from: number, target: number): number[] | null {
  const seen = new Set<number>([from]);
  const queue: number[][] = [[from]];
  while (queue.length > 0) {
    const path = queue.shift() as number[];
    for (const next of waitsOn(q, path[path.length - 1] as number)) {
      if (next === target) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

const ring = (path: readonly number[]): string => path.map((n) => `#${n}`).join(" → ");

/** `wecode story depends <id> --on <id>` — this story waits on that one.
 *
 *  Declaring an edge twice is not an error: the operator is stating a fact, and a fact
 *  stated twice is the same fact. What is an error is an edge that closes a cycle, and it
 *  is refused here, where it is declared, naming the path it would close — direct or
 *  through any number of hops. A cycle found later is a queue that will not move and
 *  nothing to say why; a cycle refused now is one sentence a person can act on. */
export function depends(at: At, args: readonly string[]): number {
  const how = "wecode story depends <id> --on <id>";
  let values: { on?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { on: { type: "string" } },
    }));
  } catch {
    // An unknown flag is the usage line, not a crash.
    return at.fail(how);
  }
  const id = Number(positionals[0]);
  const on = Number(values.on);
  if (!Number.isInteger(id) || values.on === undefined || !Number.isInteger(on)) return at.fail(how);

  if (id === on) {
    return at.fail(`story #${id} cannot depend on itself: ${ring([id, id])} is a cycle of one`);
  }

  // Ids are global, and this writes: a story in another project's tree is refused the same
  // way scope, artefact and restate refuse one.
  const wrong = elsewhere(at, "story", id) ?? elsewhere(at, "story", on);
  if (wrong !== null) return at.fail(wrong);

  const q = queries(at.conn());
  if (titleOf(q, id) === null) return at.fail(instead(q, "story", id));
  const prerequisite = titleOf(q, on);
  if (prerequisite === null) return at.fail(instead(q, "story", on));

  const already = chain(q, on, id);
  if (already !== null) {
    return at.fail(
      `story #${id} cannot depend on story #${on}: that closes a cycle, ${ring([id, ...already])}\n` +
        `  #${on} already waits on #${id}, so nothing in the ring could ever start.`,
    );
  }

  const held = q
    .selectFrom(storyDependsOn)
    .select(["story_id"])
    .where("story_id", "=", id)
    .where("prerequisite_id", "=", on)
    .get();
  if (held === null) q.insertInto(storyDependsOn, { story_id: id, prerequisite_id: on }).run();

  process.stdout.write(`story #${id} depends on story #${on}  ${label(prerequisite)}\n`);
  return 0;
}

/** `--to -2` as `--to=-2`, and nothing else touched.
 *
 *  parseArgs reads the token after `--to` as another option as soon as it begins with a
 *  dash, so `--to -2` reaches the verb as an unknown short option and a missing value. A
 *  negative priority is the whole point of an order that runs descending — it is how the
 *  operator says "this can wait" — so the one shape that is unambiguous, a dash and
 *  digits directly after `--to`, is joined up before the parse. A person should not have
 *  to know which of `--to -2` and `--to=-2` the parser this file happens to use prefers. */
function negatives(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const here = args[i] as string;
    const next = args[i + 1];
    if (here === "--to" && next !== undefined && /^-\d+$/.test(next)) {
      out.push(`--to=${next}`);
      i += 1;
    } else out.push(here);
  }
  return out;
}

/** `wecode story priority <id> --to <n>` — which of the stories that are free goes first.
 *
 *  A whole number, and it may be negative: the order is priority descending, so a story
 *  pushed below the default 0 is a story the operator has decided can wait. What it was
 *  is printed beside what it is now, because a priority is a number somebody else may
 *  have set and overwriting one silently is how two people disagree without noticing. */
export function priority(at: At, args: readonly string[]): number {
  const how = "wecode story priority <id> --to <n>";
  let values: { to?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: negatives(args),
      allowPositionals: true,
      options: { to: { type: "string" } },
    }));
  } catch {
    return at.fail(how);
  }
  const id = Number(positionals[0]);
  if (!Number.isInteger(id) || values.to === undefined) return at.fail(how);
  const to = Number(values.to);
  if (values.to.trim() === "" || !Number.isInteger(to)) {
    return at.fail(`a priority is a whole number, and "${values.to}" is not one`);
  }

  const wrong = elsewhere(at, "story", id);
  if (wrong !== null) return at.fail(wrong);

  const q = queries(at.conn());
  const was = q.selectFrom(priorities).select(["priority"]).where("id", "=", id).get();
  if (was === null) return at.fail(instead(q, "story", id));

  q.update(priorities).set({ priority: to }).where("id", "=", id).run();
  process.stdout.write(`story #${id} priority ${to}  was ${was.priority}\n`);
  return 0;
}

/** The two lines `wecode show story <id>` adds: what it waits on, and what waits on it.
 *
 *  Both lines are always there, and an empty one says "nothing" rather than being left
 *  out. A record with no edges and a record whose edges were never asked about look the
 *  same on a page that omits the line, and they are not the same thing — the point of
 *  showing a story is to answer the question without opening the database.
 *
 *  Eighteen columns and a space, which is the width `show` already pads a field name to,
 *  so these two lines sit in the same column as every other.
 *
 *  By id, because the dialect has no ORDER BY and insertion order is not an order anybody
 *  asked for: the same graph reads the same way every time it is shown. */
export function edges(q: Dialect, id: number): string {
  const by = (ids: readonly number[]): string[] => [...ids].sort((a, b) => a - b).map((n) => named(q, n));
  return row("depends on", by(waitsOn(q, id))) + row("depended on by", by(waitedOnBy(q, id)));
}

const row = (field: string, who: readonly string[]): string =>
  `${field.padEnd(18)} ${who.length === 0 ? "nothing" : who.join(", ")}\n`;

const named = (q: Dialect, id: number): string => {
  const title = titleOf(q, id);
  return title === null ? `#${id}` : `#${id} ${label(title)}`;
};
