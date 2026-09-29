/** The orchestrator's skill is the one source of truth about the job, and its order is the
 *  message.
 *
 *  It used to open with a guard, then hand the reader to the binary — "the binary is the
 *  manual", "this file exists only to tell you the binary is there" — and then list verbs.
 *  A session that reads that knows how to type `wecode task create` and not what it is for,
 *  so the operator ends up supplying the procedure: which verb next, which step was missed,
 *  what the thing even is. The file now answers all of it, in the order a reader needs it.
 *
 *  Three things are held here, and they are orderings rather than wordings, because any
 *  rewrite may move the prose but must not move the shape:
 *
 *  - the worker guard is still first, before every other word of the body, because a
 *    runner-started session must stop reading and nothing may get in front of that;
 *  - wecode is named — said plainly, in three sentences — before the first verb, so no
 *    reader learns the commands before the thing;
 *  - the orchestrator's role and its standing duties come before the rules, because the
 *    role is the point and the rules only bound it. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../config/orchestrator-skill.md", import.meta.url));

/** The text under the front matter. The front matter is Claude Code's, and it names wecode
 *  in its own `name:` field, which would make the "before any verb" question trivial. */
const body = (): string => readFileSync(SOURCE, "utf8").split(/^---$/m)[2] as string;

const GUARD = "**If a wecode runner started you, stop reading here.** You were spawned with `claude -p`";
const WHAT = "## What wecode is";
const ROLE = "## The orchestrator's role";
const RULES = "## The hard rules, in priority order";

/** Where a heading starts, insisting it is there at all: `indexOf` answers -1 for a heading
 *  that was renamed, and -1 sorts before everything, so an ordering test on a missing
 *  heading would pass. */
const at = (heading: string): number => {
  const found = body().indexOf(heading);
  expect(found, `${heading} is not in the file`).toBeGreaterThan(-1);
  return found;
};

/** One section: its heading, and everything up to the next one. */
const section = (heading: string): string => {
  const rest = body().slice(at(heading) + heading.length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
};

/** The verbs of the CLI, as `wecode --help` lists them. A word here is the machine being
 *  operated; a word not here (`wecode runner`, "wecode is a local CLI") is prose. */
const VERBS = new Set([
  "onboard", "init", "board", "workspaces", "plan", "land", "ask", "answer", "show", "tree",
  "watch", "wait", "doctor", "delivered", "lessons", "lesson", "explore", "paint", "create",
  "scope", "start", "deliver", "restate", "artefact", "worker", "task", "task_test", "story",
  "requirement", "acceptance_test", "acceptance_criteria", "epic", "release",
]);

/** Where the file first tells the reader to type something. */
const firstVerb = (): { verb: string; index: number } => {
  for (const hit of body().matchAll(/\bwecode(?:-runner|-tui)?[ \t]+(?:--)?([a-z_<]+)/g)) {
    const verb = (hit[1] as string).replace(/^</, "");
    if (VERBS.has(verb) || verb === "entity" || verb === "test") {
      return { verb, index: hit.index };
    }
  }
  expect.fail("the file names no verb at all; it is meant to carry the procedure");
};

describe("the worker guard is first", () => {
  it("is the body's opening line, word for word", () => {
    expect(body().trim().split("\n")[0]).toBe(GUARD);
  });

  it("puts nothing in front of it — the body opens on the guard and nothing else", () => {
    expect(body().trimStart().startsWith(GUARD)).toBe(true);
  });

  it("tells that reader to stop before it tells them anything they could act on", () => {
    const guard = body().trimStart().slice(0, at(WHAT) - body().indexOf(GUARD));

    expect(guard).toContain("stop reading here");
    expect(guard).toContain("none of it applies to you");
    expect(guard).toContain("The rest of this file is the orchestrator's");
  });

  it("comes before every other part of the job", () => {
    expect(body().indexOf(GUARD)).toBeLessThan(at(WHAT));
    expect(at(WHAT)).toBeLessThan(at(ROLE));
    expect(at(ROLE)).toBeLessThan(at(RULES));
  });
});

describe("wecode is named before any verb", () => {
  it("says what wecode is before the first command it asks anyone to run", () => {
    expect(at(WHAT)).toBeLessThan(firstVerb().index);
  });

  it("finishes saying it before that command, too", () => {
    const ends = at(WHAT) + WHAT.length + section(WHAT).length;

    expect(ends).toBeLessThan(firstVerb().index);
  });

  it("says it in three sentences", () => {
    expect(section(WHAT).split(/(?<=\.)\s+/)).toHaveLength(3);
  });

  it("says the three things that make it what it is: records, scoped agents, tests judging", () => {
    const said = section(WHAT);

    expect(said).toMatch(/records/);
    expect(said).toMatch(/scope that agent cannot leave/);
    expect(said).toMatch(/a task is done when its tests pass/);
  });

  it("names the verbs somewhere, since a source of truth carries the procedure", () => {
    expect(VERBS.has(firstVerb().verb) || firstVerb().verb === "entity" || firstVerb().verb === "test").toBe(true);
  });
});

describe("the role comes before the rules", () => {
  it("states the orchestrator's role ahead of anything that binds it", () => {
    expect(at(ROLE)).toBeLessThan(at(RULES));
  });

  it("opens the role by saying the orchestrator leads", () => {
    expect(section(ROLE).split("\n")[0]).toContain("You lead");
  });

  it("gives the standing duties, all six of them", () => {
    const duties = section(ROLE).split("\n").filter((line) => line.startsWith("- **"));

    expect(duties).toHaveLength(6);
  });

  it("names each duty the orchestrator holds whether or not it is asked", () => {
    const said = section(ROLE);

    expect(said).toMatch(/[Tt]urn what the operator wants into records/);
    expect(said).toMatch(/state the runner allocates from/);
    expect(said).toMatch(/[Kk]eep the queue fed/);
    expect(said).toMatch(/[Ll]and what is delivered/);
    expect(said).toMatch(/[Rr]aise an approval for anything that is the operator's to decide/);
    expect(said).toMatch(/[Rr]eport outcomes faithfully/);
  });

  it("refuses to make the operator supply the procedure", () => {
    expect(body()).toMatch(/never (require|ask) the operator to supply/);
  });

  it("no longer hands the reader to the binary in place of saying the job", () => {
    expect(body()).not.toContain("The binary is the manual");
    expect(body()).not.toContain("This file exists only to tell you the binary is there");
  });

  it("keeps the procedure the two forgotten steps live in", () => {
    expect(body()).toContain("wecode task_test deliver <task_test>");
    expect(body()).toContain("wecode task start <task>");
    expect(body()).toContain("a task needs a **ready** `task_test` before it may start");
  });
});

describe("the rules are ranked, not listed", () => {
  it("numbers them, so two of them colliding has an answer", () => {
    const numbers = section(RULES)
      .split("\n")
      .flatMap((line) => (/^\d+\. /.test(line) ? [Number(line.split(".")[0])] : []));

    expect(numbers.length).toBeGreaterThan(1);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers[0]).toBe(1);
  });

  it("says which one wins when they collide", () => {
    expect(section(RULES)).toMatch(/the earlier one wins/);
  });

  it("ranks not writing the code yourself first", () => {
    expect(section(RULES).split("\n").find((line) => line.startsWith("1. "))).toContain(
      "Never write the feature code yourself",
    );
  });

  it("still carries the rules that bite", () => {
    const said = section(RULES);

    expect(said).toMatch(/failing test/);
    expect(said).toMatch(/[Nn]othing is done because an agent said so/);
    expect(said).toMatch(/[Oo]ne task, one scope/);
  });
});
