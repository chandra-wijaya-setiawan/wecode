/** A guard answers one question about the world, by name. The machine table says *which*
 *  transition needs which guard; this says what each one checks.
 *
 *  Every guard the table names must exist here, or the machine set is rejected at load —
 *  a typo that silently permits a transition is the failure this prevents. */
export interface GuardContext {
  /** The entity the transition is being applied to. */
  readonly entity: string;
  readonly id: number;
}

export type Guard = (ctx: GuardContext) => GuardResult;

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

export const ALLOW: GuardResult = { ok: true };
export const refuse = (why: string): GuardResult => ({ ok: false, why });

/** Every guard name the machine table may use. Implementations arrive with the repository;
 *  until then each refuses, which is the safe direction. */
export const GUARD_NAMES = [
  "every_epic_delivered_or_dropped",
  "every_epic_dropped",
  "every_story_delivered_or_dropped",
  "every_story_dropped",
  "every_requirement_met_or_dropped",
  "every_requirement_dropped",
  "every_criteria_accepted_or_dropped",
  "every_criteria_dropped",
  "every_acceptance_test_settled",
  "every_task_test_settled",
  "artefact_resolves",
  "test_may_be_reproved",
  "test_has_been_red",
  "task_may_be_attempted",
  "max_retry_reached",
  "answer_is_permitted",
] as const;

export type GuardName = (typeof GUARD_NAMES)[number];

export type GuardRegistry = Readonly<Partial<Record<GuardName, Guard>>>;

/** A registry with nothing implemented. A named guard that is not registered refuses,
 *  so an unimplemented check blocks the transition rather than waving it through. */
export const EMPTY_GUARDS: GuardRegistry = {};

/** One transition names one guard, so a transition that must ask two questions asks a
 *  guard built from both. The first refusal is the answer: the reasons are not joined,
 *  because two of them read as a list of complaints rather than as the thing to fix. */
export const all = (...guards: readonly Guard[]): Guard => (ctx) => {
  for (const guard of guards) {
    const result = guard(ctx);
    if (!result.ok) return result;
  }
  return ALLOW;
};

/** What the record knows about the branch a task was worked on.
 *
 *  `ownCommits` is the shas the branch carries that its base does not. A refresh merge
 *  brings the base's commits forward onto the branch, so "the branch has commits" is not
 *  the question — "the branch has commits of its own" is. */
export interface TaskWork {
  readonly branch: string;
  readonly ownCommits: readonly string[];
}

/** A task is done when its work exists. `every_task_test_settled` asks whether the tests
 *  agree; it does not ask whether anything was written — a task whose tests were dropped
 *  settles them all and finishes on an empty branch, and the record then says work landed
 *  that no commit carries.
 *
 *  This reads the record and only the record, like every other guard: whoever cut and
 *  merged the branch reports what is on it, because a guard is evaluated wherever a verb
 *  is applied, which is usually nowhere near a worktree. */
export const taskFinishesOnItsOwnWork =
  (workOf: (id: number) => TaskWork | null): Guard => ({ entity, id }) => {
    if (entity !== "task") return refuse(`${entity} is not worked on a branch of its own`);
    const work = workOf(id);
    if (work === null) return refuse(`no branch is recorded for task #${id} — nothing was worked on`);
    return work.ownCommits.length === 0
      ? refuse(`${work.branch} holds no commit of its own — the task wrote nothing to finish on`)
      : ALLOW;
  };
