import type { DatabaseSync } from "node:sqlite";
import { queries, table } from "./db.js";

/** What a story needs before it can start, and the one rule that keeps the answer finite.
 *
 *  docs/design/10 gives the allocator a step it has nothing to run: *drop any whose
 *  prerequisite has not finished*. A prerequisite is an edge between two stories, and this
 *  module is the edge and the rule about it — `dependsOn` declares one, `prerequisitesOf`
 *  and `dependentsOf` read the two directions of it, and an edge that would close a path
 *  back to where it started is refused rather than recorded.
 *
 *  **Why the edges are a value and not a table.** There is no `depends` table and this
 *  change does not add one. That is not a gap being papered over: the rule is the part
 *  worth having exactly once, and it is the same rule whether the edges arrive from a plan
 *  file, from a form, or one day from rows. A caller holds the set it is asking about and
 *  gets a new set back, so nothing here can be half-applied — a refused edge leaves the
 *  caller holding precisely what it had.
 *
 *  **Why the cycle is refused at the edge and not found later.** A cycle is not a state
 *  the record can be in and then be healed out of: while it exists, "what is ready" has no
 *  answer at all, because every story in the loop is waiting for another one in it. The
 *  only moment at which there is one edge to blame is the moment it is declared. A sweep
 *  that found the loop afterwards would have to pick a victim, and any pick is a guess at
 *  which of them the person meant. */

export class DependsError extends Error {}

/** One declaration. `dependent` cannot start until `prerequisite` has finished.
 *
 *  Both ends are story ids. The names are the two roles rather than `from` and `to`,
 *  because which way the arrow points is the one thing a reader of a dependency graph gets
 *  wrong, and `from` does not say. */
const dependsTable = table<{ story_id: number; depends_on_id: number }>("story_depends_on", [
  "story_id", "depends_on_id",
]);
const rankTable = table<{ id: number; priority: number }>("story", ["id", "priority"]);

export interface Dependency {
  readonly dependent: number;
  readonly prerequisite: number;
}

/** Every declaration made so far — a set of edges, in the order they were declared.
 *  Readonly, because `dependsOn` returns a new one rather than growing this. */
export type Dependencies = readonly Dependency[];

/** A story that needs nothing yet. The starting value, named so a caller does not have to
 *  spell an empty array and wonder whether the shape is right. */
export const NO_DEPENDENCIES: Dependencies = [];

/** An id is a row's, so it is a whole number above zero. Refused at the edge rather than
 *  recorded: an edge to story 0 answers `prerequisitesOf` with a story that can never
 *  finish, which reads exactly like a story that has not finished yet. */
