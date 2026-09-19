/** docs/design/14 §landing, docs/design/19 §provenance. The checklist run before a story's
 *  branch goes into the base, and what each item on it entitles wecode to do.
 *
 *  Landing used to turn on one boolean — every acceptance test under the story passed, and
 *  there is at least one. That answers "may this merge" and nothing else, so every way of
 *  failing it came out the same shape: the merge is held, and a `land` chore is raised for a
 *  person to read. A story whose last task is still running, a story delivered above tests
 *  that were all dropped, and a story whose branch will not merge are three different
 *  situations, and two of them are not anybody's fault yet.
 *
 *  So the checklist is classified. Every item says what kind of thing it found, and the
 *  classification — not the item — decides what wecode is entitled to do about it:
 *
 *  | classification | what it means                                    | wecode may |
 *  | -------------- | ------------------------------------------------ | ---------- |
 *  | `false_claim`  | the record says proved, and nothing proves it    | reopen     |
 *  | `outstanding`  | work simply unfinished — nobody claimed otherwise | hold       |
 *  | `stale`        | a pass taken against sources nobody has now      | hold       |
 *  | `blocked`      | the merge cannot be made at all                  | hold       |
 *
 *  **Only a false claim is reopened.** The other three hold the merge and say why, because
 *  none of them is a lie in the record: unfinished work finishes, a stale pass is re-proved
 *  by running it, and a branch that will not merge wants a merge. Reopening on those would
 *  throw away a story because its last task had not landed yet.
 *
 *  And a stale pass is held rather than invalidated for design 19's reason exactly:
 *  re-proving a verdict is a decision, and nothing automatic may make one. Holding the
 *  merge is the strongest thing this is allowed to do with a verdict it distrusts.
 *
 *  Pure, and nothing here reads a database or a checkout: the caller gathers the rows and
 *  the two shas, and gets back the checklist plus the verbs it is entitled to apply. That
 *  is what lets the whole classification be proved without a repository. */

/** What kind of thing an item found, in the order a reader should care about it. */
export type Classification = "false_claim" | "stale" | "outstanding" | "blocked";

/** The one classification that entitles wecode to change the record. */
export const REOPENS: Classification = "false_claim";

/** A row the checklist can name. `entity` is spelled the way the cli spells it. */
export interface Named {
  readonly entity: "story" | "acceptance_test" | "task";
  readonly id: number;
  readonly slug: string;
  readonly state: string;
}

/** An acceptance test under the story, and the tree its verdict was taken against.
 *  `provenance_sha` absent or null is a verdict older than the stamp — not evidence of
 *  drift, so it is not accused of any. */
export interface TestRow extends Named {
  readonly entity: "acceptance_test";
  readonly provenance_sha?: string | null;
}

/** Everything the checklist reads. The caller owns the gathering: the rows come from the
 *  core, `tree_sha` and `merges` from a checkout, and a caller who could not read the tree
 *  leaves the sha out rather than guessing at one. */
export interface Subject {
  readonly story: Named & { readonly entity: "story" };
  readonly tests: readonly TestRow[];
  readonly tasks: readonly (Named & { readonly entity: "task" })[];
  /** The story tree as it stands now, for comparing a pass's stamp against. */
  readonly tree_sha?: string | null;
  /** Does the branch go into the base? Read off the graph by the caller. */
  readonly merges: boolean;
}

/** One thing the checklist found. `check` is the item's name, and stays the same sentence
 *  whether it passed or failed, so a reader can match a finding to the list. */
export interface Finding {
  readonly check: string;
  readonly classification: Classification;
  readonly subject: Named;
  readonly why: string;
}

/** A verb wecode is entitled to apply, and to what. Only ever a false claim's. */
export interface Reopen {
  readonly entity: Named["entity"];
  readonly id: number;
  readonly verb: string;
}

/** The checklist, run. `merge` is the whole list being empty — every hold is a hold, and
 *  no classification is advisory. */
export interface Checklist {
  readonly findings: readonly Finding[];
  readonly merge: boolean;
  readonly reopen: readonly Reopen[];
}

/** The names of the items, as the board and the chore's reason spell them. */
export const CHECKS = {
  delivered: "the story says delivered",
  proved: "something under the story passed",
  settled: "every acceptance test has settled green",
  current: "every pass proves the tree the story is at",
  tasks: "every task under the story is settled",
  merges: "the branch goes into the base",
} as const;

/** Said of a story in a success state that nothing under it proves — the same sentence
 *  `all_children_dropped_is_not_success` passes on an empty tree, asked one merge earlier. */
export const NOTHING_PROVES_IT = "nothing under it passed";

/** Said of a pass whose stamp is not the tree the story stands at. The words are design
 *  19's own, so the doctor's accusation and this hold read alike. */
export const IT_PROVES_A_TREE_NOBODY_HAS = "it proves a tree nobody has now";

const live = <T extends Named>(rows: readonly T[]): readonly T[] => rows.filter((r) => r.state !== "dropped");

const finding = (check: string, classification: Classification, subject: Named, why: string): Finding => ({
  check,
  classification,
  subject,
  why,
});

