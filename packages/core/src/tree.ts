import type { DatabaseSync } from "node:sqlite";

/** project → release → epic → story → requirement → acceptance_criteria → acceptance_test
 *  → task → task_test. The document order, which is also the order work is shaped in. */
export type TreeLevel =
  | "project"
  | "release"
  | "epic"
  | "story"
  | "requirement"
  | "acceptance_criteria"
  | "acceptance_test"
  | "task"
  | "task_test";

/** Every descendant of a node, in three buckets. Not the node itself. */
export interface Rollup {
  /** released, delivered, met, accepted, passed, done — the work that landed. */
  readonly done: number;
  /** planned, in_progress, on_hold, ready — the work still ahead. */
  readonly open: number;
  /** failed, dropped — the work that will not land as it stands. */
  readonly failed: number;
}

export interface Node {
  readonly entity: string;
  readonly id: number;
  readonly label: string;
  readonly state: string;
  /** Empty at the requested depth even when the node bears children — see `folded`. */
  readonly children: readonly Node[];
  readonly rollup: Rollup;
  /** This node has children below the requested depth. A view shows a fold marker on it
   *  without a second query; nothing about those children is here. */
  readonly folded: boolean;
}

export interface TreeOptions {
  /** How many levels below the project to return. Named by its deepest level; `story`
   *  when an options argument is passed without one. */
  readonly depth?: TreeLevel;
}

interface Row {
  id: number;
  label: string;
  state: string;
  parent: number;
}

interface Level {
  readonly entity: TreeLevel;
  readonly table: string;
  readonly label: string;
  readonly fk: string;
}

/** The levels below the project, in order. Each one's depth is its position here. */
const LEVELS: readonly Level[] = [
  { entity: "release", table: "release", label: "version", fk: "project_id" },
  { entity: "epic", table: "epic", label: "title", fk: "release_id" },
  { entity: "story", table: "story", label: "title", fk: "epic_id" },
  { entity: "requirement", table: "requirement", label: "statement", fk: "story_id" },
  { entity: "acceptance_criteria", table: "acceptance_criteria", label: "statement", fk: "requirement_id" },
  { entity: "acceptance_test", table: "acceptance_test", label: "statement", fk: "parent_id" },
  { entity: "task", table: "task", label: "title", fk: "acceptance_test_id" },
  { entity: "task_test", table: "task_test", label: "statement", fk: "parent_id" },
];

/** Which bucket a state counts in. The terminal-and-landed states of every machine in
 *  config/machines.yaml; `failed` and `dropped` are spelled the same in all of them. */
const DONE: ReadonlySet<string> = new Set(["released", "delivered", "met", "accepted", "passed", "done"]);
const FAILED: ReadonlySet<string> = new Set(["failed", "dropped"]);

const bucket = (state: string): keyof Rollup => (DONE.has(state) ? "done" : FAILED.has(state) ? "failed" : "open");

/** One level, keyed by its parent. Reading the whole tree is nine cheap queries rather than
 *  one query per node — the shape is fixed, so the walk can be too. */
function level(db: DatabaseSync, { table, label, fk }: Level): Map<number, Row[]> {
  const rows = db
    .prepare(`SELECT id, ${label} AS label, state, ${fk} AS parent FROM ${table} ORDER BY id`)
    .all() as unknown as Row[];
  const by = new Map<number, Row[]>();
  for (const r of rows) by.set(r.parent, [...(by.get(r.parent) ?? []), r]);
  return by;
}

const depthOf = (depth: TreeLevel): number =>
  depth === "project" ? 0 : LEVELS.findIndex((l) => l.entity === depth) + 1;

/** The whole forest, or one project. With no options argument every level is returned, so
 *  callers written before depth existed see exactly what they saw. Pass options — even an
 *  empty one — and the tree is cut at `depth`, `story` by default. The rollup is counted in
 *  the same post-order walk that builds the nodes, once per node, cut or not. */
export function tree(db: DatabaseSync, projectId?: number, options?: TreeOptions): readonly Node[] {
  const cut = options === undefined ? LEVELS.length : depthOf(options.depth ?? "story");
  const levels = LEVELS.map((l) => level(db, l));

  const build = (r: Row, entity: TreeLevel, at: number): Node => {
    const kids = (levels[at]?.get(r.id) ?? []).map((k) => build(k, LEVELS[at]!.entity, at + 1));
    const rollup = { done: 0, open: 0, failed: 0 };
    for (const k of kids) {
      rollup[bucket(k.state)] += 1;
      rollup.done += k.rollup.done;
      rollup.open += k.rollup.open;
      rollup.failed += k.rollup.failed;
    }
    // a node at level `at` bears children at level `at + 1`, so its children survive the cut
    // only while `at` is strictly above it
    const shown = at < cut;
    return {
      entity,
      id: r.id,
      label: r.label,
      state: r.state,
      children: shown ? kids : [],
      rollup,
      folded: !shown && kids.length > 0,
    };
  };

  const projects = db
    .prepare(
      projectId === undefined
        ? "SELECT id, name AS label, state, workspace_id AS parent FROM project ORDER BY id"
        : "SELECT id, name AS label, state, workspace_id AS parent FROM project WHERE id = ?",
    )
    .all(...(projectId === undefined ? [] : [projectId])) as unknown as Row[];

  return projects.map((p) => build(p, "project", 0));
}
