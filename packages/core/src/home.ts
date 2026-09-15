import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const underTest = (): boolean =>
  process.env["VITEST"] !== undefined || process.env["NODE_ENV"] === "test";

/** The home a test run gets when it did not ask for one, made once and kept for the life of
 *  the process so that two reads of the current workspace agree on where it lives. */
let ownHome: string | null = null;

/** Removes the home this run made, if it made one. Registered on exit, and exported so a
 *  test can prove the sweep rather than wait for its own exit. */
export function sweepTempHome(): void {
  if (ownHome === null) return;
  rmSync(ownHome, { recursive: true, force: true });
  ownHome = null;
}

function temporaryHome(): string {
  if (ownHome === null) {
    ownHome = mkdtempSync(join(tmpdir(), "wecode-home-"));
    process.on("exit", sweepTempHome);
  }
  return ownHome;
}

/** Where wecode keeps workspaces. One directory per workspace, one database in each.
 *
 *  With WECODE_HOME unset a test run gets a home of its own under the system temp directory
 *  rather than the operator's `~/.wecode`. The fallback to the real home is what made this
 *  reader unsafe to call from a test: `store.open` refuses a live *database*, but nothing
 *  stopped `listWorkspaces` from reading the operator's workspace names, or `workspaceDir`
 *  from being made into a directory in the home a person is actually working in. */
export function wecodeHome(): string {
  const explicit = process.env["WECODE_HOME"];
  if (explicit !== undefined) return explicit;
  return underTest() ? temporaryHome() : join(homedir(), ".wecode");
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
  return askedWorkspace() ?? readPointer(cwd) ?? null;
}

/** The name somebody said *now*, on this command: an explicit database or an explicit name.
 *  Distinguished from the pointer because the two have different lifetimes. An environment
 *  variable is a person's live instruction, so a workspace it names is one they are about to
 *  create. A pointer is a file in the repository, written the day it was onboarded and often
 *  carried into another home entirely — by a clone, or by WECODE_HOME moving. */
function askedWorkspace(): string | null {
  const explicit = process.env["WECODE_DB"];
  const fromPath = explicit === undefined ? null : workspaceOfDatabase(resolve(explicit));
  return fromPath ?? process.env["WECODE_WORKSPACE"] ?? null;
}

/** Which workspace a command is talking to. The one place this is decided. */
export function currentWorkspace(cwd: string = process.cwd()): string {
  return namedWorkspace(cwd) ?? "default";
}

/** Every workspace this home holds, and the one somebody asked for on this command whether
 *  it exists yet or not. Used to say which ones there are when the one asked for is not
 *  among them — so leaving the asked-for one out is how a list can disagree with the
 *  workspace in use.
 *
 *  The repository's pointer is not an ask. It names a workspace in whatever home it was
 *  onboarded against, and pushing it here invented a row for a board this home does not
 *  hold: `wecode workspaces` listed a name with no database behind it, and `wecode onboard`
 *  offered `--workspace <that name>` as one of the existing ones to join. A pointer whose
 *  workspace this home does hold needs no pushing — it is already in the listing. So this takes
 *  no cwd: what the repository says cannot change the list. */
export function listWorkspaces(): readonly string[] {
  const root = workspacesRoot();
  const existing = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "wecode.db")))
        .map((e) => e.name)
    : [];
  const asked = askedWorkspace();
  if (asked !== null && !existing.includes(asked)) existing.push(asked);
  return existing.sort();
}

export function currentDatabase(cwd: string = process.cwd()): string {
  const explicit = process.env["WECODE_DB"];
  if (explicit !== undefined) return resolve(explicit);
  return databaseOf(currentWorkspace(cwd));
}
