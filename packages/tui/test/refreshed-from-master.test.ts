/** This story's branch was refreshed: master was taken into it by hand, because the two had
 *  independently grown the same services box and would not merge on their own. A green suite
 *  proves nothing about that on its own — it was green before the refresh too. So the base is
 *  asserted directly, and then the resolution is asserted, because both conflicts could have
 *  been ended by silently dropping a side.
 *
 *  The ancestry is checked against the commit master pointed at when the merge was made, not
 *  against wherever master has since moved to. This test asks whether the base was taken in,
 *  not whether the branch is still level with something other work keeps advancing. */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadServices } from "../src/services.js";

/** master at the moment of the refresh — "land story/a-merge-chore-is-raised-only-for…". */
const MASTER = "ac5dcf6";

const at = (ref: string): string =>
  execFileSync("git", ["show", ref], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

describe("master was merged into this branch", () => {
  it("is an ancestor of the commit under test", () => {
    const base = execFileSync("git", ["rev-parse", MASTER], { encoding: "utf8" }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const merged = execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim();
    expect(merged).toBe(base);
  });

  it("left no conflict marker anywhere in the tree", () => {
    // git grep exits 1 when it finds nothing, which is the answer this test wants.
    let hits = "";
    try {
      hits = execFileSync("git", ["grep", "-l", "-e", "^<<<<<<< ", "-e", "^>>>>>>> ", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      hits = "";
    }
    expect(hits).toBe("");
  });

  /** The services box was the conflict. master's is the one that landed and keeps its words
   *  in views.yaml; this branch's third attempt spelled them into the .tsx. Taking master's
   *  side is only correct if master's side is the configured one, so that is what is asked. */
  it("kept master's services box, the one whose words are configuration", () => {
    const src = at("HEAD:packages/tui/src/services.tsx");
    expect(src).toContain("export function loadServices");
    expect(src).toContain("busy_phases");
    expect(src).not.toContain('const DOCTOR = "0.0.2"');
    const cfg = loadServices();
    expect(cfg.title).toBe("Services");
    expect(cfg.busyPhases).toEqual(["pending", "running", "waiting"]);
    expect(cfg.doctor.version).toBe("0.0.2");
  });

  it("wires the dashboard to that config rather than to a literal", () => {
    const src = at("HEAD:packages/tui/src/screens.tsx");
    expect(src).toContain("loadServices");
    expect(src).toContain("title={SERVICES.title}");
    expect(src).toContain("config={SERVICES}");
  });

  /** The other side of the resolution: master's screens test counted borders, this branch's
   *  asks for each region by name and was the stronger of the two. It survived, and it now
   *  takes the services title from views.yaml rather than repeating it. A later master ruled
   *  the sections off instead of boxing them in, so the chrome it names is a rule; the shape
   *  of the assertion — one named region at a time, named from config — is what is kept. */
  it("kept this branch's per-region chrome assertion, sourced from views.yaml", () => {
    const src = at("HEAD:packages/tui/test/screens.test.ts");
    expect(src).toContain("const services = loadServices();");
    expect(src).toContain("for (const title of [services.title,");
    expect(src).toContain("has no rule");
  });

  /** And the work this story is actually about, which a merge is very able to lose. */
  it("kept this branch's own cockpit work", () => {
    // The row contract: a code, a state, a description, decided in one place.
    expect(at("HEAD:packages/tui/src/list.tsx")).toContain(
      'export const COLUMNS = ["code", "state", "description"] as const;',
    );
    // The box that was `roadmap` says `open`, and says it from end to end.
    expect(at("HEAD:packages/core/src/board.ts")).toContain("readonly open: readonly Row[];");
    const views = at("HEAD:packages/tui/config/views.yaml");
    expect(views).toContain("filter: open");
    expect(views).not.toContain("roadmap");
  });
});