function id(value: number, role: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DependsError(`${role} is not a story id: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Distinct and in id order — the same answer whatever order the edges were declared in.
 *  A caller comparing two reads is comparing what is needed, not when it was said. */
const ids = (found: readonly number[]): readonly number[] =>
  [...new Set(found)].sort((a, b) => a - b);

/** What a story needs, directly. Empty for a story nobody has declared anything about,
 *  which is the same answer as for a story that needs nothing: there is no third state,
 *  and a caller asking "may this start" wants the same false either way.
 *
 *  Direct, not transitive, and deliberately: if 3 needs 2 and 2 needs 1, then 3 is held up
 *  by 2 and by nothing else — 2 cannot finish before 1 does, so 1 is already accounted for
 *  by the time the question is asked again. The transitive reach is the cycle check's
 *  business, below, and exposing it here would invite a caller to block 3 on a story it
 *  has no edge to and cannot see. */
export const prerequisitesOf = (declared: Dependencies, story: number): readonly number[] =>
  ids(declared.filter((d) => d.dependent === story).map((d) => d.prerequisite));

/** Who is waiting on a story. The other direction of the same edges, so the two reads can
 *  never disagree about whether an edge is there. This is the read that answers *what does
 *  finishing this unblock*, which is the question a landing asks. */
export const dependentsOf = (declared: Dependencies, story: number): readonly number[] =>
  ids(declared.filter((d) => d.prerequisite === story).map((d) => d.dependent));

/** The chain of needs from one story to another, or null when there is none.
 *
 *  Breadth-first, so the chain a refusal names is the shortest one there is. A longer one
 *  is no more true and is harder to read, and the shortest is the one a person can check
 *  by eye.
 *
 *  `seen` is not an optimisation. Every set `dependsOn` grew is acyclic, but
 *  `Dependencies` is a caller's value and a caller may hand over one built some other way
 *  — a plan file read straight off disk, a row set mid-migration. A walk that trusted the
 *  input would go round such a set for ever, which is the one failure a dependency check
 *  must not have. With it, an already-circular set gets an answer like any other. */
function chain(declared: Dependencies, from: number, to: number): readonly number[] | null {
  const queue: (readonly number[])[] = [[from]];
  const seen = new Set<number>([from]);
  while (queue.length > 0) {
    const path = queue.shift() as readonly number[];
    const at = path[path.length - 1] as number;
    if (at === to) return path;
    for (const next of prerequisitesOf(declared, at)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

/** Declare that one story needs another, and get the declarations back with it.
 *
 *  Refused when the edge would close a path — when the prerequisite already needs the
 *  dependent, by any chain of edges, the shortest of which the refusal names. Also refused
 *  when a story is given as its own prerequisite, which is the same rule at length one and
 *  is spelled separately only because "1 already needs 1, by 1" explains nothing.
 *
 *  Declaring an edge that is already there is not refused and does not record a second
 *  copy. Saying a true thing twice is not an error, and a caller replaying a plan file
 *  would otherwise have to remember which half of it it had already said. */
export function dependsOn(
  declared: Dependencies,
  dependent: number,
  prerequisite: number,
): Dependencies {
  id(dependent, "the dependent");
  id(prerequisite, "the prerequisite");

  if (dependent === prerequisite) {
    throw new DependsError(`story ${dependent} cannot need itself`);
  }
  if (declared.some((d) => d.dependent === dependent && d.prerequisite === prerequisite)) {
    return declared;
  }

  const closes = chain(declared, prerequisite, dependent);
  if (closes !== null) {
    throw new DependsError(
      `story ${dependent} cannot need story ${prerequisite}: ` +
        `${prerequisite} already needs ${dependent}, by ${closes.join(" → ")}`,
    );
  }

  return [...declared, { dependent, prerequisite }];
}

/** The edges and the ranks as the record holds them, for the one caller that cannot be given
 *  them: the runner.
 *
 *  The module above is deliberately a value and not a table, and `readyCandidates`'
 *  `UNORDERED` default is deliberately inert — `queue-completeness.test.ts` holds the bare
 *  `readyCandidates(db)` to the board's queued panel id for id, and a queue is something a
 *  caller opts into. Both of those are right, and together they left the allocator with no way
 *  to opt in: `order.ts` may not read `story` or `story_depends_on` (its table list is gated),
 *  and nothing else offered to load them. So the loader lives here, beside the rule it feeds,
 *  and the allocator passes what it returns.
 *
 *  A story with no rank is absent from `priority` rather than present as 0, so "nobody has
 *  ranked this" and "ranked zero" stay the same answer the way `order.ts` already reads them,
 *  and a story that has never been ranked costs no row. */
export function queueOf(db: DatabaseSync): { depends: Dependencies; priority: Record<number, number> } {
  const edges = queries(db)
    .selectFrom(dependsTable)
    .select(["story_id", "depends_on_id"])
    .all()
    .map((r) => ({ dependent: r.story_id, prerequisite: r.depends_on_id }));
  const priority: Record<number, number> = {};
  for (const r of queries(db).selectFrom(rankTable).select(["id", "priority"]).all()) {
    if (r.priority !== 0) priority[r.id] = r.priority;
  }
  return { depends: edges, priority };
}
