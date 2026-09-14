import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentDatabase, delivered as query, open } from "@wecode/core";

/** `wecode delivered [--all] [--project N] [--json]` — what wecode can already do.
 *
 *  One block per delivered story, newest first, with the statements of its accepted
 *  criteria beneath it. The statements rather than the titles, because the question this
 *  answers is "has this already been built" — epic 105 held thirteen stories later work had
 *  already done, and story 148 duplicated 147, because the only way to read the tree as
 *  capabilities was to walk it by hand. */
export function delivered(args: readonly string[]): number {
  const { values } = parseArgs({
    args: [...args],
    options: { all: { type: "boolean" }, project: { type: "string" }, json: { type: "boolean" } },
  });

  const path = currentDatabase();
  if (!existsSync(path)) {
    return fail(`no wecode workspace at ${path}.\n  wecode onboard   to set this project up`);
  }
  const db = open(path);

  // Standing in a repository, the question is about this project. Outside every one of
  // them there is no "here", and the answer is the workspace's.
  const here = db.prepare("SELECT id FROM project WHERE repo = ?").get(resolve(process.cwd())) as
    | { id: number }
    | undefined;
  const asked = values.project === undefined ? here?.id ?? null : Number(values.project);
  const chosen = values.all === true ? null : asked;
  if (chosen !== null && !Number.isInteger(chosen)) return fail("wecode delivered --project <id>");

  const stories = query(db, chosen);

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(stories, null, 2)}\n`);
    return 0;
  }

  if (stories.length === 0) {
    process.stdout.write("\nnothing delivered yet.\n");
    return 0;
  }

  const out: string[] = [""];
  for (const s of stories) {
    // Landed or not is the first thing on the line: a delivered story that is not on the
    // base is the one somebody has to act on.
    out.push(`#${s.id} ${s.title}  ·  ${s.landed ? `landed ${s.branch} ${short(s.sha)}` : "unlanded"}`);
    if (s.criteria.length === 0) out.push("    (no accepted criteria)");
    for (const c of s.criteria) out.push(`    ${c.statement}`);
    out.push("");
  }
  out.push(`${stories.length} delivered`);
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

const short = (sha: string | null): string => (sha === null ? "" : sha.slice(0, 8));

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}
