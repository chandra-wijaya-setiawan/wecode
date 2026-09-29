/** Creating the five rungs that are the work itself: requirement, acceptance_criteria,
 *  acceptance_test, task, task_test.
 *
 *  Where `verbs/tree.ts` holds the rungs that exist to hold other rungs, these are the ones
 *  that say what is to be true and what proves it. Each is the whole of what that word
 *  means, one exported function, called from run.ts's dispatch on the entity name.
 *
 *  All five hang off something, so unlike a workspace every one of them asks `parent()`.
 *  The two tests also carry how they are run and what runs them; the fallback for a missing
 *  `--artefact` is the project's own test command, which is a question about the working
 *  directory and so stays in run.ts — what arrives here is already resolved. */
import type { Maker, TestKind } from "@wecode/core";

export interface Work {
  readonly make: Maker;
  /** What the positionals spelled: the statement, or the task's title. */
  readonly text: string;
  /** The `--parent` id, or a throw naming the flag when argv did not give one. */
  readonly parent: () => number;
  /** `--kind`, already narrowed. Only the two tests read it. */
  readonly kind: TestKind;
  /** `--artefact`, or the project's test command, or null. Only the two tests read it. */
  readonly artefact: string | null;
  /** `--role`. Only a task reads it. */
  readonly role: string;
}

export const requirement = (at: Work): number => at.make.requirement(at.parent(), at.text);

export const acceptanceCriteria = (at: Work): number => at.make.criteria(at.parent(), at.text);

export const acceptanceTest = (at: Work): number =>
  at.make.acceptanceTest(at.parent(), at.text, at.kind, at.artefact);

export const task = (at: Work): number => at.make.task(at.parent(), at.text, { role: at.role });

export const taskTest = (at: Work): number =>
  at.make.taskTest(at.parent(), at.text, at.kind, at.artefact);
