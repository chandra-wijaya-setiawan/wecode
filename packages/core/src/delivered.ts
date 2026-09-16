import type { DatabaseSync } from "node:sqlite";
import type { Row } from "./board.js";
import { queries, table } from "./db.js";

/** The columns this module reads, and only those. A narrow declaration is not a second copy
 *  of the schema: it is the ask, and `typed-delivered.test.ts` holds each list against
 *  `PRAGMA table_info` so a column renamed out from under it fails a test.
 *
 *  Unexported, every one of them: `index.ts` re-exports this module whole, and `story`,
 *  `chore` and the rest are words other modules already own. */
interface StoryRow {
  id: number;
  slug: string;
  title: string;
  state: string;
  epic_id: number;
  updated_at: string;
}
const story = table<StoryRow>("story", ["id", "slug", "title", "state", "epic_id", "updated_at"]);

const epic = table<{ id: number; release_id: number }>("epic", ["id", "release_id"]);
const release = table<{ id: number; project_id: number }>("release", ["id", "project_id"]);
const requirement = table<{ id: number; story_id: number }>("requirement", ["id", "story_id"]);

interface CriteriaRow {
  id: number;
  slug: string;
  statement: string;
  state: string;
  requirement_id: number;
}
const criteria = table<CriteriaRow>("acceptance_criteria", ["id", "slug", "statement", "state", "requirement_id"]);

const landedBranch = table<{ branch: string; sha: string }>("landed_branch", ["branch", "sha"]);
const refusal = table<{ chore_id: number; why: string }>("chore_refusal", ["chore_id", "why"]);

interface ChoreRow {
  id: number;
  kind: string;
  state: string;
  target_type: string;
  target_id: number;
}
const chore = table<ChoreRow>("chore", ["id", "kind", "state", "target_type", "target_id"]);

/** SQLite's own catalogue, declared like any other table so that asking whether a table
 *  exists goes through the same layer as every other read. */
const catalogue = table<{ type: string; name: string }>("sqlite_master", ["type", "name"]);

/** One accepted criteria, as its statement. The statement rather than the title is the
 *  point: a duplicate check reads what was promised, and a title says only what it was
 *  called. */
export interface DeliveredCriteria {
  readonly id: number;
  readonly slug: string;
  readonly statement: string;
}

/** How far a delivered story's work has actually reached, in the record's own terms.
 *
 *  | reach      | the record says                                        |
 *  | ---------- | ------------------------------------------------------ |
 *  | `landed`   | `landed_branch` holds the branch: it is on the base     |
 *  | `behind`   | an open `refresh` chore: the base has moved past it     |
 *  | `waiting`  | some other open chore owes it work                      |
 *  | `unlanded` | nothing landed it and nothing is owed                   |
 *
 *  `behind` is a reach of its own rather than one more `waiting`, because a `refresh`
 *  chore is the only thing in the record that names *why* a branch has not arrived. */
export const REACHES = ["landed", "behind", "waiting", "unlanded"] as const;
export type StoryReach = (typeof REACHES)[number];

/** A delivered story and what it delivered. `landed` is read from `landed_branch` — the
 *  runner's own record of what it merged — and never from the story's state: delivered is
 *  a fact about the record, on the base is a fact about the repository, and they are
 *  routinely not the same thing for a day at a time. */
export interface DeliveredStory {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly delivered_at: string;
  readonly branch: string;
  readonly landed: boolean;
  /** The sha `landed_branch` recorded, or null when nothing landed it. */
  readonly sha: string | null;
  readonly reach: StoryReach;
  /** The kind of the open chore the story waits on, or null when none is open. Carried
   *  beside `reach` because "waits on a chore" is not actionable without the kind. */
  readonly owed: string | null;
  /** Why that chore has not been carried out, in the chore's own words — the sentence on
   *  its `chore_refusal` row — or null when nothing has been said about it.
   *
   *  A `failed` refresh chore out of its attempts is the case this exists for: nothing will
   *  come back to rewrite that row, the chore will never be handed out again, and the story
   *  is stuck behind the base for a reason only the chore knows. Read onto the story rather
   *  than left on the chore because the story is what a person is looking at. */
  readonly why: string | null;
  readonly criteria: readonly DeliveredCriteria[];
}

