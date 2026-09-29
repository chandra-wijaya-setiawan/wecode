import type { DatabaseSync } from "node:sqlite";
import { queries, table, type Dialect } from "./db.js";
import {
  ALLOW,
  all,
  refuse,
  taskFinishesOnItsOwnWork,
  type Guard,
  type GuardName,
  type GuardRegistry,
  type TaskWork,
} from "./guards.js";
import type { Repo } from "./repo.js";
import type { StatefulEntity } from "./types.js";

/** A refusal that tells the operator what to run next.
 *
 *  The command is data, not prose, because a verb can be checked and a sentence cannot.
 *  `wecode acceptance-test invalidate` was wrong twice over — the entity is spelled with an
 *  underscore everywhere the cli reads one, and `invalidate` is not legal from `failed`,
 *  which is the state that refusal is raised in; `reprove` is. It was followed twice on
 *  15 Sep before anybody noticed, because a refusal is read at the moment the operator has
 *  least reason to doubt it.
 *
 *  `test/refusal-commands.test.ts` proves every row here against machines.yaml and the cli's
 *  own verb table, so a verb that is not legal from `raisedIn` fails the suite rather than
 *  the operator. The convention the same test relies on: **a refusal that names a command
 *  writes it in backticks, and takes the text from here.** A backticked `wecode …` in this
 *  package with no row is a failure too. */
export interface CommandRefusal {
  /** The refusal site, so a failure names where to look. */
  readonly site: string;
  /** The entity, spelled the way the cli's first argument is spelled. */
  readonly entity: string;
  readonly verb: string;
  /** The state the refusal is raised in. A machine verb has to be legal from here. */
  readonly raisedIn: string;
  /** Everything after the verb, as the operator would type it. */
  readonly tail: string;
}

export const COMMAND_REFUSALS: readonly CommandRefusal[] = [
  { site: "create.settled.passed", entity: "acceptance_test", verb: "invalidate", raisedIn: "passed", tail: "<id>" },
  { site: "create.settled.failed", entity: "acceptance_test", verb: "reprove", raisedIn: "failed", tail: "<id>" },
  {
    site: "checks.task_may_be_attempted.no_write_scope",
    entity: "task",
    verb: "scope",
    raisedIn: "planned",
    tail: '<id> --write "src/**"',
  },
  {
    site: "checks.task_may_be_attempted.planned_test",
    entity: "task_test",
    verb: "deliver",
    raisedIn: "planned",
    tail: "<id>",
  },
  {
    site: "checks.task_may_be_attempted.planned_parent",
    entity: "acceptance_test",
    verb: "deliver",
    raisedIn: "planned",
    tail: "<id>",
  },
];

/** The command a site names, rendered. Unknown sites throw rather than yield a blank: a
 *  refusal with no command in it is the dead end this table exists to prevent. */
export function commandOf(site: string): string {
  const row = COMMAND_REFUSALS.find((r) => r.site === site);
  if (row === undefined) throw new Error(`no refusal command registered for ${site}`);
  return `wecode ${row.entity} ${row.verb} ${row.tail}`.trimEnd();
}

const kindOf = (repo: Repo, entity: string): string =>
  repo.childEntityOf(entity as StatefulEntity) ?? "children";

const naming = (children: readonly { id: number; state: string }[]): string =>
  children.slice(0, 5).map((c) => `#${c.id} is ${c.state}`).join(", ");

/** Every child settled, and at least one of them succeeded. The cascade guards to a
 *  success state are all this shape, so they are built rather than written five times.
 *
 *  Dropping a child is not a way of proving it. Dropping the last one used to satisfy this
 *  — all-dropped is all-settled — so the parent cascaded to a success state and, since
 *  drop is not legal from one, could not be undone: story 148 is delivered and empty. An
 *  all-dropped parent has nothing behind it, so it stays where it is and drop stays legal.
 *  A parent with no children has nothing behind it either, at any level. */
