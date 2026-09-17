import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { currentDatabase, delivered as query, open, type DeliveredStory } from "@wecode/core";
// The dialect is not on core's barrel — `index.ts` re-exports the modules built over it,
// not the layer itself — so it is reached at its own path.
import { queries, table } from "@wecode/core/dist/db.js";
// The ancestry question is git's, and the cli already owns a read-only way to ask it.
import { ancestryOf, type Git } from "./doctor.js";

/** The one column this command reads for itself: which project the directory it was run in
 *  belongs to. Declared rather than spelled as SQL so the compiler checks it. */
const project = table<{ id: number; repo: string }>("project", ["id", "repo"]);

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
  const here = queries(db).selectFrom(project).select(["id", "repo"]).where("repo", "=", resolve(process.cwd())).get();
  const asked = values.project === undefined ? here?.id ?? null : Number(values.project);
  const chosen = values.all === true ? null : asked;
  if (chosen !== null && !Number.isInteger(chosen)) return fail("wecode delivered --project <id>");

  const stories = query(db, chosen).map(asTheBaseHasIt(gitIn(repoOf(db, chosen) ?? here?.repo ?? resolve(process.cwd()))));

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

/** The repository the answer is about: the project that was asked for, when one was. */
function repoOf(db: DatabaseSync, chosen: number | null): string | undefined {
  if (chosen === null) return undefined;
  return queries(db).selectFrom(project).select(["repo"]).where("id", "=", chosen).get()?.repo;
}

/** git, read-only, in one repository. A directory that is not a repository is not an error
 *  here: every ancestry question it is asked answers `no-branch`, and the record is what
 *  the answer falls back to. */
const gitIn =
  (cwd: string): Git =>
  (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Landed, as the base branch has it rather than as `landed_branch` has it.
 *
 *  `landed_branch` is a marker the runner writes on the one path that merges; a story that
 *  reached the base inside somebody else's merge, or before that path existed, has no row
 *  and reads unlanded while its code is sitting in master. The base itself cannot be wrong
 *  about this, so the branch's ancestry is the answer and the marker is only the sha to
 *  print.
 *
 *  A branch nobody can resolve — deleted after the merge, or never pushed — is the one case
 *  ancestry has nothing to say about, and there the record is kept as it stands. */
const asTheBaseHasIt = (git: Git): ((s: DeliveredStory) => DeliveredStory) => {
  const ancestry = ancestryOf(git, "HEAD");
  return (s) => {
    const reached = ancestry(s.branch);
    if (reached === "no-branch") return s;
    if (reached === "out") {
      return s.landed ? { ...s, landed: false, sha: null, reach: "unlanded" } : s;
    }
    return { ...s, landed: true, sha: s.sha ?? tipOf(git, s.branch), reach: "landed", owed: null, why: null };
  };
};

/** The sha to print for a branch the base already has, when no marker recorded one. */
function tipOf(git: Git, branch: string): string | null {
  try {
    return git(["rev-parse", branch]).trim();
  } catch {
    return null;
  }
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}
