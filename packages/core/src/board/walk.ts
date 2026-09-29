import type { AssignmentRow, Ledger } from "./rows.js";

/** A row per id, for the lookups that used to be joins. */
export const index = <T, V>(rows: readonly T[], id: (r: T) => number, value: (r: T) => V): Map<number, V> =>
  new Map(rows.map((r) => [id(r), value(r)]));

const step = (m: Map<number, number>, id: number | null): number | null =>
  id === null ? null : (m.get(id) ?? null);

/** The project a row belongs to. Every group but `projects` hangs somewhere under a project,
 *  and the walk up is the only way to know which: nothing below a project carries a
 *  project_id, so nothing can disagree with it.
 *
 *  A Map per level rather than the five nested subqueries this replaces: the dialect spells
 *  no join, and the same five steps are taken for every row of every group, so the levels
 *  are read once. A step that finds nothing is `null`, as a subquery over no rows was.
 *
 *  Each method takes the id of the thing named, so `ofStory` is given a story. The strings
 *  it replaces did not hold to that — `ofStory` read `FROM epic e WHERE e.id = ${id}` while
 *  every caller handed it a story id, so a narrowed board placed a story by whichever epic
 *  happened to share its id. Typed maps cannot express that: `storyEpic` is keyed by story
 *  and `epicRelease` by epic, and handing one to the other does not compile. */
export class Walk {
  private readonly releaseProject: Map<number, number>;
  private readonly epicRelease: Map<number, number>;
  private readonly storyEpic: Map<number, number>;
  private readonly requirementStory: Map<number, number>;
  private readonly criteriaRequirement: Map<number, number>;
  private readonly testCriteria: Map<number, number>;
  private readonly taskTest: Map<number, number>;
  private readonly taskTestTask: Map<number, number>;

  constructor(ledger: Ledger) {
    const id = <T extends { id: number }>(r: T): number => r.id;
    this.releaseProject = index(ledger.releases, id, (r) => r.project_id);
    this.epicRelease = index(ledger.epics, id, (e) => e.release_id);
    this.storyEpic = index(ledger.stories, id, (s) => s.epic_id);
    this.requirementStory = index(ledger.requirements, id, (r) => r.story_id);
    this.criteriaRequirement = index(ledger.criteria, id, (c) => c.requirement_id);
    this.testCriteria = index(ledger.tests, id, (t) => t.parent_id);
    this.taskTest = index(ledger.tasks, id, (t) => t.acceptance_test_id);
    this.taskTestTask = index(ledger.taskTests, id, (t) => t.parent_id);
  }

  ofRelease(release: number | null): number | null {
    return step(this.releaseProject, release);
  }
  ofEpic(epic: number | null): number | null {
    return this.ofRelease(step(this.epicRelease, epic));
  }
  ofStory(story: number | null): number | null {
    return this.ofEpic(step(this.storyEpic, story));
  }
  ofCriteria(c: number | null): number | null {
    return this.ofStory(step(this.requirementStory, step(this.criteriaRequirement, c)));
  }
  ofTest(test: number | null): number | null {
    return this.ofCriteria(step(this.testCriteria, test));
  }
  ofTask(task: number | null): number | null {
    return this.ofTest(step(this.taskTest, task));
  }
  ofTaskTest(test: number | null): number | null {
    return this.ofTask(step(this.taskTestTask, test));
  }

  /** An assignment's project is its objective's; a kind not named has none, as a `CASE` with no `ELSE` said. */
  ofAssignment(a: AssignmentRow): number | null {
    if (a.objective_type === "story") return this.ofStory(a.objective_id);
    if (a.objective_type === "task") return this.ofTask(a.objective_id);
    if (a.objective_type === "acceptance_test") return this.ofTest(a.objective_id);
    if (a.objective_type === "task_test") return this.ofTaskTest(a.objective_id);
    return null;
  }

  /** The story a task is under, for the two groups that count tasks per story. */
  storyOfTask(task: number | null): number | null {
    return step(
      this.requirementStory,
      step(this.criteriaRequirement, step(this.testCriteria, step(this.taskTest, task))),
    );
  }
}
