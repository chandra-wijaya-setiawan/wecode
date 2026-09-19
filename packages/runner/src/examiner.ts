import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { Engine, Verbs, now, type Outcome } from "@wecode/core";
// Core's dialect, by the path core builds it to: it is deliberately not on core's barrel,
// and reaching it here widens nothing for anybody else. See the same note in doctor.ts.
import { excluded, queries, table, type Setters, type TableDef } from "@wecode/core/dist/db.js";

const exec = promisify(execFile);

/** A verdict the engine would not accept, in the engine's own words. The script's exit
 *  code is not the last word: a guard can refuse the transition it implies, and a refusal
 *  that is dropped on the floor reads as a pass that never happened. */
export interface Refused {
  readonly id: number;
  readonly why: string;
}

export interface ScriptReport {
  readonly passed: readonly number[];
  readonly failed: readonly number[];
  /** Tests whose verdict already stands against this exact tree. */
  readonly skipped: readonly number[];
  /** Tests whose script is not in this tree. Not a verdict: they stay as they were. */
  readonly unrunnable?: readonly number[];
  /** Tests whose script said one thing and the engine refused it. Never a pass. */
  readonly refused?: readonly Refused[];
  /** Tests that failed and then passed on the very same tree. Not a verdict either way. */
  readonly flaky?: readonly number[];
  /** Why the tree could not be made runnable, in the build's own words, or absent when it
   *  built. A tree that does not build proves nothing about the work in it — not even the
   *  verdicts already standing against it — so this is said on every report, including the
   *  one where there was no test left to run. Whoever would settle the task reads it here
   *  and refuses. */
  readonly unprepared?: string;
}

const nothing: ScriptReport = { passed: [], failed: [], skipped: [], unrunnable: [], refused: [], flaky: [] };

/** Written where the board reads a run's output, so a missing script never reads as a
 *  failure with an empty reason. */
export const NOT_IN_TREE = "unrunnable: its script is not in this tree";

/** Written where the board reads a run's output, ahead of what the script printed, so a
 *  transition the engine refused is read as a refusal rather than as a silent nothing. */
export const REFUSED = "refused";

/** Written where the board reads a run's output, ahead of what the script printed, so a
 *  command that selected nothing is read as a failure with a reason rather than as a pass. */
export const NO_TEST_MATCHED = "no test matched";

/** Written where the board reads a run's output when the tree could not be made runnable.
 *  A fresh worktree has no dependencies installed and nothing built, and a suite run in one
 *  dies on the first import — which is a fact about the tree, never about the work. */
export const UNPREPARED = "unrunnable: the tree could not be prepared";

/** Written where the board reads a run's output when the same command failed and then
 *  passed against the same unmoved tree. Two opposite answers from one tree are not a
 *  verdict on the work — the test is telling on itself — so it is said in those words
 *  rather than recorded as the red that happened to come first. */
export const FLAKY = "flaky: it failed and then passed on the same tree";

/** Where the command that makes a tree runnable is written, relative to the tree it
 *  prepares. It is the project's own onboarding config, so the person who owns the build
 *  changes the build without opening a `.ts`, and a tree with no `prepare:` is simply run
 *  as it stands. */
export const PROJECT_CONFIG = "config/project.yaml";

/** The command that prepares a tree before anything is proved in it, or null when the tree
 *  names none. Read off the tree being examined rather than off the runner's own checkout:
 *  a task_test runs in the attempt's worktree, and it is that worktree that must be built. */
export function prepareCommandOf(cwd: string): string | null {
  const command = projectConfig(cwd)["prepare"];
  return typeof command === "string" && command.trim() !== "" ? command : null;
}

/** The tree's own project config, or an empty one where there is none to read. An unreadable
 *  config is never a verdict: nothing is prepared and nothing is re-run, and the tests are
 *  judged exactly as they always were rather than going unrunnable over a typo. */
