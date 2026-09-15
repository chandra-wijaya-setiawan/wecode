import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Where wecode keeps workspaces. One directory per workspace, one database in each. */
export function wecodeHome(): string {
  return process.env["WECODE_HOME"] ?? join(homedir(), ".wecode");
}

export function workspaceDir(name: string): string {
  return join(wecodeHome(), "workspaces", name);
}

export function databaseOf(name: string): string {
  return join(workspaceDir(name), "wecode.db");
}

/** A repository says which workspace it belongs to, in one line. The database is not in the
 *  repository: projects share a workspace so that one board, and one attention budget,
 *  cover everything a person has in flight. */
const POINTER = ".wecode/workspace";

export function writePointer(repo: string, workspace: string): void {
  const path = join(repo, POINTER);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${workspace}\n`);
}

export function readPointer(repo: string): string | null {
  const path = join(repo, POINTER);
  if (!existsSync(path)) return null;
  const name = readFileSync(path, "utf8").trim();
  return name === "" ? null : name;
}

function workspacesRoot(): string {
  return join(wecodeHome(), "workspaces");
}

/** The name of the workspace an explicit database belongs to, when it is one of ours.
 *  WECODE_DB may name a database anywhere, and one outside the home has no name. */
function workspaceOfDatabase(path: string): string | null {
  const name = basename(dirname(path));
  return databaseOf(name) === path ? name : null;
}

/** Which workspace a command is talking to, when somebody said. In order of how explicit
 *  it is: an explicit database, an explicit name, then this repository's pointer. Null is
 *  "nobody said" — the caller decides whether that means the default or a question, and
 *  `listWorkspaces` does not invent a row for a name nobody asked for.
 *
 *  The explicit database comes first because it is what `currentDatabase` returns: reading
 *  the name from a lower rank than the path it has to agree with is how `wecode workspaces`
 *  came to star a row the commands were not writing to. */
export function namedWorkspace(cwd: string = process.cwd()): string | null {
  const explicit = process.env["WECODE_DB"];
  const fromPath = explicit === undefined ? null : workspaceOfDatabase(resolve(explicit));
  return fromPath ?? process.env["WECODE_WORKSPACE"] ?? readPointer(cwd) ?? null;
}

/** Which workspace a command is talking to. The one place this is decided. */
export function currentWorkspace(cwd: string = process.cwd()): string {
  return namedWorkspace(cwd) ?? "default";
}

/** Every workspace that exists, and the one that was asked for whether it exists or not.
 *  Used to say which ones there are when the one asked for is not among them — so leaving
 *  the asked-for one out is how a list can disagree with the workspace in use. */
export function listWorkspaces(cwd: string = process.cwd()): readonly string[] {
  const root = workspacesRoot();
  const existing = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "wecode.db")))
        .map((e) => e.name)
    : [];
  const named = namedWorkspace(cwd);
  if (named !== null && !existing.includes(named)) existing.push(named);
  return existing.sort();
}

export function currentDatabase(cwd: string = process.cwd()): string {
  const explicit = process.env["WECODE_DB"];
  if (explicit !== undefined) return resolve(explicit);
  return databaseOf(currentWorkspace(cwd));
}