/** The runner creates `landed_branch` when it first lands something, so a workspace that
 *  has never run one has no table. That is not an error: it is a workspace where nothing
 *  has landed, and every story reads unlanded. */
const hasTable = (db: DatabaseSync, name: string): boolean =>
  queries(db).selectFrom(catalogue).select(["name"]).where("type", "=", "table").where("name", "=", name).get() !== null;

/** The project a story hangs under, walked up through its epic and its release.
 *
 *  Two maps and a lookup rather than the two joins this replaces, and the walk is total on
 *  purpose: a story whose epic or release is missing yields nothing, exactly as an inner
 *  join dropped it, whether or not a project was asked for. */
const projectOf = (db: DatabaseSync): ((epic_id: number) => number | undefined) => {
  const q = queries(db);
  const inRelease = new Map(q.selectFrom(release).all().map((r) => [r.id, r.project_id]));
  const inEpic = new Map(q.selectFrom(epic).all().map((e) => [e.id, e.release_id]));
  return (epic_id) => {
    const rel = inEpic.get(epic_id);
    return rel === undefined ? undefined : inRelease.get(rel);
  };
};

/** Accepted criteria per story, in requirement then criteria order.
 *
 *  Dropped criteria are left out: a dropped criteria was a decision not to build it, so
 *  listing it under a delivered story would claim the opposite of what happened.
 *
 *  One read for the whole tree rather than the per-story query this replaces — the order
 *  the join produced is a sort here, and grouping by the requirement's story is a map. */
const criteriaByStory = (db: DatabaseSync): Map<number, DeliveredCriteria[]> => {
  const q = queries(db);
  const storyOf = new Map(q.selectFrom(requirement).all().map((r) => [r.id, r.story_id]));
  const grouped = new Map<number, DeliveredCriteria[]>();
  const accepted = q
    .selectFrom(criteria)
    .select(["id", "slug", "statement", "requirement_id"])
    .where("state", "=", "accepted")
    .all()
    .sort((a, b) => a.requirement_id - b.requirement_id || a.id - b.id);

  for (const c of accepted) {
    const s = storyOf.get(c.requirement_id);
    if (s === undefined) continue;
    grouped.set(s, [...(grouped.get(s) ?? []), { id: c.id, slug: c.slug, statement: c.statement }]);
  }
  return grouped;
};

/** Every chore nobody has finished, against the story it targets, oldest first. `done` is
 *  the only terminal state, so anything else is work still owed — `failed` included,
 *  because a chore that failed its check is re-raised and the branch has still not arrived.
 *
 *  The reason is a second read rather than a correlated subquery: the dialect spells no
 *  subquery, and a table that a workspace older than the chore migration does not have is
 *  read as nothing at all. */
const openChores = (db: DatabaseSync): Map<number, OpenChore[]> => {
  const q = queries(db);
  const why = hasTable(db, "chore_refusal")
    ? new Map(q.selectFrom(refusal).all().map((f) => [f.chore_id, f.why]))
    : new Map<number, string>();

  const owed = new Map<number, OpenChore[]>();
  const open = q
    .selectFrom(chore)
    .select(["id", "kind", "target_id"])
    .where("target_type", "=", "story")
    .where("state", "!=", "done")
    .all()
    .sort((a, b) => a.id - b.id);

  for (const c of open) {
    const found = { kind: c.kind, why: why.get(c.id) ?? null };
    owed.set(c.target_id, [...(owed.get(c.target_id) ?? []), found]);
  }
  return owed;
};

/** Which reach the record supports, most definite first. A landing is a fact about the
 *  base branch and outranks every chore: a chore open against a story that has already
 *  landed is the next merge's problem, not this delivery's. */
