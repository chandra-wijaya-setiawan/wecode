import { describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { run } from "../../src/run.js";
import * as work from "../../src/verbs/work.js";
import { cried, freshCli, out, said } from "./harness.js";

freshCli();

/** The five rungs that are the work itself live in `verbs/work.ts`, one exported function
 *  each, and `create` is the dispatch that calls them. Proved from both ends, as the tree
 *  verbs are: the module answers when called directly with a `Work`, and the command an
 *  operator types reaches the same function and writes the same row. */
describe("the work verbs", () => {
  const maker = (): Maker => new Maker(open(process.env["WECODE_DB"] as string));

  const job = (parent: number, text: string, over: Partial<work.Work> = {}): work.Work => ({
    make: maker(),
    text,
    parent: () => parent,
    kind: "script",
    artefact: "bash x.sh",
    role: "engineer",
    ...over,
  });

  /** Everything above a requirement, so there is something for one to hang off. */
  const upToAStory = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    run(["release", "create", "--parent", "1", "1.0.0"]);
    run(["epic", "create", "--parent", "1", "recovery"]);
    run(["story", "create", "--parent", "1", "password reset"]);
  };

  it("exports one function per work rung", () => {
    expect(Object.keys(work).sort())
      .toEqual(["acceptanceCriteria", "acceptanceTest", "requirement", "task", "taskTest"]);
  });

  it("makes each rung under the one above it", () => {
    upToAStory();
    expect(work.requirement(job(1, "one change per link"))).toBe(1);
    expect(work.acceptanceCriteria(job(1, "emailed in 60s"))).toBe(1);
    expect(work.acceptanceTest(job(1, "mail arrives"))).toBe(1);
    expect(work.task(job(1, "send the mail"))).toBe(1);
    expect(work.taskTest(job(1, "mailer called"))).toBe(1);
  });

  it("asks every one of the five for a parent, because all five hang", () => {
    upToAStory();
    const absent = (): number => {
      throw new Error("asked for a parent");
    };
    for (const make of [work.requirement, work.acceptanceCriteria, work.acceptanceTest, work.task, work.taskTest]) {
      expect(() => make(job(0, "x", { parent: absent }))).toThrow("asked for a parent");
    }
  });

  it("carries --kind and --artefact to the two tests", () => {
    upToAStory();
    work.requirement(job(1, "one change per link"));
    work.acceptanceCriteria(job(1, "emailed in 60s"));
    work.acceptanceTest(job(1, "mail arrives", { kind: "judged", artefact: null }));
    work.task(job(1, "send the mail"));
    work.taskTest(job(1, "mailer called", { artefact: "vitest run" }));
    const db = open(process.env["WECODE_DB"] as string);
    expect(db.prepare("SELECT kind, artefact FROM acceptance_test WHERE id = 1").get())
      .toMatchObject({ kind: "judged", artefact: null });
    expect(db.prepare("SELECT kind, artefact FROM task_test WHERE id = 1").get())
      .toMatchObject({ kind: "script", artefact: "vitest run" });
    db.close();
  });

  it("carries --role to the task, which is the only one that has one", () => {
    upToAStory();
    work.requirement(job(1, "one change per link"));
    work.acceptanceCriteria(job(1, "emailed in 60s"));
    work.acceptanceTest(job(1, "mail arrives"));
    work.task(job(1, "send the mail", { role: "reviewer" }));
    const db = open(process.env["WECODE_DB"] as string);
    expect((db.prepare("SELECT role FROM task WHERE id = 1").get() as { role: string }).role).toBe("reviewer");
    db.close();
  });

  it("is what `wecode <entity> create` dispatches to, and says what it joined", () => {
    upToAStory();
    for (const [entity, text, extra] of [
      ["requirement", "one change per link", []],
      ["acceptance_criteria", "emailed in 60s", []],
      ["acceptance_test", "mail arrives", ["--artefact", "bash x.sh"]],
      ["task", "send the mail", ["--role", "engineer"]],
      ["task_test", "mailer called", ["--artefact", "vitest run"]],
    ] as const) {
      out.length = 0;
      expect(run([entity, "create", "--parent", "1", text, ...extra])).toBe(0);
      expect(said()).toContain(`${entity} #1`);
    }
    expect(said()).toContain("under task #1");
  });

  it("refuses a work rung with no --parent, by naming the flag", () => {
    upToAStory();
    expect(run(["requirement", "create", "one change per link"])).toBe(1);
    expect(cried()).toContain('wecode requirement create --parent <id> "<text>"');
  });
});
