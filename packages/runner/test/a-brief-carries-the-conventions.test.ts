/** Nothing used to tell a worker how this repository is built, so every one of them
 *  rediscovered it: that a fresh worktree has no node_modules, that a commit needs an
 *  inline identity, which command builds before which tests run. A lesson could not carry
 *  it — a lesson is what one attempt learned the hard way, and these are things the
 *  operator already knew and simply never said.
 *
 *  So they are configuration: a list of sentences in `packages/core/config/project.yaml`,
 *  owned by the people who run the repository rather than by any module. The foreman reads
 *  the list when it assembles a brief and hands it over under its own heading, immediately
 *  above the lessons, so the two are read together and told apart. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { addLesson, Maker, open } from "@wecode/core";
import {
  CONVENTIONS_CONFIG,
  CONVENTIONS_HEADING,
  Foreman,
  readConventions,
  withConventions,
  type Observation,
  type WorkerAdapter,
  type Work,
} from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Keeps every brief it was handed. */
class Fake implements WorkerAdapter {
  readonly kind = "agent";
  readonly work: Work[] = [];
  private seen(w: Work): Observation {
    this.work.push(w);
    return { phase: "running", session: "s", spent: { tokens: 1, seconds: 1 } };
  }
  async start(w: Work): Promise<Observation> {
    return this.seen(w);
  }
  async poll(w: Work): Promise<Observation> {
    return this.seen(w);
  }
  async resume(w: Work): Promise<Observation> {
    return this.seen(w);
  }
  async answer(w: Work): Promise<Observation> {
    return this.seen(w);
  }
  async kill(): Promise<void> {}
}

let db: DatabaseSync;
let make: Maker;
let project: number;
let task: number;
let worker: number;
let repo: string;

/** A repository root carrying the config the foreman is to read. */
const rootSaying = (yaml: string): string => {
  const root = tmp("wecode-conventions-repo-");
  mkdirSync(join(root, "packages", "core", "config"), { recursive: true });
  writeFileSync(join(root, CONVENTIONS_CONFIG), yaml);
  return root;
};

beforeEach(() => {
  db = open(join(tmp("wecode-conventions-"), "wecode.db"));
  make = new Maker(db);
  const workspace = make.workspace("acme", "/acme");
  project = make.project(workspace, "storefront", "/r");
  const epic = make.epic(make.release(project, "1.0.0"), "recovery");
  const story = make.story(epic, "password reset");
  const requirement = make.requirement(story, "one change per link");
  const acceptance = make.acceptanceTest(make.criteria(requirement, "emailed in 60s"), "mail arrives", "script", "true");
  task = make.task(acceptance, "send the mail", { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  worker = make.worker("claude-1", "engineer", "agent");
  repo = rootSaying(["ceiling: 400", "conventions:", "  - A worktree starts without node_modules.", "  - git has no user identity here.", "over:", "  a/long.ts: 900", ""].join("\n"));
});

/** One tick, against a repository root the test controls. */
const brief = async (root: string): Promise<Work> => {
  make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree: "/tmp/wecode-no-such-worktree",
  });
  const fake = new Fake();
  await new Foreman(db, { agent: fake }, 3600, { repoRoot: root, integrationBranch: "main" }).tick();
  const work = fake.work[0];
  if (work === undefined) throw new Error("the foreman handed over no work");
  return work;
};

describe("the conventions are configuration", () => {
  it("reads the sentences the operator wrote under `conventions:`", () => {
    expect(readConventions("ceiling: 400\nconventions:\n  - one.\n  - two.\nover:\n  a.ts: 9\n")).toEqual([
      "one.",
      "two.",
    ]);
  });

  it("stops at the next key, so nothing below the block leaks into the brief", () => {
    expect(readConventions("conventions:\n  - one.\nover:\n  - not a convention.\n")).toEqual(["one."]);
  });

  it("says nothing at all for a repository that declares none", () => {
    expect(readConventions("ceiling: 400\nover:\n  a.ts: 9\n")).toEqual([]);
  });

  /** The point of putting them in config: the operator changes what workers are told by
   *  editing a `.yaml`, not by opening a module and finding a string literal. This
   *  repository's own file is the one a worker here is handed, so it has to parse — and
   *  what it says has to be the thing every attempt kept rediscovering. */
  it("is declared by this repository, in the file the operator owns", () => {
    expect(CONVENTIONS_CONFIG).toBe(join("packages", "core", "config", "project.yaml"));
    const here = fileURLToPath(new URL("../../..", import.meta.url));
    const said = readConventions(readFileSync(join(here, CONVENTIONS_CONFIG), "utf8"));
    expect(said.length).toBeGreaterThan(0);
    expect(said.join("\n")).toContain("node_modules");
    expect(said.join("\n")).toContain("user.email");
  });

  /** The sentences are the operator's, not the module's: the foreman must hold none of
   *  them, or an edit to the config would be contradicted by a literal in the source. */
  it("is held nowhere in the module that reads it", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/foreman.ts", import.meta.url)), "utf8");
    const here = fileURLToPath(new URL("../../..", import.meta.url));
    for (const sentence of readConventions(readFileSync(join(here, CONVENTIONS_CONFIG), "utf8"))) {
      expect(source).not.toContain(sentence);
    }
  });
});

describe("a brief carries the conventions", () => {
  it("hands them to the worker under their own heading", async () => {
    const work = await brief(repo);
    expect(work.instruction).toContain(CONVENTIONS_HEADING);
    expect(work.instruction).toContain("- A worktree starts without node_modules.");
    expect(work.instruction).toContain("- git has no user identity here.");
  });

  it("still says what the work is, above the heading", async () => {
    const work = await brief(repo);
    expect(work.instruction.startsWith("send the mail")).toBe(true);
    expect(work.instruction.indexOf("send the mail")).toBeLessThan(work.instruction.indexOf(CONVENTIONS_HEADING));
  });

  it("adds no heading when the repository declares no conventions", async () => {
    const work = await brief(rootSaying("ceiling: 400\nover:\n  a.ts: 900\n"));
    expect(work.instruction).toBe("send the mail");
  });

  it("adds no heading when there is no config to read at all", async () => {
    const work = await brief(tmp("wecode-conventions-bare-"));
    expect(work.instruction).toBe("send the mail");
  });

  /** A convention is what the operator knew; a lesson is what an attempt learned. Both
   *  reach the worker, under separate headings, in that order — the standing rules first,
   *  then what went wrong last time. */
  it("stands beside the lessons rather than mixed into them", async () => {
    addLesson(db, project, "the tmp-leak test is flaky", null);
    const work = await brief(repo);
    expect(work.lessons).toEqual(["the tmp-leak test is flaky"]);
    // Every adapter renders the instruction, then the lessons under their own heading, so
    // conventions last in the instruction is conventions immediately above the lessons.
    expect(work.instruction.trimEnd().endsWith("- git has no user identity here.")).toBe(true);
    expect(work.instruction).not.toContain("the tmp-leak test is flaky");
  });
});

describe("the block itself", () => {
  it("is nothing when there is nothing to say", () => {
    expect(withConventions("do the thing", [])).toBe("do the thing");
  });

  it("is one bullet per sentence, under one heading", () => {
    expect(withConventions("do the thing", ["one.", "two."])).toBe(
      ["do the thing", "", CONVENTIONS_HEADING, "- one.", "- two."].join("\n"),
    );
  });
});
