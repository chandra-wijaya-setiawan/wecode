import type { DatabaseSync } from "node:sqlite";
import { Engine } from "./apply.js";
import { Maker } from "./create.js";
import { queries, table } from "./db.js";
import type { ObjectiveType } from "./entities.js";
import { transact } from "./store.js";

/** An approval is an assignment whose worker is a person. docs/design/16 — everything a
 *  person owes wecode arrives on the board the same way work does, because a question
 *  nobody can see is a question nobody answers.
 *
 *  Not a new table: an assignment already carries `kind`, `question`, `options`, `answer`
 *  and `answered_by`, and already has a `waiting` phase that `needs_human` filters on. The
 *  only thing missing was a way in — every route to `waiting` ran through `running`, which
 *  presumes an agent got there first. An approval has no agent: wecode raises it, a person
 *  answers it, and `raise: pending → waiting` in machines.yaml is that way in.
 *
 *  Authority is not relayed. An approval is answered by a human worker or not at all, and
 *  that is checked here rather than in `answer_is_permitted`: the guard registry sees a
 *  transition and an id, never who is invoking it. */

export class ApprovalError extends Error {}

/** The only kind of ask this module raises. `input` and `option` are what a running agent
 *  asks through the foreman; an approval is what wecode itself asks of a person. */
export const APPROVAL_KIND = "approval";

/** An approval has no worktree to cut and nothing to spend: nobody runs it. The columns are
 *  NOT NULL, so they are written empty rather than left out. */
const NO_WORK = {
  scope: { write: [] as string[], tools: [] as string[] },
  budget: { tokens: 0, seconds: 0 },
  worktree: "",
} as const;

export interface ApprovalSpec {
  readonly objective_type: ObjectiveType;
  readonly objective_id: number;
  /** The person being asked. A worker of kind `agent` is refused. */
  readonly worker_id: number;
  readonly question: string;
  /** The answers that are permitted, if the question is closed. Null or absent is an open
   *  question, and any non-empty answer settles it. */
  readonly options?: readonly string[] | null;
}

export interface Approval {
  readonly id: number;
  readonly objective_type: string;
  readonly objective_id: number;
  readonly worker_id: number;
  readonly phase: string;
  readonly kind: string | null;
  readonly question: string | null;
  readonly options: readonly string[] | null;
  readonly answer: string | null;
  readonly answered_by: string | null;
}

interface ApprovalRow {
  id: number;
  objective_type: string;
  objective_id: number;
  worker_id: number;
  phase: string;
  kind: string | null;
  question: string | null;
  options: string | null;
  answer: string | null;
  answered_by: string | null;
}

const assignments = table<ApprovalRow>("assignment", [
  "id",
  "objective_type",
  "objective_id",
  "worker_id",
  "phase",
  "kind",
  "question",
  "options",
  "answer",
  "answered_by",
]);

const workers = table<{ id: number; name: string; kind: string }>("worker", ["id", "name", "kind"]);

/** Stored JSON, read back as the list it was. A row hand-edited into something that is not
 *  a list of strings is read as no options at all: a board that throws is no board. */
const optionsOf = (stored: string | null): readonly string[] | null => {
  if (stored === null) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.every((o) => typeof o === "string") ? (parsed as string[]) : null;
};

const shape = (row: ApprovalRow): Approval => ({
  id: row.id,
  objective_type: row.objective_type,
  objective_id: row.objective_id,
  worker_id: row.worker_id,
  phase: row.phase,
  kind: row.kind,
  question: row.question,
  options: optionsOf(row.options),
  answer: row.answer,
  answered_by: row.answered_by,
});

const rowOf = (db: DatabaseSync, id: number): ApprovalRow | null =>
  queries(db).selectFrom(assignments).where("id", "=", id).get();

/** One approval, or nothing. An assignment that is not an approval is not one of these. */
export function approvalById(db: DatabaseSync, id: number): Approval | null {
  const row = rowOf(db, id);
  return row === null || row.kind !== APPROVAL_KIND ? null : shape(row);
}

/** Every approval still waiting on somebody, oldest first. The same rows the board's
 *  `needs_human` group draws, in the shape a caller that means to answer one needs. */
export function waitingApprovals(db: DatabaseSync): readonly Approval[] {
  return queries(db)
    .selectFrom(assignments)
    .all()
    .filter((a) => a.kind === APPROVAL_KIND && a.phase === "waiting")
    .sort((a, b) => a.id - b.id)
    .map(shape);
}

