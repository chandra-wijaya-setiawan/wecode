import { describe, expect, it } from "vitest";
import {
  OverBudget,
  UnknownFile,
  UnknownSymbol,
  isOverBudget,
  withBudget,
  type Purpose,
  type Reading,
  type RepoIndex,
  type Use,
} from "../src/index.js";

/** A slow run is not a regression.
 *
 *  Reading a repository costs whatever the machine has left, so the question that answers
 *  in a second on an idle laptop can still be parsing ten seconds later under load. A
 *  caller that gives it a budget and then reports the overrun as a failure has said
 *  something false about the repository — that the index is broken, that the file is
 *  unreadable — when all that happened is that the machine was busy.
 *
 *  So these cases hold the budget to one distinction: an over-budget run reports as over
 *  budget, and a failure still reports as itself. Nothing here parses anything. The index
 *  below is a stub whose every question takes exactly as long as the case tells it to,
 *  because the thing under test is the budget, and a suite that proved it by waiting on a
 *  real parser would be the very flake it exists to prevent. */

const READING: Reading = { file: "a.ts", defines: [], imports: [] };
const PURPOSE: Purpose = { file: "a.ts", doc: null, exports: [], dependents: [] };
const USES: readonly Use[] = [{ file: "b.ts", line: 3, column: 7 }];

/** An index that settles every question the same way after `afterMs`. */
const stub = (afterMs: number, settle: "answer" | (() => Error)): RepoIndex => {
  const after = <T>(answer: T): Promise<T> =>
    new Promise((resolve, reject) => {
      // Unref'd: a run still pending when its case ends must not hold the suite open.
      setTimeout(
        () => (settle === "answer" ? resolve(answer) : reject(settle())),
        afterMs,
      ).unref?.();
    });
  return {
    root: "/repo",
    read: () => after(READING),
    usesOf: () => after(USES),
    purposeOf: () => after(PURPOSE),
  };
};

/** Small enough that the suite is quick, large enough that a scheduling hiccup on the
 *  answering side does not read as an overrun. */
const BUDGET = 200;
/** Longer than any budget here, so a run given this one never finishes in time. */
const FOREVER = 60_000;

describe("a run that stays inside its budget", () => {
  it("answers every question exactly as the index would have", async () => {
    const index = withBudget(stub(0, "answer"), BUDGET);

    expect(index.root).toBe("/repo");
    await expect(index.read("a.ts")).resolves.toEqual(READING);
    await expect(index.usesOf("a.ts", "greet")).resolves.toEqual(USES);
    await expect(index.purposeOf("a.ts")).resolves.toEqual(PURPOSE);
  });
});

describe("a run that outlives its budget", () => {
  it("reports as over budget, naming the question, the file and the cost", async () => {
    const index = withBudget(stub(FOREVER, "answer"), BUDGET);

    const reason = await index.read("slow.ts").then(
      () => null,
      (error: unknown) => error,
    );

    expect(reason).toBeInstanceOf(OverBudget);
    expect(isOverBudget(reason)).toBe(true);
    const over = reason as OverBudget;
    expect(over.name).toBe("OverBudget");
    expect(over.question).toBe("read");
    expect(over.file).toBe("slow.ts");
    expect(over.budgetMs).toBe(BUDGET);
    expect(over.spentMs).toBeGreaterThanOrEqual(BUDGET);
    expect(over.message).toContain("over budget");
  });

  it("names whichever question ran out of time", async () => {
    const index = withBudget(stub(FOREVER, "answer"), BUDGET);

    const asked = async (run: Promise<unknown>) =>
      await run.then(
        () => null,
        (error: unknown) => (error as OverBudget).question,
      );

    expect(await asked(index.usesOf("slow.ts", "greet"))).toBe("usesOf");
    expect(await asked(index.purposeOf("slow.ts"))).toBe("purposeOf");
  });

  it("is not the failure the index would have reported later", async () => {
    const index = withBudget(
      stub(FOREVER, () => new UnknownFile("slow.ts", "/repo")),
      BUDGET,
    );

    await expect(index.read("slow.ts")).rejects.toBeInstanceOf(OverBudget);
    await expect(index.read("slow.ts")).rejects.not.toBeInstanceOf(UnknownFile);
  });
});

describe("a run that fails inside its budget", () => {
  it("fails as itself, because a repository it cannot answer about is not a cost", async () => {
    const unknownFile = withBudget(
      stub(0, () => new UnknownFile("gone.ts", "/repo")),
      BUDGET,
    );
    const unknownSymbol = withBudget(
      stub(0, () => new UnknownSymbol("a.ts", "greet")),
      BUDGET,
    );

    await expect(unknownFile.read("gone.ts")).rejects.toBeInstanceOf(UnknownFile);
    await expect(unknownSymbol.usesOf("a.ts", "greet")).rejects.toBeInstanceOf(UnknownSymbol);

    const reason = await unknownFile.purposeOf("gone.ts").then(
      () => null,
      (error: unknown) => error,
    );
    expect(isOverBudget(reason)).toBe(false);
  });
});

describe("the budget itself", () => {
  it("refuses one that bounds nothing", () => {
    expect(() => withBudget(stub(0, "answer"), 0)).toThrow(RangeError);
    expect(() => withBudget(stub(0, "answer"), -1)).toThrow(RangeError);
    expect(() => withBudget(stub(0, "answer"), Number.NaN)).toThrow(RangeError);
    expect(() => withBudget(stub(0, "answer"), Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
