/** Why a task used every attempt, read off what the attempts left behind.
 *
 *  `wecode task retry` is an operator's verb because the machine cannot know whether a
 *  fourth attempt would fix anything (docs/design/19). That stays true — this changes what
 *  the operator is handed. Today an exhausted task says "3 of 3 attempts used" and nothing
 *  else, and the cost of that is on the record: one branch burned seven attempts on three
 *  different stories against a red test in a file no scope contained, and the answer every
 *  time was a story scoped to that file rather than another attempt.
 *
 *  So this classifies, and changes nothing. Four facts go in — the commit an attempt left,
 *  the output it ended with, the write scope it was allowed, and the base it ran against —
 *  and one cause comes out, with the evidence for it and the verb that clears it. A cause
 *  wecode cannot tell from the evidence is `not-yet-right`: the honest answer, which is
 *  also the only one where a retry is the obvious move. */

/** What the base branch already has, as of the commit the attempt was cut from. `carries`
 *  is the subset of the task's write scope the base already implements — a landed version
 *  of the same work, wherever it landed from. */
export interface Base {
  readonly sha: string;
  readonly carries: readonly string[];
}

/** One attempt, as four facts. Nothing here is a judgement: every field is something the
 *  runner already recorded or could read back with git. */
export interface Attempt {
  /** The sha `commitAttempt` left, or null when the attempt wrote nothing. */
  readonly commit: string | null;
  /** What the attempt ended with — the test run, the refusal, the harness error. */
  readonly output: string;
  /** The write scope the attempt was held to. A trailing `/**` is a prefix. */
  readonly scope: readonly string[];
  readonly base: Base;
}

export type Cause =
  /** The failure is the toolchain, not the code: nothing was built or installed. */
  | "unbuilt-tree"
  /** The base already carries the work. The attempt was spent re-doing a landed change. */
  | "already-landed"
  /** Every file the output blames is outside the write scope. No attempt under this scope
   *  can go green, however many are left. */
  | "out-of-scope"
  /** The attempt ended with no commit and nothing to read. */
  | "nothing-written"
  /** The work was attempted, in scope, against a built tree, and is not right yet. */
  | "not-yet-right";

export interface Diagnosis {
  readonly cause: Cause;
  readonly why: string;
  /** What clears it. A retry only appears here for `not-yet-right`. */
  readonly remedy: string;
  /** The lines or paths the cause was read off. Quoted, so the operator can disagree with
   *  the classification without having to go and find the evidence first. */
  readonly evidence: readonly string[];
}

/** A module resolution failure names a package, not a mistake — `Cannot find package
 *  '@wecode/core'` is what an uninstalled worktree says about perfectly good code, and an
 *  attempt that reads it as a real failure spends its whole budget on it. */
const UNBUILT = [/Cannot find package/, /Cannot find module/, /ERR_MODULE_NOT_FOUND/];

/** Anything path-shaped in the output. Deliberately loose: the point is which files the
 *  failure names, and a path named in a stack trace counts as much as one in an assertion. */
const PATH = /[\w@./-]*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|yaml|yml|md|json|sql)\b/g;

const clean = (path: string): string => path.replace(/^\.\//, "");

/** Whether a path is one the attempt was allowed to write. `a/b/**` is a prefix; anything
 *  else is the file itself. A scope entry is matched against the whole path, so `mail.ts`
 *  at the root is not `packages/core/src/mail.ts`. */
export function inScope(path: string, scope: readonly string[]): boolean {
  const file = clean(path);
  return scope.some((entry) => {
    const pattern = clean(entry);
    if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
    return file === pattern;
  });
}

/** The files the output blames, deduplicated and in the order they were named. */
export function blamed(output: string): readonly string[] {
  const seen = new Set<string>();
  for (const match of output.match(PATH) ?? []) seen.add(clean(match));
  return [...seen];
}

const quote = (output: string, pattern: RegExp): readonly string[] =>
  output
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => line.trim())
    .slice(0, 2);

/** One attempt, classified. The order the causes are tried in is the whole content of the
 *  classification, so it is spelled out rather than left to fall out of the code:
 *
 *  1. an unbuilt tree first, because it makes every other signal a lie;
 *  2. then a base that already carries the work, because the attempt was never needed;
 *  3. then a scope that cannot reach what failed, because no retry can fix it;
 *  4. then an attempt that wrote nothing at all;
 *  5. and only then the code itself. */
export function diagnoseAttempt(attempt: Attempt): Diagnosis {
  const { commit, output, scope, base } = attempt;

  const unbuilt = UNBUILT.find((pattern) => pattern.test(output));
  if (unbuilt !== undefined) {
    return {
      cause: "unbuilt-tree",
      why: "the tree was never installed or built, so the failure is the toolchain rather than the work",
      remedy: "pnpm install && pnpm -r build in the worktree, then attempt it again",
      evidence: quote(output, unbuilt),
    };
  }

  const carried = base.carries.filter((path) => inScope(path, scope));
  if (scope.length > 0 && carried.length === scope.length) {
    return {
      cause: "already-landed",
      why: `the base at ${base.sha.slice(0, 7)} already carries every file in the scope — the work landed elsewhere`,
      remedy: "close the task against the landed change rather than attempting it again",
      evidence: carried,
    };
  }

  const named = blamed(output);
  const outside = named.filter((path) => !inScope(path, scope));
  if (named.length > 0 && outside.length === named.length) {
    return {
      cause: "out-of-scope",
      why: `the failure is in ${outside.join(", ")}, which the write scope does not contain — no attempt under this scope can go green`,
      remedy: `dispatch work scoped to ${outside[0] ?? "the failing file"}, and do not retry this task until it is done`,
      evidence: outside,
    };
  }

  if (commit === null && output.trim() === "") {
    return {
      cause: "nothing-written",
      why: "the attempt left no commit and said nothing — it did not get as far as the work",
      remedy: "read the session before retrying: an attempt that ends silent usually ended on the harness",
      evidence: [],
    };
  }

  return {
    cause: "not-yet-right",
    why: "the work was attempted in scope against a built tree and is not right yet",
    remedy: 'wecode task retry <id> --reason "…", or drop it',
    evidence: named.filter((path) => inScope(path, scope)),
  };
}

/** Every attempt a task used, classified as one thing.
 *
 *  The last attempt is the one that matters — it ran against the record the others left —
 *  except where the same cause holds for all of them, which is the case worth saying out
 *  loud: three attempts on one out-of-scope file is not three failures, it is one, spent
 *  three times.
 *
 *  No attempts at all is `nothing-written`: a task at its limit having run nothing is
 *  drift in the record, not a failure of the work. */
export function diagnose(attempts: readonly Attempt[]): Diagnosis {
  const last = attempts.at(-1);
  if (last === undefined) {
    return {
      cause: "nothing-written",
      why: "the task is at its limit with no attempt on the record",
      remedy: "check the assignments for this task before retrying it",
      evidence: [],
    };
  }

  const all = attempts.map(diagnoseAttempt);
  const first = all[0];
  if (first === undefined) return diagnoseAttempt(last);
  const repeated = all.length > 1 && all.every((d) => d.cause === first.cause);
  const it = all.at(-1) ?? first;
  if (!repeated) return it;
  return { ...it, why: `${all.length} attempts, each with the same cause: ${it.why}` };
}
