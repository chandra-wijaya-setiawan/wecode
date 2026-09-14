import { relative } from "node:path";

/** An adapter that can say which writes the harness refused its session.
 *
 *  Optional, and structural rather than part of `WorkerAdapter`: a harness with no
 *  permission gate has no such observation to offer, and an adapter that cannot see one
 *  must not be made to pretend. The foreman asks whoever can answer — see
 *  `hasWriteDenials` — and records nothing for the rest.
 *
 *  Reading it empties it. The paths are news to be carried to the record once, not a
 *  running total the adapter keeps for the life of the process. */
export interface WriteDenials {
  /** Repo-relative paths this assignment has been refused since the last ask. */
  takeRefusedWrites(assignment: number): readonly string[];
}

export const hasWriteDenials = (v: unknown): v is WriteDenials =>
  typeof (v as WriteDenials | null)?.takeRefusedWrites === "function";

/** The tools whose refusal is a refusal to write. A denied `Bash` is a different complaint
 *  and has no path to record against it. */
const WRITERS = new Set(["write", "edit", "multiedit", "notebookedit"]);

/** The path a write tool was aimed at, whichever of the names the harness gives it. */
function pathOf(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = i[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/** Writes this event says were refused, repo-relative.
 *
 *  Two shapes carry it, and both are read because they arrive at different times. A denied
 *  tool call comes back as an error `tool_result` while the session is still going, which
 *  is why `pending` is kept across events: the result names the tool_use, and the path was
 *  on the tool_use. The final `result` event repeats the lot in `permission_denials`, which
 *  is the harness's own summary and needs no correlation.
 *
 *  `pending` is the caller's, mutated here: the correlation spans events, and a session
 *  is the only thing that knows where one stream ends. */
export function denialsIn(
  event: Record<string, unknown>,
  pending: Map<string, string>,
  worktree: string,
): string[] {
  const out: string[] = [];

  for (const d of asArray(event["permission_denials"])) {
    if (!WRITERS.has(nameOf(d))) continue;
    const path = pathOf(d["tool_input"]);
    if (path !== null) out.push(within(path, worktree));
  }

  const message = event["message"];
  for (const block of asArray(message === null || typeof message !== "object" ? null : (message as Record<string, unknown>)["content"])) {
    if (block["type"] === "tool_use") {
      const id = block["id"];
      const path = pathOf(block["input"]);
      if (typeof id === "string" && path !== null && WRITERS.has(nameOf(block))) pending.set(id, path);
      continue;
    }
    if (block["type"] !== "tool_result" || block["is_error"] !== true) continue;
    const id = block["tool_use_id"];
    if (typeof id !== "string") continue;
    const path = pending.get(id);
    if (path !== undefined && refusedByPermission(block["content"])) {
      pending.delete(id);
      out.push(within(path, worktree));
    }
  }

  return out;
}

/** A denied write, told apart from a write that failed for its own reasons. A missing
 *  directory is the agent's problem; a permission gate is the operator's decision, and
 *  recording the second as the first is how the board learned to say nothing. */
function refusedByPermission(content: unknown): boolean {
  const text =
    typeof content === "string"
      ? content
      : asArray(content)
          .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
          .join("\n");
  return /permission|not allowed|denied|outside .*scope|has not been granted/i.test(text);
}

const nameOf = (v: Record<string, unknown>): string =>
  typeof v["tool_name"] === "string"
    ? v["tool_name"].toLowerCase()
    : typeof v["name"] === "string"
      ? (v["name"] as string).toLowerCase()
      : "";

/** As the operator names it: what the scope is written in is repo-relative globs, and an
 *  absolute path under a worktree nobody keeps is unreadable beside them. A path outside
 *  the worktree is left as it is — that it is outside is the thing worth seeing. */
function within(path: string, worktree: string): string {
  if (worktree === "") return path;
  const rel = relative(worktree, path);
  return rel === "" || rel.startsWith("..") ? path : rel;
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    : [];
}