function allChildrenSucceeded(repo: Repo, success: readonly string[]): Guard {
  const settled = [...success, "dropped"];
  return ({ entity, id }) => {
    const children = repo.childrenOf(entity as StatefulEntity, id);
    const kind = kindOf(repo, entity);
    if (children.length === 0) return refuse(`it has no ${kind} — nothing proves it`);

    const unsettled = children.filter((c) => !settled.includes(c.state));
    if (unsettled.length > 0) {
      return refuse(
        `${unsettled.length} of ${children.length} not yet ${settled.join(" or ")}: ${naming(unsettled)}`,
      );
    }
    return children.some((c) => success.includes(c.state))
      ? ALLOW
      : refuse(
          `all ${children.length} ${kind} are dropped — nothing proves it; drop it rather than ` +
            `${success[0]} it`,
        );
  };
}

/** Every child dropped, or none to drop. Nothing fires this on its own: a childless row
 *  reaches dropped only because somebody said so, which is why the empty case is allowed
 *  here and refused above. */
function allChildrenDropped(repo: Repo): Guard {
  return ({ entity, id }) => {
    const children = repo.childrenOf(entity as StatefulEntity, id);
    const live = children.filter((c) => c.state !== "dropped");
    return live.length === 0
      ? ALLOW
      : refuse(
          `${live.length} of ${children.length} ${kindOf(repo, entity)} not dropped: ${naming(live)}`,
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

/** Read through the same typed layer the repository uses, so the columns a guard reaches
 *  for are checked against the table even though it reached past the accessors. */
const queriesOf = (repo: Repo): Dialect => queries(dbOf(repo));

/** The part of an acceptance_test a guard reads: what to call it in a refusal, and the base
 *  it was last seen red at. Unexported — `index.ts` re-exports this module wholesale. */
const acceptanceTest = table<{
  id: number;
  slug: string;
  statement: string;
  red_at_base_sha: string | null;
}>("acceptance_test", ["id", "slug", "statement", "red_at_base_sha"]);

/** The part of a design a guard reads: what to call it in a refusal, the picture it names,
 *  and who signed it. */
const design = table<{
  id: number;
  slug: string;
  title: string;
  mockup: string | null;
  signed_by: string | null;
}>("design", ["id", "slug", "title", "mockup", "signed_by"]);

/** Who a signature names, and whether they are a person. A worker nobody has registered is
 *  no answer either way, which is why the row is read rather than the name parsed. */
const signatory = table<{ name: string; kind: string }>("worker", ["name", "kind"]);

/** The part of a task a guard reads to name the branch its work was done on. */
const taskNaming = table<{ id: number; slug: string }>("task", ["id", "slug"]);

/** The attempts made on something, and what each one committed. An attempt that wrote
 *  nothing records no sha, which is how "the branch holds no commit of its own" is
 *  visible from the record alone. */
const attempt = table<{
  objective_type: string;
  objective_id: number;
  commit_sha: string | null;
}>("assignment", ["objective_type", "objective_id", "commit_sha"]);

/** What the record knows about the branch a task was worked on.
 *
 *  The branch is named from the slug, the same way the runner names it when it cuts one.
 *  Its own commits are the attempt commits recorded against the task: a refresh merge is
 *  never one of them, because nothing records a sha for a merge nobody's attempt made. */
const workOnTask = (repo: Repo) => (id: number): TaskWork | null => {
  const q = queriesOf(repo);
  const task = q.selectFrom(taskNaming).select(["slug"]).where("id", "=", id).get();
  if (task === null) return null;
  const attempts = q
    .selectFrom(attempt)
    .select(["commit_sha"])
    .where("objective_type", "=", "task")
    .where("objective_id", "=", id)
    .all();
  const ownCommits = attempts
    .map((a) => a.commit_sha)
    .filter((sha): sha is string => sha !== null && sha.trim() !== "");
  return { branch: `task/${task.slug}`, ownCommits };
};

/** Whether a test names something to run. One definition, because two guards ask it and a
 *  copy that drifted would let one of them through. */
const hasArtefact = (repo: Repo, entity: string, id: number): boolean => {
  const artefact = repo.artefactOf(entity as "acceptance_test" | "task_test", id);
  return artefact !== null && artefact.trim() !== "";
};

/** The guards, wired to a repository.
 *
 *  The cascade guards read children and nothing else, which is what makes the chain from a
 *  passing test to a delivered epic mechanical rather than a decision anybody makes. */
export function guards(repo: Repo): Readonly<Record<GuardName, Guard>> {
  return {
    every_epic_delivered_or_dropped: allChildrenSucceeded(repo, ["delivered"]),
    every_epic_dropped: allChildrenDropped(repo),
    every_story_delivered_or_dropped: allChildrenSucceeded(repo, ["delivered"]),
    every_story_dropped: allChildrenDropped(repo),
    every_requirement_met_or_dropped: allChildrenSucceeded(repo, ["met"]),
    every_requirement_dropped: allChildrenDropped(repo),
    every_criteria_accepted_or_dropped: allChildrenSucceeded(repo, ["accepted"]),
    every_criteria_dropped: allChildrenDropped(repo),
    every_acceptance_test_settled: allChildrenSucceeded(repo, ["passed"]),
    /** The guard on `task.finish`, and the only one. A transition names one guard, so the
     *  two questions a finish has to answer are asked by one built from both: the tests
     *  agree, *and* the branch holds a commit the task wrote. Tests alone are not enough —
     *  a task whose task_tests were dropped settles them all and would finish on an empty
     *  branch, leaving the record saying work landed that no commit carries. */
    every_task_test_settled: all(
      allChildrenSucceeded(repo, ["passed"]),
      taskFinishesOnItsOwnWork(workOnTask(repo)),
    ),

    /** A test whose artefact is missing is unrunnable, and silently so. */
    artefact_resolves: ({ entity, id }) =>
      hasArtefact(repo, entity, id) ? ALLOW : refuse("it has no artefact — there is nothing to run or to follow"),

    /** A design with no picture is a promise of one.
     *
     *  The same sentence as `artefact_resolves`, asked of a different column, and not the
     *  same guard: a test's artefact is something to run and a design's mockup is something
     *  to look at, so one guard over both would let a design be drafted on a shell command.
     *  It reads the stored path and never stats it — a guard is evaluated wherever a verb
     *  is applied, and whether a file is on disk changes with the branch. */
    mockup_resolves: ({ entity, id }) => {
      if (entity !== "design") return refuse(`${entity} names no mockup`);
      const row = queriesOf(repo).selectFrom(design).select(["slug", "mockup"]).where("id", "=", id).get();
      if (row === null) return refuse(`no design #${id}`);
      return row.mockup !== null && row.mockup.trim() !== ""
        ? ALLOW
        : refuse(`design ${row.slug} #${id} names no mockup — there is nothing to look at or to sign`);
    },

    /** Only a person signs a design.
     *
     *  Authority is not relayed, the same rule `answer_is_permitted` states: an agent may
     *  draw the mockup, propose it and argue for it, and may not be the one who approved
     *  it. Capability parity, never authority parity — a signature an agent gave is the
     *  record agreeing with itself, and the whole reason the row exists is that somebody
     *  outside the work looked.
     *
     *  A name nobody has registered as a worker is refused rather than trusted: an unknown
     *  signatory is indistinguishable from a typed-in one, and the safe reading of "I do
     *  not know who that is" is no. */
    signature_is_a_persons: ({ entity, id }) => {
      if (entity !== "design") return refuse(`${entity} is not signed`);
      const q = queriesOf(repo);
      const row = q.selectFrom(design).select(["slug", "title", "signed_by"]).where("id", "=", id).get();
      if (row === null) return refuse(`no design #${id}`);
      const name = row.signed_by?.trim() ?? "";
      if (name === "") {
        return refuse(
          `design ${row.slug} #${id} ("${row.title}") is unsigned — record who approved it before drawing it`,
        );
      }
      const worker = q.selectFrom(signatory).select(["kind"]).where("name", "=", name).get();
      if (worker === null) return refuse(`${name} is not a registered worker — nobody by that name can have signed`);
      return worker.kind === "human"
        ? ALLOW
        : refuse(`${name} is an ${worker.kind} — a design is approved by a person, and authority is not relayed`);
    },

    /** A failed test asks to be judged again.
     *
     *  `failed` used to be where a test stopped: the only ways out were `pass`, which
     *  `test_has_been_red` guards, and `drop`. A test that failed because its tree had no
     *  node_modules was therefore finished, and so was its story — four of them sat there.
     *
     *  What `reprove` clears is the verdict itself: `failed` *is* the recorded verdict, and
     *  returning the test to `ready` says only that nothing is proved of it yet. It asserts
     *  no outcome — a re-proved test still has to be run, and an acceptance_test still has
     *  to be seen red at its base, before `pass` will have it (docs/design/19: healing may
     *  re-run a test, it may never mark one passed). So this guard asks only whether there
     *  is anything to run again. A test with no artefact would go back to `ready` and stay
     *  there, unrunnable, which is the dead end again under a better-looking state. */
    test_may_be_reproved: ({ entity, id }) =>
      hasArtefact(repo, entity, id) ? ALLOW : refuse("it has no artefact — there is nothing to run again"),

    /** A test nobody has seen fail cannot pass: it may assert what the code already did.
     *
     *  This reads the record and only the record. It does not run the test, stat a file or
     *  look at a clock — a guard is evaluated wherever a verb is applied, which is often
     *  nowhere near a worktree, so anything derived from the tree would be a guess. Red is
     *  recorded by whoever watched it happen; this only insists that somebody did. */
    test_has_been_red: ({ entity, id }) => {
      if (entity !== "acceptance_test") return refuse(`${entity} records no red run at its base`);
      const row = queriesOf(repo)
        .selectFrom(acceptanceTest)
        .select(["slug", "statement", "red_at_base_sha"])
        .where("id", "=", id)
        .get();
      if (row === null) return refuse(`no acceptance_test #${id}`);
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
        return refuse(
          `it has no write scope — \`${commandOf("checks.task_may_be_attempted.no_write_scope")}\` sets one`,
        );
      }
      if (task.role.trim() === "") return refuse("no role is assigned");
      const tests = repo.childrenOf("task", id);
      // A task_test left in `planned` is neither passed nor dropped, so `finish`'s guard
      // — every_task_test_settled — can never be satisfied: the task dispatches, an agent
      // works, and it runs to max_retry with the board saying nothing about why. Observed
      // on task 198 on 15 Sep, which carried one planned test beside one ready one and so
      // satisfied the ready-or-passed requirement below. The gap is closed where the work
      // starts rather than where it ends, so the operator learns before an attempt is
      // spent. Dropped is settled and does not block.
      //
      // The older requirement is asked first: a task whose only test is planned has no way
      // of proving itself at all, and "no task_test is ready" is the nearer answer to that
      // than a lecture about settling.
      const planned = tests.filter((t) => t.state === "planned");
      if (!tests.some((t) => t.state === "ready" || t.state === "passed")) {
        return refuse("no task_test is ready — a task says how it proves itself before it runs");
      }
      if (planned.length > 0) {
        return refuse(
          `${planned.length} task_test still planned (${naming(planned)}) — a planned test can never ` +
            `settle, so the task could never finish; \`${commandOf("checks.task_may_be_attempted.planned_test")}\` ` +
            "delivers it, or drop it",
        );
      }
      // The task proves itself against its parent acceptance_test, and a parent left in
      // `planned` has not been delivered: it has no run anybody could judge the criteria
      // by. The task would finish, its own tests would settle, and the criteria above it
      // would still be unaccepted with nothing on the board saying why. This is the same
      // dead end as a planned task_test, one level up, so it is caught at the same place —
      // where the work starts, before an attempt is spent. Every other parent state is
      // fine here: `create` already refuses a task under a settled acceptance_test, and a
      // `ready` or re-proved one is exactly what a task is for.
      const parent = repo.parentOf("task", id);
      if (parent !== null && repo.stateOf(parent.entity, parent.id) === "planned") {
        return refuse(
          `its acceptance_test #${parent.id} is still planned — nothing would judge the work, so the ` +
            `criteria above it could never be accepted; ` +
            `\`${commandOf("checks.task_may_be_attempted.planned_parent")}\` delivers it`,
        );
      }
      return ALLOW;
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
