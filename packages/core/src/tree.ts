import type { DatabaseSync } from "node:sqlite";

export interface Node {
  readonly entity: string;
  readonly id: number;
  readonly label: string;
  readonly state: string;
  readonly children: readonly Node[];
}

interface Row {
  id: number;
  label: string;
  state: string;
  parent: number;
}

/** One level, keyed by its parent. Reading the whole tree is nine cheap queries rather than
 *  one query per node — the shape is fixed, so the walk can be too. */
function level(db: DatabaseSync, table: string, label: string, fk: string): Map<number, Row[]> {
  const rows = db
    .prepare(`SELECT id, ${label} AS label, state, ${fk} AS parent FROM ${table} ORDER BY id`)
    .all() as unknown as Row[];
  const by = new Map<number, Row[]>();
  for (const r of rows) by.set(r.parent, [...(by.get(r.parent) ?? []), r]);
  return by;
}

/** project → release → epic → story → requirement → acceptance_criteria → acceptance_test
 *  → task → task_test. The document order, which is also the order work is shaped in. */
export function tree(db: DatabaseSync, projectId?: number): readonly Node[] {
  const releases = level(db, "release", "version", "project_id");
  const epics = level(db, "epic", "title", "release_id");
  const stories = level(db, "story", "title", "epic_id");
  const requirements = level(db, "requirement", "statement", "story_id");
  const criteria = level(db, "acceptance_criteria", "statement", "requirement_id");
  const tests = level(db, "acceptance_test", "statement", "parent_id");
  const tasks = level(db, "task", "title", "acceptance_test_id");
  const taskTests = level(db, "task_test", "statement", "parent_id");

  const node = (entity: string, r: Row, children: readonly Node[]): Node => ({
    entity,
    id: r.id,
    label: r.label,
    state: r.state,
    children,
  });

  const under = (by: Map<number, Row[]>, id: number): Row[] => by.get(id) ?? [];

  const projects = db
    .prepare(
      projectId === undefined
        ? "SELECT id, name AS label, state, workspace_id AS parent FROM project ORDER BY id"
        : "SELECT id, name AS label, state, workspace_id AS parent FROM project WHERE id = ?",
    )
    .all(...(projectId === undefined ? [] : [projectId])) as unknown as Row[];

  return projects.map((p) =>
    node(
      "project",
      p,
      under(releases, p.id).map((rel) =>
        node(
          "release",
          rel,
          under(epics, rel.id).map((e) =>
            node(
              "epic",
              e,
              under(stories, e.id).map((s) =>
                node(
                  "story",
                  s,
                  under(requirements, s.id).map((req) =>
                    node(
                      "requirement",
                      req,
                      under(criteria, req.id).map((c) =>
                        node(
                          "acceptance_criteria",
                          c,
                          under(tests, c.id).map((t) =>
                            node(
                              "acceptance_test",
                              t,
                              under(tasks, t.id).map((task) =>
                                node(
                                  "task",
                                  task,
                                  under(taskTests, task.id).map((tt) => node("task_test", tt, [])),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
