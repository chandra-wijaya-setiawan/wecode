/** Master was merged into this story by hand. A green suite proves nothing on its own —
 *  it was green on either side before the merge too — so what is asserted here is the
 *  shape of the merge itself: both parents are behind HEAD, and neither side's half of
 *  the two conflicted files was dropped to make the conflict go away.
 *
 *  The two SHAs are the tips as they stood when the merge was made, not whatever the
 *  branches have moved on to since. This is about whether the merge happened, not about
 *  staying caught up with branches other work keeps advancing. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { OUTLINE } from "../src/outline.js";
import { loadServices } from "../src/services.js";

const MASTER = "86a57fb90305864570d5d776c26c46b680d0d52f";
const STORY = "bb5df4124122bd8601a858855087d65a9cd84750";

/** `--is-ancestor` says nothing and exits non-zero when it is not one, which throws. */
const behindHead = (sha: string): void => {
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "ignore" });
};

describe("master merged into the story", () => {
  for (const [what, sha] of [
    ["master", MASTER],
    ["the story's own work", STORY],
  ] as const) {
    it(`carries ${what}`, () => {
      expect(() => behindHead(sha)).not.toThrow();
    });
  }

  it("had to merge them: neither tip was already behind the other", () => {
    // If one had been, HEAD carrying both would be no evidence of a merge at all.
    expect(() => {
      execFileSync("git", ["merge-base", "--is-ancestor", MASTER, STORY], { stdio: "ignore" });
    }).toThrow();
    expect(() => {
      execFileSync("git", ["merge-base", "--is-ancestor", STORY, MASTER], { stdio: "ignore" });
    }).toThrow();
  });
});

/** views.yaml and screens.tsx were the two conflicts, and both were a block added by each
 *  side at the same place. Resolving by taking one side would have compiled and left the
 *  suite short a feature, so each side's block is named here. */
describe("neither side of the conflict was dropped", () => {
  const views = readFileSync(new URL("../config/views.yaml", import.meta.url), "utf8");

  it("keeps the outline master brought", () => {
    expect(views).toMatch(/^outline:/m);
    expect(OUTLINE.key).toBe("t");
    expect(OUTLINE.depth).toBe("story");
  });

  it("keeps the services box the story brought", () => {
    expect(views).toMatch(/^services:/m);
    const services = loadServices();
    expect(services.title).toBe("Services");
    expect(services.doctor.state).toBe("not built");
  });

  it("draws both, from the one screens module", () => {
    const screens = readFileSync(new URL("../src/screens.tsx", import.meta.url), "utf8");
    expect(screens).toContain('from "./outline.js"');
    expect(screens).toContain('from "./services.js"');
    expect(screens).not.toMatch(/^<{7}|^={7}$|^>{7}/m);
  });
});
