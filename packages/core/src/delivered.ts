import type { DatabaseSync } from "node:sqlite";
import type { Row } from "./board.js";

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
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const STORIES = `
  SELECT s.id AS id, s.slug AS slug, s.title AS title, s.updated_at AS delivered_at
    FROM story s
    JOIN epic e ON e.id = s.epic_id
    JOIN release r ON r.id = e.release_id
   WHERE s.state = 'delivered'
     AND (:project IS NULL OR r.project_id = :project)
   ORDER BY s.updated_at DESC, s.id DESC`;

/** Accepted only. A dropped criteria was a decision not to build it, so listing it under
 *  a delivered story would claim the opposite of what happened. */
const CRITERIA = `
  SELECT c.id AS id, c.slug AS slug, c.statement AS statement
    FROM acceptance_criteria c
    JOIN requirement q ON q.id = c.requirement_id
   WHERE q.story_id = ? AND c.state = 'accepted'
   ORDER BY q.id, c.id`;

/** Every chore nobody has finished, against the story it targets. `done` is the only
 *  terminal state, so anything else is work still owed — `failed` included, because a
 *  chore that failed its check is re-raised and the branch has still not arrived. */
const openChores = (db: DatabaseSync): string => `
  SELECT c.target_id AS story, c.kind AS kind,
         ${hasTable(db, "chore_refusal") ? `(SELECT f.why FROM chore_refusal f WHERE f.chore_id = c.id)` : "NULL"} AS why
    FROM chore c
   WHERE c.target_type = 'story' AND c.state <> 'done'
   ORDER BY c.id`;

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
  const landed = hasTable(db, "landed_branch")
    ? db.prepare("SELECT branch, sha FROM landed_branch").all() as unknown as { branch: string; sha: string }[]
    : [];
  const shaOf = new Map(landed.map((l) => [l.branch, l.sha]));

  const open = db.prepare(openChores(db)).all() as unknown as (OpenChore & { story: number })[];
  const owedTo = new Map<number, OpenChore[]>();
  for (const c of open) owedTo.set(c.story, [...(owedTo.get(c.story) ?? []), { kind: c.kind, why: c.why }]);

  const stories = db.prepare(STORIES).all({ project }) as unknown as {
    id: number;
    slug: string;
    title: string;
    delivered_at: string;
  }[];

  return stories.map((s) => {
    const branch = `story/${s.slug}`;
    const sha = shaOf.get(branch);
    return {
      ...s,
      branch,
      landed: sha !== undefined,
      sha: sha ?? null,
      ...reachOf(sha !== undefined, owedTo.get(s.id) ?? []),
      criteria: db.prepare(CRITERIA).all(s.id) as unknown as DeliveredCriteria[],
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