function projectConfig(cwd: string): Record<string, unknown> {
  const path = resolve(cwd, PROJECT_CONFIG);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Written where the board reads a run's output, ahead of what the script printed, so a
 *  proof that never reached the thing it claims is read as unproved rather than as a pass. */
export const ENTRY_HIDDEN = "unproved: it still passes with its entry point hidden";

/** Where a proof enters the code it proves. A screen proof that renders a component
 *  directly passes just as well when the file the app actually draws is gone, and such a
 *  proof says nothing about the screen. Which file each proof must enter by is a fact about
 *  the packaging, so it is declared in `config/project.yaml` and read from there. */
export interface Entry {
  /** What identifies the proof: any artefact whose command names this is checked. */
  readonly proof: string;
  /** The file the proof must be reached through, relative to the tree. */
  readonly file: string;
}

/** The `entry:` list of the tree being examined. A tree that declares none is judged on its
 *  exit codes alone, exactly as before. */
export function entriesOf(cwd: string): readonly Entry[] {
  const raw = projectConfig(cwd)["entry"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const { proof, file } = (e ?? {}) as Record<string, unknown>;
    return typeof proof === "string" && typeof file === "string" && proof !== "" && file !== ""
      ? [{ proof, file }]
      : [];
  });
}

/** The entry point an artefact must be reached through, or null when none is declared for
 *  it. Named rather than matched: a `proof` is a path the command carries, so the same
 *  declaration reads the same whichever runner the command drives. */
export function entryFor(artefact: string, entries: readonly Entry[]): Entry | null {
  return entries.find((e) => artefact.includes(e.proof)) ?? null;
}

/** What each runner prints when its selection came up empty. Exit code says nothing here:
 *  `vitest --passWithNoTests`, `jest --passWithNoTests`, `go test ./...` over a package with
 *  no `_test.go`, and `pytest` on an empty selection all exit 0, so a task_test whose path
 *  filter has gone stale reads as green forever. Only the banner distinguishes the two.
 *
 *  Anchored on the runner's own words, never on a count: "0 passing" is also what a suite
 *  prints while every test in it errors, and that is already a failure by its exit code. */
const NO_TESTS: readonly RegExp[] = [
  /\bno test files found\b/i, // vitest
  /\bno test(?: suite)?s found\b/i, // jest
  /\bno tests ran\b/i, // pytest
  /\bno tests to run\b/i, // go test
  /\[no test files\]/i, // go test ./...
  /\brunning 0 tests\b/i, // cargo test
];

/** True when a command's output says it selected no test at all. A run that matched nothing
 *  proves nothing, and the one thing it must never do is stand as a pass. */
export function matchedNoTest(output: string): boolean {
  return NO_TESTS.some((re) => re.test(output));
}

const INTERPRETERS = new Set(["bash", "sh", "zsh", "node", "python", "python3", "tsx", "deno"]);

/** The script file an artefact invokes, when it invokes one. `./scripts/x.sh --all` and
 *  `bash scripts/x.sh` both carry one; `test -f hello.ts` and `pnpm vitest` do not — they
 *  name no file whose absence would make the test unrunnable rather than failed. */
