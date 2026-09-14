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
      criteria: db.prepare(CRITERIA).all(s.id) as unknown as DeliveredCriteria[],
    };
  });
}

/** The same answer in the board's shape, so the cockpit shows it as a filter over the
 *  record rather than a second query of its own. The detail carries the landing, because
 *  a delivered story that is not on the base is the one a person has to act on. */
export function deliveredRows(db: DatabaseSync, project: number | null = null): readonly Row[] {
  return delivered(db, project).map((s) => ({
    id: s.id,
    what: s.title,
    state: "delivered",
    detail: `${s.landed ? `landed ${s.branch}` : "unlanded"} · ${s.criteria.length} criteria`,
  }));
}
