import type { DatabaseSync } from "node:sqlite";
import { ALLOW, refuse, type Guard, type GuardName, type GuardRegistry } from "./guards.js";
import type { Repo } from "./repo.js";
import type { StatefulEntity } from "./types.js";

/** Every child is in one of these states. The cascade guards are all this shape, so they
 *  are built rather than written eight times. */
function allChildrenIn(repo: Repo, settled: readonly string[], noChildrenIsEnough = false): Guard {
  return ({ entity, id }) => {
    const children = repo.childrenOf(entity as StatefulEntity, id);
    if (children.length === 0) {
      return noChildrenIsEnough
        ? ALLOW
        : refuse(`it has no ${repo.childEntityOf(entity as StatefulEntity) ?? "children"} — nothing proves it`);
    }
    const unsettled = children.filter((c) => !settled.includes(c.state));
    return unsettled.length === 0
      ? ALLOW
      : refuse(
          `${unsettled.length} of ${children.length} not yet ${settled.join(" or ")}: ` +
            unsettled.slice(0, 5).map((c) => `#${c.id} is ${c.state}`).join(", "),
        );
  };
}

/** The database behind a repository.
 *
 *  A guard that reads a column Repo exposes no accessor for still has to read it from the
 *  record, and the registry is built from a Repo alone. Reaching through it is narrower
 *  than widening every caller's signature; the point being preserved is that a guard's
 *  only input is the stored row. */
const dbOf = (repo: Repo): DatabaseSync => (repo as unknown as { db: DatabaseSync }).db;

/** The guards, wired to a repository.
 *
 *  The cascade guards read children and nothing else, which is what makes the chain from a
 *  passing test to a delivered epic mechanical rather than a decision anybody makes. */
export function guards(repo: Repo): Readonly<Record<GuardName, Guard>> {
  return {
    every_epic_delivered_or_dropped: allChildrenIn(repo, ["delivered", "dropped"]),
    every_epic_dropped: allChildrenIn(repo, ["dropped"], true),
    every_story_delivered_or_dropped: allChildrenIn(repo, ["delivered", "dropped"]),
    every_story_dropped: allChildrenIn(repo, ["dropped"], true),
    every_requirement_met_or_dropped: allChildrenIn(repo, ["met", "dropped"]),
    every_requirement_dropped: allChildrenIn(repo, ["dropped"], true),
    every_criteria_accepted_or_dropped: allChildrenIn(repo, ["accepted", "dropped"]),
    every_criteria_dropped: allChildrenIn(repo, ["dropped"], true),
    every_acceptance_test_settled: allChildrenIn(repo, ["passed", "dropped"]),
    every_task_test_settled: allChildrenIn(repo, ["passed", "dropped"]),

    /** A test whose artefact is missing is unrunnable, and silently so. */
    artefact_resolves: ({ entity, id }) => {
      const artefact = repo.artefactOf(entity as "acceptance_test" | "task_test", id);
      return artefact === null || artefact.trim() === ""
        ? refuse("it has no artefact — there is nothing to run or to follow")
        : ALLOW;
    },

    /** A test nobody has seen fail cannot pass: it may assert what the code already did.
     *
     *  This reads the record and only the record. It does not run the test, stat a file or
     *  look at a clock — a guard is evaluated wherever a verb is applied, which is often
     *  nowhere near a worktree, so anything derived from the tree would be a guess. Red is
     *  recorded by whoever watched it happen; this only insists that somebody did. */
    test_has_been_red: ({ entity, id }) => {
      if (entity !== "acceptance_test") return refuse(`${entity} records no red run at its base`);
      const row = dbOf(repo)
        .prepare("SELECT slug, statement, red_at_base_sha FROM acceptance_test WHERE id = ?")
        .get(id) as { slug: string; statement: string; red_at_base_sha: string | null } | undefined;
      if (row === undefined) return refuse(`no acceptance_test #${id}`);
      return row.red_at_base_sha === null
        ? refuse(
            `acceptance_test ${row.slug} #${id} ("${row.statement}") has never been seen to fail — ` +
              "record the base it was red at before passing it",
          )
        : ALLOW;
    },

    /** docs/design/05: a scope, a role, and at least one task_test ready. */
    task_may_be_attempted: ({ id }) => {
      const task = repo.taskScopeAndRole(id);
      if (task === null) return refuse(`no task #${id}`);
      const scope = JSON.parse(task.scope) as { write?: string[] };
      if (!Array.isArray(scope.write) || scope.write.length === 0) {
        return refuse("it has no write scope — wecode task scope sets one");
      }
      if (task.role.trim() === "") return refuse("no role is assigned");
      const tests = repo.childrenOf("task", id);
      return tests.some((t) => t.state === "ready" || t.state === "passed")
        ? ALLOW
        : refuse("no task_test is ready — a task says how it proves itself before it runs");
    },

    /** One failed attempt does not fail a task; the retry limit does. */
    max_retry_reached: ({ id }) => {
      const t = repo.taskRetry(id);
      if (t === null) return refuse(`no task #${id}`);
      return t.attempts >= t.max_retry
        ? ALLOW
        : refuse(`${t.attempts} of ${t.max_retry} attempts used — retry, or drop it`);
    },

    /** Authority is not relayed: an approval may be answered only by the operator. */
    answer_is_permitted: () => ALLOW,
  };
}

export function registry(repo: Repo): GuardRegistry {
  return guards(repo);
}