/** The worker, if there is one. */
const workerById = (db: DatabaseSync, id: number) =>
  queries(db).selectFrom(workers).where("id", "=", id).get();

const humanNamed = (db: DatabaseSync, name: string) =>
  queries(db)
    .selectFrom(workers)
    .all()
    .find((w) => w.name === name && w.kind === "human");

/** Raise a question for a person and put it in `waiting`, where the board will show it.
 *
 *  Created and raised in one transaction: an assignment left in `pending` with an approval's
 *  question on it is a row the allocator counts against the attention budget and no cockpit
 *  ever draws. */
export function raiseApproval(db: DatabaseSync, spec: ApprovalSpec, engine: Engine = new Engine(db)): Approval {
  if (spec.question.trim() === "") throw new ApprovalError("an approval must ask something");

  const options = spec.options ?? null;
  if (options !== null && options.length === 0) {
    throw new ApprovalError("an approval with options must offer at least one. Pass no options for an open question.");
  }

  const worker = workerById(db, spec.worker_id);
  if (worker === null) throw new ApprovalError(`no worker #${spec.worker_id} to ask`);
  if (worker.kind !== "human") {
    throw new ApprovalError(
      `worker #${spec.worker_id} (${worker.name}) is an ${worker.kind}, and an approval is asked of a person. ` +
        "Name a worker of kind human.",
    );
  }

  return transact(db, () => {
    const id = new Maker(db).assignment({
      objective_type: spec.objective_type,
      objective_id: spec.objective_id,
      worker_id: spec.worker_id,
      ...NO_WORK,
    });
    queries(db)
      .update(assignments)
      .set({
        kind: APPROVAL_KIND,
        question: spec.question,
        options: options === null ? null : JSON.stringify(options),
      })
      .where("id", "=", id)
      .run();

    const raised = engine.apply("assignment", id, "raise", "wecode");
    if (!raised.ok) throw new ApprovalError(`approval #${id} could not be raised: ${raised.why}`);

    const row = rowOf(db, id);
    if (row === null) throw new ApprovalError(`approval #${id} was written and could not be read back`);
    return shape(row);
  });
}

/** Answer one, in the answerer's own name.
 *
 *  Who answered is recorded twice on purpose, and neither is redundant: `answered_by` is
 *  what the row carries afterwards, and the ledger line is what the record keeps of the
 *  moment — a second answer overwrites the column and cannot overwrite the history.
 *
 *  `answer` then `finish`: the machine routes an answered assignment back through `running`
 *  because for an agent's ask that is exactly right — it goes back to work. An approval has
 *  no work to go back to, so it finishes in the same transaction and never sits in a phase
 *  the board would draw as running. */
export function answerApproval(db: DatabaseSync, id: number, answer: string, by: string, engine: Engine = new Engine(db)): Approval {
  const row = rowOf(db, id);
  if (row === null || row.kind !== APPROVAL_KIND) throw new ApprovalError(`no approval #${id}`);
  if (row.phase !== "waiting") {
    throw new ApprovalError(`approval #${id} is ${row.phase}, not waiting; there is nothing to answer`);
  }
  if (answer.trim() === "") throw new ApprovalError(`approval #${id} takes an answer, and "" is not one`);

  const answerer = humanNamed(db, by);
  if (answerer === undefined) {
    throw new ApprovalError(
      `${JSON.stringify(by)} is not a human worker, and an approval may not be answered on a person's behalf.`,
    );
  }

  const offered = optionsOf(row.options);
  if (offered !== null && !offered.includes(answer)) {
    throw new ApprovalError(`approval #${id} offers ${offered.join(", ")}; ${JSON.stringify(answer)} is not one of them`);
  }

  return transact(db, () => {
    queries(db).update(assignments).set({ answer, answered_by: by }).where("id", "=", id).run();

    for (const verb of ["answer", "finish"] as const) {
      const moved = engine.apply("assignment", id, verb, by);
      if (!moved.ok) throw new ApprovalError(`approval #${id} could not be ${verb}ed: ${moved.why}`);
    }

    const after = rowOf(db, id);
    if (after === null) throw new ApprovalError(`approval #${id} was answered and could not be read back`);
    return shape(after);
  });
}
