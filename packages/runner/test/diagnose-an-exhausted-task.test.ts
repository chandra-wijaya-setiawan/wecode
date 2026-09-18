import { describe, expect, it } from "vitest";
import { blamed, diagnose, diagnoseAttempt, inScope, type Attempt } from "../src/diagnose.js";

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  commit: "abc1234",
  output: "",
  scope: ["packages/runner/src/foreman.ts"],
  base: { sha: "0000000deadbeef", carries: [] },
  ...over,
});

describe("an attempt against a tree that was never built", () => {
  it("is the toolchain, not the work, and the remedy is the build", () => {
    const d = diagnoseAttempt(
      attempt({
        output: "Error: Cannot find package '@wecode/core' imported from outline-scope.test.ts",
      }),
    );

    expect(d.cause).toBe("unbuilt-tree");
    expect(d.remedy).toContain("pnpm install");
    expect(d.evidence[0]).toContain("Cannot find package");
  });

  it("is read before anything else, because it makes every other signal a lie", () => {
    // Out of scope AND unresolved: the paths mean nothing until the tree resolves.
    const d = diagnoseAttempt(
      attempt({
        output: "Cannot find module '../src/index.js' required by packages/core/test/root-holds-no-strays.test.ts",
      }),
    );

    expect(d.cause).toBe("unbuilt-tree");
  });
});

describe("an attempt whose work the base already carries", () => {
  it("is named as landed elsewhere, and the remedy is not a retry", () => {
    const d = diagnoseAttempt(
      attempt({
        commit: null,
        scope: ["packages/runner/src/foreman.ts"],
        base: { sha: "67a6314aaaaaaa", carries: ["packages/runner/src/foreman.ts"] },
      }),
    );

    expect(d.cause).toBe("already-landed");
    expect(d.why).toContain("67a6314");
    expect(d.remedy).not.toContain("retry");
    expect(d.evidence).toEqual(["packages/runner/src/foreman.ts"]);
  });

  it("needs the whole scope carried — one file of two is work still owed", () => {
    const d = diagnoseAttempt(
      attempt({
        scope: ["packages/runner/src/foreman.ts", "packages/runner/src/ports.ts"],
        base: { sha: "67a6314aaaaaaa", carries: ["packages/runner/src/foreman.ts"] },
        output: "FAIL packages/runner/test/foreman.test.ts",
      }),
    );

    expect(d.cause).not.toBe("already-landed");
  });
});

describe("an attempt whose failure is outside its write scope", () => {
  const redElsewhere = attempt({
    scope: ["packages/tui/src/outline.tsx", "packages/tui/test/**"],
    output: [
      "FAIL packages/core/test/root-holds-no-strays.test.ts > the root holds no stray modules",
      "AssertionError: expected [ 'mail.ts' ] to deep equal []",
    ].join("\n"),
  });

  it("says no attempt under this scope can go green", () => {
    const d = diagnoseAttempt(redElsewhere);

    expect(d.cause).toBe("out-of-scope");
    expect(d.why).toContain("packages/core/test/root-holds-no-strays.test.ts");
    expect(d.why).toContain("no attempt under this scope can go green");
  });

  it("asks for work scoped to the failing file instead of a retry", () => {
    const d = diagnoseAttempt(redElsewhere);

    expect(d.remedy).toContain("packages/core/test/root-holds-no-strays.test.ts");
    expect(d.remedy).toContain("do not retry");
  });

  it("names every file it read the cause off, and only those", () => {
    const d = diagnoseAttempt(redElsewhere);

    expect(d.evidence).toEqual(["packages/core/test/root-holds-no-strays.test.ts", "mail.ts"]);
  });

  it("is not claimed when the scope does reach what failed", () => {
    const d = diagnoseAttempt(
      attempt({
        scope: ["packages/tui/src/outline.tsx", "packages/tui/test/**"],
        output: "FAIL packages/tui/test/outline-connectors.test.ts > draws the connector",
      }),
    );

    expect(d.cause).toBe("not-yet-right");
    expect(d.evidence).toEqual(["packages/tui/test/outline-connectors.test.ts"]);
  });

  it("is not claimed when only some of the failing files are outside — that work is still owed", () => {
    const d = diagnoseAttempt(
      attempt({
        scope: ["packages/tui/src/outline.tsx"],
        output: "FAIL packages/tui/src/outline.tsx\nFAIL packages/core/test/root-holds-no-strays.test.ts",
      }),
    );

    expect(d.cause).toBe("not-yet-right");
  });
});

describe("an attempt that left nothing", () => {
  it("is not read as a failure of the work", () => {
    const d = diagnoseAttempt(attempt({ commit: null, output: "   \n" }));

    expect(d.cause).toBe("nothing-written");
    expect(d.remedy).toContain("read the session");
  });

  it("is not claimed for an attempt that committed in silence", () => {
    expect(diagnoseAttempt(attempt({ commit: "82530aa", output: "" })).cause).toBe("not-yet-right");
  });
});

describe("the honest answer", () => {
  it("is the only cause whose remedy is the retry verb", () => {
    const d = diagnoseAttempt(attempt({ output: "FAIL packages/runner/src/foreman.ts > places the tree" }));

    expect(d.cause).toBe("not-yet-right");
    expect(d.remedy).toContain("wecode task retry");
  });
});

describe("every attempt a task used, classified as one thing", () => {
  it("says so when the same cause holds for all of them", () => {
    const outside = attempt({
      scope: ["packages/tui/src/outline.tsx"],
      output: "FAIL packages/core/test/root-holds-no-strays.test.ts",
    });

    const d = diagnose([outside, outside, outside]);

    expect(d.cause).toBe("out-of-scope");
    expect(d.why).toContain("3 attempts, each with the same cause");
  });

  it("takes the last attempt when the causes differ — it ran against what the others left", () => {
    const d = diagnose([
      attempt({ output: "Cannot find package '@wecode/core'" }),
      attempt({ output: "FAIL packages/runner/src/foreman.ts > places the tree" }),
    ]);

    expect(d.cause).toBe("not-yet-right");
    expect(d.why).not.toContain("each with the same cause");
  });

  it("does not claim repetition from a single attempt", () => {
    const d = diagnose([attempt({ output: "FAIL packages/runner/src/foreman.ts" })]);

    expect(d.why).not.toContain("attempts, each");
  });

  it("reads a task at its limit with no attempts as drift in the record", () => {
    const d = diagnose([]);

    expect(d.cause).toBe("nothing-written");
    expect(d.why).toContain("no attempt on the record");
  });
});

describe("the scope match", () => {
  it("treats a trailing /** as a prefix and anything else as the file", () => {
    expect(inScope("packages/tui/test/outline.test.ts", ["packages/tui/test/**"])).toBe(true);
    expect(inScope("packages/tui/src/outline.tsx", ["packages/tui/test/**"])).toBe(false);
    expect(inScope("mail.ts", ["mail.ts"])).toBe(true);
  });

  it("matches the whole path, so root mail.ts is not packages/core/src/mail.ts", () => {
    expect(inScope("packages/core/src/mail.ts", ["mail.ts"])).toBe(false);
    expect(inScope("mail.ts", ["packages/core/src/mail.ts"])).toBe(false);
  });
});

describe("the files an output blames", () => {
  it("are every path-shaped token, once each, in the order they were named", () => {
    expect(blamed("FAIL a/b.test.ts\n  at a/b.test.ts:12\n  from ./c.yaml")).toEqual(["a/b.test.ts", "c.yaml"]);
  });

  it("are empty for an output that names no file", () => {
    expect(blamed("the worker refused: no free slots")).toEqual([]);
  });
});
