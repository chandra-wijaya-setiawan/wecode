/** What a chore's worker is actually told.
 *
 *  The foreman decides *whether* an attempt exists; this decides what it reads when it
 *  starts. The two are separable — the wording of a brief changes for reasons that have
 *  nothing to do with sessions, worktrees or phases — so the prompt lives here and the
 *  foreman only looks the chore up and hands over the facts. */

/** What a brief has to say a chore in words, gathered once so a kind's own brief is a
 *  function of it and not a second set of queries. */
export interface BriefContext {
  readonly kind: string;
  readonly check: string;
  readonly target_type: string;
  readonly target: string;
  /** The story branch, when the target is a story. */
  readonly branch: string;
  readonly base: string;
}

/** The line every chore brief ends on.
 *
 *  A worker's standing instruction is to write the tests that prove its work, which is
 *  right for a task and wrong for a chore: a chore proves no acceptance_test, and a test
 *  written to assert a merge happened pins this merge rather than any requirement. The
 *  brief countermands it, because the brief is the only half of the prompt a chore owns. */
export const NO_TESTS =
  "Write no new tests: this is a chore, not a task, and its check is the one named above." +
  " Run the suite that already exists.";

/** One brief per kind — a table, so a new kind is a row here beside its row in
 *  CHORE_KIND_DEFS, rather than another branch in a widening conditional. Each says what
 *  the work is for, what to do, what the check is, and what not to touch, in that order:
 *  a worker that reads only the first line still knows what it is looking at. */
export const CHORE_BRIEFS: Readonly<Record<string, (c: BriefContext) => string[]>> = {
  merge: (c) => [
    `This is a merge chore for ${c.branch}.`,
    `What it is for: ${c.branch} was delivered and will not merge into ${c.base}, so the merge` +
      ` has to be made by hand — a conflict is wherever the conflict is.`,
    `Merge ${c.base} into ${c.branch} in this tree, resolve every conflict, and commit the result` +
      ` on the branch.`,
    `The check: ${c.base} merges cleanly into ${c.branch} and the suite still passes.` +
      ` The record carries it as "${c.check}".`,
    `Do not commit on ${c.base}, and do not land anything: landing is the operator's verb.`,
  ],
  refresh: (c) => [
    `This is a refresh chore for ${c.branch}.`,
    `What it is for: ${c.branch} is still in flight and has fallen behind ${c.base}, so the work` +
      ` on it is being built against a base that has moved.`,
    `Merge ${c.base} into ${c.branch} in this tree, resolve every conflict, and commit the result` +
      ` on the branch. Keep the story's own work — this brings the base in, it does not undo` +
      ` what the story has done so far.`,
    `The check: ${c.branch} is no longer behind ${c.base} and the suite still passes.` +
      ` The record carries it as "${c.check}".`,
    `The story is not finished and it is not yours to finish: change nothing beyond what the` +
      ` merge needs, and do not land anything.`,
  ],
  sweep: (c) => [
    `This is a sweep chore for ${c.target_type} ${c.target}.`,
    `What it is for: the record holds work that no longer matches the world, and a person has` +
      ` already approved putting it right.`,
    `Bring the record into line with what is actually true, and change nothing else.`,
    `The check: ${c.check}.`,
    `Only what the check names is in scope. If the right answer needs a decision, say so and` +
      ` stop rather than guessing.`,
  ],
};

/** A kind with no brief of its own still gets a usable one: what it is, and its check as
 *  the record stores it. A missing row is a gap in this table, not in the chore. */
export const anyChore = (c: BriefContext): string[] => [
  `${c.kind} ${c.target_type} ${c.target}. The check: ${c.check}.`,
];

/** The whole prompt for one chore: its kind's brief, and the line every kind ends on. */
export function choreBrief(c: BriefContext): string {
  const write = CHORE_BRIEFS[c.kind] ?? anyChore;
  return [...write(c), NO_TESTS].join("\n");
}