export function scriptPathOf(artefact: string): string | null {
  const words = artefact.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  // `bash -lc 'x'` and friends carry a program, not a path: only a bare argument counts.
  const head = words[0]!.replace(/^.*\//, "");
  const candidate = INTERPRETERS.has(head) ? words.slice(1).find((w) => !w.startsWith("-")) : words[0];
  if (candidate === undefined || candidate.startsWith("-")) return null;
  if (/[;&|><$`(){}*?"']/.test(candidate)) return null;
  const looksLikeAPath = candidate.includes("/") || /\.(sh|bash|ts|js|mjs|cjs|py)$/.test(candidate);
  return looksLikeAPath ? candidate : null;
}

/** What a verdict was reached against. A test that already passed or failed is only worth
 *  running again when one of these has moved. */
export interface RunAgainst {
  /** The attempt being judged. A retry writes in a fresh tree from the same branch tip, so
   *  without this a second attempt looks identical to the first. */
  readonly attempt?: number | string;
}

interface Row {
  readonly id: number;
  readonly artefact: string;
  readonly state: string;
}

/** Which table a test is in. The examiner does the same thing to both, which is why one
 *  row shape below covers them: a `task_test` and an `acceptance_test` are examined
 *  identically and differ only in what they prove. */
export type TestEntity = "task_test" | "acceptance_test";

/** The columns this module reads and writes on either test table. Both carry all of them,
 *  so one declaration serves both and `Record<TestEntity, TableDef<TestRow>>` is a lookup
 *  rather than a cast — the shape is the same, so nothing is being asserted away. */
interface TestRow {
  id: number;
  parent_id: number;
  kind: string;
  artefact: string | null;
  state: string;
  last_run_at: string | null;
  last_output: string | null;
  provenance_sha: string | null;
  updated_at: string;
}

const TEST_COLUMNS = [
  "id",
  "parent_id",
  "kind",
  "artefact",
  "state",
  "last_run_at",
  "last_output",
  "provenance_sha",
  "updated_at",
] as const;

const TESTS: Record<TestEntity, TableDef<TestRow>> = {
  task_test: table<TestRow>("task_test", TEST_COLUMNS),
  acceptance_test: table<TestRow>("acceptance_test", TEST_COLUMNS),
};

/** The two verdicts, one facade method each. The entity is a value here — chosen at run
 *  time from which table the row came out of — so the method is looked up rather than
 *  spelled, and the lookup is total over `TestEntity`: a third test table would not
 *  compile until it named its own pass and fail. */
const VERDICT: Record<TestEntity, Record<"pass" | "fail", (verbs: Verbs, id: number, actor: string) => Outcome>> = {
  task_test: {
    pass: (verbs, id, actor) => verbs.passTaskTest(id, actor),
    fail: (verbs, id, actor) => verbs.failTaskTest(id, actor),
  },
  acceptance_test: {
    pass: (verbs, id, actor) => verbs.passAcceptanceTest(id, actor),
    fail: (verbs, id, actor) => verbs.failAcceptanceTest(id, actor),
  },
};

const requirement = table<{ id: number; story_id: number }>("requirement", ["id", "story_id"]);
const criteria = table<{ id: number; requirement_id: number }>("acceptance_criteria", ["id", "requirement_id"]);
const task = table<{ id: number; acceptance_test_id: number; state: string }>("task", [
  "id",
  "acceptance_test_id",
  "state",
]);

interface ScriptRunRow {
  entity: string;
  test_id: number;
  fingerprint: string;
  ran_at: string;
}
const scriptRun = table<ScriptRunRow>("script_run", ["entity", "test_id", "fingerprint", "ran_at"]);

/** A test a pass may still reach a verdict on. `ready` has none yet and `failed` may be
 *  fixed; anything else is settled. */
const RUNNABLE: readonly string[] = ["ready", "failed"];

/** A task nobody is waiting on any more. The dialect spells no `IN`, and the set belonged
 *  here anyway: it is one rule, said once. */
const SETTLED: readonly string[] = ["done", "dropped"];

/** A deterministic test needs no agent: run the command, read the exit code, record the
 *  verdict. No session, no tokens, no scope to negotiate.
 *
 *  Where it runs is the whole of the correctness here. A task_test proves *one attempt*, so
 *  it runs in that attempt's worktree, before the tree is released. An acceptance_test
 *  proves a criteria, so it runs in the story tree, after the tasks have merged. The first
 *  live run ran both at the repository root and failed a test whose work was three
 *  directories away.
 *
 *  A verdict is also a fact about *what it was run against*. Without that, a failed
 *  acceptance test is re-run every tick — on 14 Sep two of them held a tick open for
 *  minutes each while eleven ready tasks waited, and the runner read as idle rather than
 *  hung. So each run records a fingerprint of the tree tip, the attempt and the artefact,
 *  and a standing verdict is left alone until one of the three moves. */
export class Examiner {
  /** The record's verbs, one method per transition. Not the engine: a verb spelled as a
   *  string is a transition the compiler cannot see, and this module's two are chosen at
   *  run time, which is exactly where a typo would survive to the tick. */
  private readonly verbs: Verbs;
  /** What preparing each tree came to, by tree and tip. Installing and building is the
   *  slowest thing this module does and the answer cannot change under an unmoved tip, so
   *  it is done once and remembered — including when it failed. */
  private readonly prepared = new Map<string, string | null>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {
    this.verbs = new Verbs(new Engine(db));
    // Runner-owned, beside the record rather than in it: the ledger says what is true of the
    // work, this says only what this machine has already done.
    db.exec(
      `CREATE TABLE IF NOT EXISTS script_run (
         entity      TEXT NOT NULL,
         test_id     INTEGER NOT NULL,
         fingerprint TEXT NOT NULL,
         ran_at      TEXT NOT NULL,
         PRIMARY KEY (entity, test_id)
       )`,
    );
  }

  /** The ready script task_tests of one task, in that task's attempt tree. */
  async runTaskTests(taskId: number, cwd: string, against: RunAgainst = {}): Promise<ScriptReport> {
    return this.runAll("task_test", this.runnable("task_test", (r) => r.parent_id === taskId), cwd, against);
  }

  /** Every acceptance_test whose tasks are all finished, in the story tree it belongs to. */
  async runAcceptanceTests(storyId: number, cwd: string, against: RunAgainst = {}): Promise<ScriptReport> {
    const q = queries(this.db);
    // The join and the NOT EXISTS, composed here: the dialect has neither, and both are set
    // membership once the rows are in hand.
    const requirements = new Set(q.selectFrom(requirement).select(["id"]).where("story_id", "=", storyId).all().map((r) => r.id));
    const mine = new Set(
      q
        .selectFrom(criteria)
        .all()
        .filter((c) => requirements.has(c.requirement_id))
        .map((c) => c.id),
    );
    const unfinished = new Set(
      q
        .selectFrom(task)
        .all()
        .filter((t) => !SETTLED.includes(t.state))
        .map((t) => t.acceptance_test_id),
    );
    const rows = this.runnable("acceptance_test", (r) => mine.has(r.parent_id) && !unfinished.has(r.id));
    return this.runAll("acceptance_test", rows, cwd, against);
  }

  /** The script tests of one table that this pass may still judge, narrowed by whose they
   *  are. `state IN (…)` and `artefact IS NOT NULL` are read off the rows rather than
   *  spelled in the query, and the id order is applied here because the dialect has none. */
  private runnable(entity: TestEntity, mine: (r: { id: number; parent_id: number }) => boolean): readonly Row[] {
    return queries(this.db)
      .selectFrom(TESTS[entity])
      .select(["id", "parent_id", "artefact", "state"])
      .where("kind", "=", "script")
      .all()
      .flatMap((r) =>
        r.artefact !== null && RUNNABLE.includes(r.state) && mine(r)
          ? [{ id: r.id, artefact: r.artefact, state: r.state }]
          : [],
      )
      .sort((a, b) => a.id - b.id);
  }

  /** Every write this module makes to a test row goes through here, so the table and the
   *  columns are checked against the same declaration the reads use. */
  private stamp(entity: TestEntity, id: number, sets: Setters<TestRow>): void {
    queries(this.db).update(TESTS[entity]).set(sets).where("id", "=", id).run();
  }

  private async runAll(
    entity: TestEntity,
    rows: readonly Row[],
    cwd: string,
    against: RunAgainst,
  ): Promise<ScriptReport> {
    const passed: number[] = [];
    const failed: number[] = [];
    const skipped: number[] = [];
    const unrunnable: number[] = [];
    const refused: Refused[] = [];
    const flaky: number[] = [];
    const tip = await this.tip(cwd);
    // The tree is made runnable before a word of it is proved. A suite that dies on a
    // missing dependency exits non-zero exactly as a broken one does, so without this the
    // first test in a fresh worktree fails for the tree it was handed.
    //
    // Asked before the "nothing left to run" shortcut, and not after: a task whose tests
    // have all passed already has no row here, and answering such a pass with a clean
    // report is how a broken tree gets settled as done.
    const unprepared = await this.readyTree(cwd, tip);
    if (unprepared !== null) {
      const at = now();
      for (const row of rows) {
        // No verdict, either way: an unbuilt tree proves nothing, so every test is left
        // exactly as it stands, with the build's own output as the reason.
        this.stamp(entity, row.id, { last_output: `${UNPREPARED}\n${unprepared}`, updated_at: at });
        unrunnable.push(row.id);
      }
      return { passed, failed, skipped, unrunnable, refused, flaky, unprepared };
    }
    if (rows.length === 0) return nothing;
    // Stamped beside every verdict this pass takes: what the test was run against, not just
    // when. A pass that cannot say which sources it proves is a pass nobody can check.
    const provenance = await this.treeSha(cwd);

    for (const row of rows) {
      const script = scriptPathOf(row.artefact);
      if (script !== null && !existsSync(isAbsolute(script) ? script : resolve(cwd, script))) {
        // No script, no evidence. A verdict here would say the code is broken when all that
        // is missing is the test itself, so the test is left exactly as it stands.
        const at = now();
        this.stamp(entity, row.id, { last_output: `${NOT_IN_TREE}: ${script}`, updated_at: at });
        unrunnable.push(row.id);
        continue;
      }
      const print = tip === null ? null : `${tip}|${against.attempt ?? ""}|${row.artefact}`;
      if (this.stands(entity, row, print)) {
        skipped.push(row.id);
        continue;
      }
      const out = await this.runOne(row.artefact, cwd);
      // A red that goes green on the second ask, with nothing between the two runs, is a
      // fact about the test and not about the tree. Recording it as a failure accuses work
      // that may be sound; recording it as a pass hides a test nobody can trust. So it is
      // left exactly as it stands, named for what it is, and asked again next tick.
      if (!out.ok && (await this.passesAlone(row.artefact, cwd))) {
        const at = now();
        this.stamp(entity, row.id, {
          last_output: `${FLAKY}: ${row.artefact}\n${out.output.slice(-8000)}`,
          updated_at: at,
        });
        flaky.push(row.id);
        continue;
      }
      // A command that exited 0 having selected no test proves nothing about the tree. The
      // exit code alone cannot tell that apart from a suite that ran and passed, so the
      // output is read too, and a run that matched nothing fails.
      const empty = out.ok && matchedNoTest(out.output);
      // A green run still proves nothing when it is green without the code it claims. Only
      // a pass is worth re-running: a failure is already no pass to refuse.
      const hidden = out.ok && !empty ? await this.unreached(row.artefact, cwd) : null;
      const ok = out.ok && !empty && hidden === null;
      const at = now();
      const body = out.output.slice(-8000);
      let reason = body;
      if (hidden !== null) reason = `${ENTRY_HIDDEN}: ${hidden}\n${body}`;
      else if (empty) reason = `${NO_TEST_MATCHED}: ${row.artefact}\n${body}`;
      this.stamp(entity, row.id, {
        last_run_at: at,
        last_output: reason,
        provenance_sha: provenance,
        updated_at: at,
      });
      if (print !== null) {
        queries(this.db)
          .insertInto(scriptRun, { entity, test_id: row.id, fingerprint: print, ran_at: at })
          .onConflict(["entity", "test_id"], {
            fingerprint: excluded<ScriptRunRow>("fingerprint"),
            ran_at: excluded<ScriptRunRow>("ran_at"),
          })
          .run();
      }
      const verdict = VERDICT[entity][ok ? "pass" : "fail"](this.verbs, row.id, "runner");
      if (!verdict.ok) {
        // The engine's words, not ours: it is the thing that knows why, and a paraphrase
        // here is one more copy of the rules to keep in agreement with them.
        refused.push({ id: row.id, why: verdict.why });
        this.stamp(entity, row.id, { last_output: `${REFUSED}: ${verdict.why}\n${body}`, updated_at: now() });
        continue;
      }
      (ok ? passed : failed).push(row.id);
    }

    return { passed, failed, skipped, unrunnable, refused, flaky };
  }

  /** True when a command that has just failed passes on being asked again, by itself,
   *  against the same tree. The one thing between the two runs is the first run, so a
   *  disagreement between them belongs to the test: order, a clock, a port, a leftover
   *  file. A second red — or a green that selected nothing — is no disagreement at all,
   *  and the failure stands. */
  private async passesAlone(artefact: string, cwd: string): Promise<boolean> {
    const again = await this.runOne(artefact, cwd);
    return again.ok && !matchedNoTest(again.output);
  }

  /** Makes a tree runnable, and answers with why it could not be — null when it is ready,
   *  whether that took a build or no command at all.
   *
   *  Not named for what it does, because `typed-runner-doctor` reads every runner module
   *  for a bare `prepare(` and means `db.prepare` by it. One name here is the cheaper of
   *  the two costs. */
  private async readyTree(cwd: string, tip: string | null): Promise<string | null> {
    const command = prepareCommandOf(cwd);
    if (command === null) return null;
    const key = `${cwd}|${tip ?? ""}|${command}`;
    const seen = this.prepared.get(key);
    if (seen !== undefined) return seen;
    const out = await this.runOne(command, cwd);
    const why = out.ok ? null : out.output.slice(-8000);
    this.prepared.set(key, why);
    return why;
  }

  /** The entry point a green run never went through, or null when the run is a proof.
   *
   *  The file is moved aside and the same command run again: a proof that enters by it dies
   *  without it, and one that passes anyway proved something other than what it claims. The
   *  file is put back whatever the run does, because an examined tree is still the tree the
   *  work is in.
   *
   *  A tree that declares no entry point for the artefact, and one whose declared file is
   *  not there, are both left alone — a stale line in a config is not a failing test. */
  private async unreached(artefact: string, cwd: string): Promise<string | null> {
    const entry = entryFor(artefact, entriesOf(cwd));
    if (entry === null) return null;
    const path = resolve(cwd, entry.file);
    if (!existsSync(path)) return null;
    const aside = `${path}.hidden-by-examiner`;
    renameSync(path, aside);
    try {
      const again = await this.runOne(artefact, cwd);
      return again.ok && !matchedNoTest(again.output) ? entry.file : null;
    } finally {
      renameSync(aside, path);
    }
  }

  /** True when this test already has a verdict reached against this exact fingerprint.
   *  A test still in `ready` has no verdict to stand on, and an unreadable tip is no proof
   *  of anything, so both run. */
  private stands(entity: TestEntity, row: Row, print: string | null): boolean {
    if (print === null || row.state === "ready") return false;
    const seen = queries(this.db)
      .selectFrom(scriptRun)
      .select(["fingerprint"])
      .where("entity", "=", entity)
      .where("test_id", "=", row.id)
      .get();
    return seen !== null && seen.fingerprint === print;
  }

  /** The git tree sha of the sources this run saw — `git rev-parse HEAD:.`. A commit sha
   *  names a history; a tree sha names the files, which is what a test proves something
   *  about, and two commits with the same sources deserve the same stamp. It asks git and
   *  nothing else, so it answers the same in any language and never consults a toolchain.
   *
   *  Asked as `HEAD:<prefix>` rather than as `HEAD:.`, because git refuses the `.` at the
   *  top of a checkout — "path '.' exists on disk, but not in 'HEAD'" — and a worktree is
   *  exactly that. `--show-prefix` is empty there and `sub/` below it, so one form answers
   *  in both places and still names the sources of the directory the test ran in.
   *
   *  Null where there is no git to ask, and a null stamp accuses nothing later. */
  private async treeSha(cwd: string): Promise<string | null> {
    try {
      const { stdout: prefix } = await exec("git", ["rev-parse", "--show-prefix"], { cwd });
      const { stdout } = await exec("git", ["rev-parse", `HEAD:${prefix.trim()}`], { cwd });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** The commit the tree is at, or null when there is no git here to ask. */
  private async tip(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async runOne(artefact: string, cwd: string): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec("bash", ["-lc", artefact], {
        cwd,
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, output: `${stdout}${stderr}` };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}` };
    }
  }
}
