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
