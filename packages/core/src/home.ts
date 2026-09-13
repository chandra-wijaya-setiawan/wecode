import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

/** Which workspace a command is talking to, in order of how explicit it is:
 *  an explicit database, an explicit name, this repository's pointer, then the default. */
export function currentWorkspace(cwd: string = process.cwd()): string {
  return process.env["WECODE_WORKSPACE"] ?? readPointer(cwd) ?? "default";
}

export function currentDatabase(cwd: string = process.cwd()): string {
  const explicit = process.env["WECODE_DB"];
  if (explicit !== undefined) return resolve(explicit);
  return databaseOf(currentWorkspace(cwd));
}
