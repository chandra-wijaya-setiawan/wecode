import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { currentDatabase } from "@wecode/core";
import { inspect, type Broken } from "@wecode/core/dist/invariants.js";

/** `wecode doctor` — one pass of the invariants, read only.
 *
 *  docs/design/19, first slice: it reads and reports. Nothing is healed, nothing is written
 *  to any entity, nothing is proposed for approval. The database is opened read-only so
 *  that is true by construction rather than by care — in particular it is never migrated,
 *  because a doctor that upgraded the file it was inspecting would repair the one drift it
 *  is meant to report.
 *
 *  Non-zero when anything is broken, so a script can gate on it. */
export function doctor(args: readonly string[]): number {
  const path = args[0] ?? currentDatabase();
  if (!existsSync(path)) {
    process.stderr.write(`no workspace at ${path} — wecode init\n`);
    return 1;
  }

  const db = new DatabaseSync(path, { readOnly: true });
  let broken: readonly Broken[];
  try {
    broken = inspect(db);
  } finally {
    db.close();
  }

  // A record that holds says nothing at all. A doctor that printed "all well" would be
  // noise on every tick of the thing that runs it.
  if (broken.length === 0) return 0;

  process.stdout.write(report(broken));
  return 1;
}

/** Grouped by invariant, because the invariant is the sentence that was broken and the
 *  entities are the evidence for it. Ungrouped, the same drift on forty rows reads as
 *  forty problems. */
function report(broken: readonly Broken[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const { invariant, violations } of broken) {
    total += violations.length;
    lines.push(`${invariant.name}: ${invariant.says}`);
    for (const v of violations) lines.push(`  ${v.entity} #${v.id} — ${v.detail}`);
    lines.push("");
  }
  const what = total === 1 ? "1 entity" : `${total} entities`;
  const how = broken.length === 1 ? "1 invariant" : `${broken.length} invariants`;
  lines.push(`${what} breaking ${how}\n`);
  return lines.join("\n");
}