const reachOf = (landed: boolean, open: readonly OpenChore[]): Reached => {
  if (landed) return { reach: "landed", owed: null, why: null };
  const refresh = open.filter((c) => c.kind === "refresh");
  if (refresh.length > 0) return { reach: "behind", owed: "refresh", why: reasonOf(refresh) };
  const first = open[0];
  if (first !== undefined) {
    return { reach: "waiting", owed: first.kind, why: reasonOf(open.filter((c) => c.kind === first.kind)) };
  }
  return { reach: "unlanded", owed: null, why: null };
};

interface OpenChore {
  readonly kind: string;
  readonly why: string | null;
}

type Reached = Pick<DeliveredStory, "reach" | "owed" | "why">;

/** The reason among the chores of the owed kind, oldest first. Two open chores of one kind
 *  is already a state nobody wants, and in it the sentence to show is the one the earliest
 *  chore is stuck on rather than a blank from a later chore nothing has said anything
 *  about yet. */
const reasonOf = (chores: readonly OpenChore[]): string | null => chores.find((c) => c.why !== null)?.why ?? null;

/** What wecode can already do: every delivered story, newest first, with the statements of
 *  the criteria it met and whether its branch is on the base.
 *
 *  This is the corpus a duplicate check reads before work is planned. Epic 105 held
 *  thirteen stories later work had already done, and the only way to have known was to
 *  walk the tree by hand. */
export function delivered(db: DatabaseSync, project: number | null = null): readonly DeliveredStory[] {
  const shaOf = hasTable(db, "landed_branch")
    ? new Map(queries(db).selectFrom(landedBranch).all().map((l) => [l.branch, l.sha]))
    : new Map<string, string>();

  const owedTo = openChores(db);
  const met = criteriaByStory(db);
  const under = projectOf(db);

  // Newest first, and by descending id where two deliveries share a stamp — the whole
  // record is written by one clock at millisecond resolution, so a tie is routine and the
  // id is the only thing left that orders it.
  const stories = queries(db)
    .selectFrom(story)
    .select(["id", "slug", "title", "epic_id", "updated_at"])
    .where("state", "=", "delivered")
    .all()
    .map((s) => ({ ...s, project: under(s.epic_id) }))
    .filter((s) => s.project !== undefined && (project === null || s.project === project))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id));

  return stories.map((s) => {
    const branch = `story/${s.slug}`;
    const sha = shaOf.get(branch);
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      delivered_at: s.updated_at,
      branch,
      landed: sha !== undefined,
      sha: sha ?? null,
      ...reachOf(sha !== undefined, owedTo.get(s.id) ?? []),
      criteria: met.get(s.id) ?? [],
    };
  });
}

/** The same answer in the board's shape, so the cockpit shows it as a filter over the
 *  record rather than a second query of its own. The detail carries the reach, because a
 *  delivered story that is not on the base is the one a person has to act on — and which
 *  of the three ways it is not on the base decides whether they act or wait. */
export function deliveredRows(db: DatabaseSync, project: number | null = null): readonly Row[] {
  return delivered(db, project).map((s) => ({
    id: s.id,
    what: s.title,
    state: "delivered",
    detail: `${says(s)} · ${s.criteria.length} criteria`,
  }));
}

/** One phrase per reach. `unlanded` keeps its bare word: nothing is owed and nothing
 *  explains it, which is exactly what a person needs to see. */
const says = (s: DeliveredStory): string => {
  if (s.reach === "landed") return `landed ${s.branch}`;
  if (s.reach === "behind") return because("behind the base · refresh chore open", s.why);
  if (s.reach === "waiting") return because(`unlanded · waits on a ${s.owed ?? ""} chore`, s.why);
  return "unlanded";
};

/** The chore's sentence, after the reach that made it worth reading. The reach alone says a
 *  person has to act; the sentence is the only thing that says what they would be acting
 *  on, so it goes on the same line rather than a page away. */
const because = (reach: string, why: string | null): string => (why === null ? reach : `${reach} · ${why}`);