/** Is the story even claiming to be finished? A story that is not delivered is not a false
 *  claim about anything — it is work in flight, which is `outstanding`. */
function deliveredItem(s: Subject): readonly Finding[] {
  if (s.story.state === "delivered") return [];
  return [finding(CHECKS.delivered, "outstanding", s.story, `it is ${s.story.state}, not delivered`)];
}

/** The gate's own question, and the only item that can be a false claim.
 *
 *  A delivered story with nothing passed under it says it was proved and was not: every
 *  test dropped, or none written. That is the record contradicting itself rather than work
 *  outstanding, so it is the one finding wecode may act on. A story that is not delivered
 *  is silent here — `deliveredItem` has already held the merge, and accusing an unfinished
 *  story of lying is the false positive this classification exists to avoid. */
function provedItem(s: Subject): readonly Finding[] {
  if (s.story.state !== "delivered") return [];
  if (live(s.tests).some((t) => t.state === "passed")) return [];
  const how = s.tests.length === 0 ? "it has no acceptance test" : `all ${s.tests.length} are dropped or open`;
  return [finding(CHECKS.proved, "false_claim", s.story, `${how} — ${NOTHING_PROVES_IT}`)];
}

/** Every test that is neither passed nor dropped. One finding each: four open tests are
 *  four pieces of work, and a single finding against the story would let three of them be
 *  closed by answering one. */
function settledItem(s: Subject): readonly Finding[] {
  return live(s.tests)
    .filter((t) => t.state !== "passed")
    .map((t) => finding(CHECKS.settled, "outstanding", t, `it is ${t.state}`));
}

/** A pass taken against a tree the story is no longer at. Quiet about an unstamped verdict
 *  and about a tree nobody read: this holds a merge on two shas it actually has, or not at
 *  all. Quiet about a red, too — a red is already held by `settledItem`, and calling it
 *  drift would read as an excuse for it. */
function currentItem(s: Subject): readonly Finding[] {
  const tip = s.tree_sha;
  if (typeof tip !== "string") return [];
  return live(s.tests)
    .filter((t) => t.state === "passed" && typeof t.provenance_sha === "string" && t.provenance_sha !== tip)
    .map((t) =>
      finding(
        CHECKS.current,
        "stale",
        t,
        `passed against tree ${t.provenance_sha!.slice(0, 12)}, and the story is at ` +
          `${tip.slice(0, 12)} — ${IT_PROVES_A_TREE_NOBODY_HAS}`,
      ),
    );
}

/** A task still in hand under the story. Outstanding, never a false claim: the story's
 *  delivery may still come true the moment the task finishes, and that is exactly the case
 *  reopening would destroy. */
function tasksItem(s: Subject): readonly Finding[] {
  return s.tasks
    .filter((t) => t.state !== "done" && t.state !== "dropped")
    .map((t) => finding(CHECKS.tasks, "outstanding", t, `it is ${t.state}`));
}

/** The merge itself. Nothing about the record is wrong; there is simply no merge to make
 *  here, which is docs/design/18's `merge` chore and a person's problem, not a reopening. */
function mergesItem(s: Subject): readonly Finding[] {
  if (s.merges) return [];
  return [finding(CHECKS.merges, "blocked", s.story, "the branch does not go into the base")];
}

/** The checklist, in the order it is read: the claim first, then what backs it, then what
 *  is still moving, then the merge. */
const ITEMS: readonly ((s: Subject) => readonly Finding[])[] = [
  deliveredItem,
  provedItem,
  settledItem,
  currentItem,
  tasksItem,
  mergesItem,
];

/** Which verb puts a row back in hand. Only `story` is here, because only a story can be
 *  found making a false claim: a verdict is never reopened automatically (design 19), and
 *  an unfinished task is not a claim. */
const REOPEN_VERB: Partial<Record<Named["entity"], string>> = { story: "reopen" };

/** Run the checklist over one story.
 *
 *  Every item runs, always — the first failure does not short-circuit the rest, because the
 *  reason a merge is held is the whole list and not the first row of it. A person reading
 *  "held: 1 false claim, 2 outstanding" knows something a person reading the first line
 *  does not. */
export function premerge(subject: Subject): Checklist {
  const findings = ITEMS.flatMap((item) => item(subject));
  const reopen = findings
    .filter((f) => f.classification === REOPENS)
    .flatMap((f) => {
      const verb = REOPEN_VERB[f.subject.entity];
      return verb === undefined ? [] : [{ entity: f.subject.entity, id: f.subject.id, verb }];
    });
  return { findings, merge: findings.length === 0, reopen };
}

/** The held merge in one line, for a chore's reason and the board. Empty when it merges. */
export function why(list: Checklist): string {
  if (list.merge) return "";
  const counted = (["false_claim", "stale", "outstanding", "blocked"] as const)
    .map((c) => ({ c, n: list.findings.filter((f) => f.classification === c).length }))
    .filter(({ n }) => n > 0)
    .map(({ c, n }) => `${n} ${c}`)
    .join(", ");
  return `held (${counted}): ${list.findings.map((f) => `${f.check} — ${f.why}`).join("; ")}`;
}
