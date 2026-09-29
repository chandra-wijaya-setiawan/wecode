/** The two commands that do not answer until something happens.
 *
 *  `watch` never returns; `wait` returns when one record settles. Every other verb in the
 *  cli answers out of the state the database is already in, which is why these two sit
 *  together and away from them: they are the only ones that hold the process open.
 *
 *  They are lent the same `At` the entity verbs are — the workspace database, how a refusal
 *  is said, and who is asking — so nothing here decides where the workspace is. */
import { parseArgs } from "node:util";
import { loadMachines, STATEFUL, type StatefulEntity } from "@wecode/core";
// The typed query layer is not on `@wecode/core`'s index, so it is reached by its own path.
import { queries } from "@wecode/core/dist/db.js";
import { ENTITIES, ledger, projectOf, type At } from "./entity.js";

const isStateful = (s: string): s is StatefulEntity => (STATEFUL as readonly string[]).includes(s);

/** `wecode watch [--project N] [--json]` — one line per state change, forever.
 *
 *  Read off the ledger, which is append-only, so this is a query with a cursor rather than
 *  an event bus. An orchestrator that wants to be told instead of asking runs this in the
 *  background and reads lines. */
export function watch(at: At, args: readonly string[]): number {
  const { values } = parseArgs({
    args: [...args],
    options: {
      project: { type: "string" },
      json: { type: "boolean" },
      since: { type: "string" },
      once: { type: "boolean" },
    },
  });
  const q = queries(at.conn());
  const narrow = values.project === undefined ? null : Number(values.project);

  // The dialect has no `max(id)` and no LIMIT, so the ledger's high-water mark is the
  // largest of the ids it hands back. Only the id column crosses.
  let cursor =
    values.since === undefined
      ? q.selectFrom(ledger).select(["id"]).all().reduce((n, r) => Math.max(n, r.id), 0)
      : Number(values.since);

  const tick = (): void => {
    // Nor an ORDER BY: the ledger is append-only and read by id, so the ordering the lines
    // are printed in is done here rather than in SQL.
    const rows = q
      .selectFrom(ledger)
      .where("id", ">", cursor)
      .all()
      .sort((a, b) => a.id - b.id);

    for (const r of rows) {
      cursor = r.id;
      if (narrow !== null && projectOf(at, r.entity, r.entity_id)?.id !== narrow) continue;
      process.stdout.write(
        values.json === true
          ? `${JSON.stringify(r)}\n`
          : `${r.at}  ${r.entity} #${r.entity_id}  ${r.from_state} → ${r.to_state}  ${r.verb} by ${r.actor}\n`,
      );
    }
  };

  tick();
  if (values.once === true) return 0;

  const timer = setInterval(tick, 1000);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      clearInterval(timer);
      process.exit(0);
    });
  }
  return 0;
}

/** `wecode wait <entity> <id> [--timeout <seconds>]` — block until it settles, then exit.
 *
 *  The exit code is the answer: 0 if it reached a state the work wanted, 1 if it did not.
 *  A harness that can run a command in the background gets a notification for free — the
 *  command finishing *is* the notification. */
export function wait(at: At, args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { timeout: { type: "string" }, quiet: { type: "boolean" } },
  });
  const [entity, raw] = positionals;
  const id = Number(raw);
  if (entity === undefined || !Number.isInteger(id)) return at.fail("wecode wait <entity> <id>");
  if (!isStateful(entity)) return at.fail(`${entity} has no states to wait on`);

  const good: Readonly<Record<string, readonly string[]>> = {
    project: ["dropped"],
    release: ["released"],
    epic: ["delivered"],
    story: ["delivered"],
    requirement: ["met"],
    acceptance_criteria: ["accepted"],
    acceptance_test: ["passed"],
    task_test: ["passed"],
    task: ["done"],
    assignment: ["succeeded"],
  };
  const machine = loadMachines()[entity];
  const settled = new Set([...machine.terminal, ...(good[entity] ?? [])]);

  // Which column holds the state is the entity's business, not this command's: it used to
  // be `entity === "assignment" ? "phase" : "state"` spliced into the SQL beside the table
  // name, and both are now the entity's own typed read.
  const read = ENTITIES[entity]?.state;
  if (read === undefined || read === null) return at.fail(`${entity} has no states to wait on`);

  const q = queries(at.conn());
  const deadline = values.timeout === undefined ? null : Date.now() + Number(values.timeout) * 1000;

  const look = (): string | null => read(q, id);

  if (look() === null) return at.fail(`no ${entity} #${id}`);

  // Blocking on purpose, and synchronously: the command exists to not return until the
  // answer is known, and run() is not async. Atomics.wait is the one sleep that parks the
  // thread rather than the event loop.
  const park = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const state = look();
    if (state !== null && settled.has(state)) {
      if (values.quiet !== true) process.stdout.write(`${entity} #${id} ${state}\n`);
      return (good[entity] ?? []).includes(state) ? 0 : 1;
    }
    if (deadline !== null && Date.now() > deadline) {
      return at.fail(`${entity} #${id} is still ${state ?? "gone"} after ${values.timeout}s`) + 1;
    }
    Atomics.wait(park, 0, 0, 1000);
  }
}
