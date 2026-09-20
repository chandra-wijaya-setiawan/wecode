import { describe, expect, it } from "vitest";
import {
  foreignLanding,
  landedElsewhere,
  landedElsewhereNote,
  markLandedElsewhere,
  refuseForeignLand,
  saidLandedElsewhere,
  type LandingPlace,
} from "../src/land.js";
import { deliveredStoryHasLanded, landingSkipped, storiesToLand, type RecordNode, type Snapshot } from "../src/index.js";

/** Not every story a workspace tracks lands in the repository the workspace sits in. The
 *  change is made in a downstream repo, a vendored copy, a fork somebody else owns — and
 *  until there was a way to say so, such a story was delivered forever with no `landed_sha`:
 *  accused of never having reached the base, and offered to the lander every tick, which
 *  refused it every tick because `story/<slug>` is not here.
 *
 *  These are pure over the record: no git, no clock, no filesystem. */

const story = (slug: string, landed_elsewhere: string | null = null, landed_sha: string | null = null): RecordNode => ({
  entity: "story",
  id: 1,
  slug,
  state: "delivered",
  parent_id: 1,
  landed_sha,
  landed_elsewhere,
});

const snapshot = (...nodes: RecordNode[]): Snapshot => ({ nodes, workers: [] });

const place: LandingPlace = {
  here: "/repo",
  branch: "story/import-the-schema",
  base: "master",
  trees: [{ path: "/repo", branch: "master" }],
};

describe("reading the marker", () => {
  it("reads a repository on its own when nobody recorded a commit", () => {
    expect(foreignLanding("acme-web")).toEqual({ repo: "acme-web", sha: null });
  });

  it("reads the repository and the commit it landed as", () => {
    expect(foreignLanding("acme-web@9f1c2b3a4d5e")).toEqual({ repo: "acme-web", sha: "9f1c2b3a4d5e" });
  });

  it("keeps an ssh remote whole rather than reading its user as the repository", () => {
    expect(foreignLanding("git@github.com:acme/web.git")).toEqual({
      repo: "git@github.com:acme/web.git",
      sha: null,
    });
  });

  it("is nothing for a story with no marker, an empty one, or one that is only spaces", () => {
    expect(foreignLanding(null)).toBeNull();
    expect(foreignLanding(undefined)).toBeNull();
    expect(foreignLanding("")).toBeNull();
    expect(foreignLanding("   ")).toBeNull();
    expect(landedElsewhere(null)).toBe(false);
    expect(landedElsewhere("acme-web")).toBe(true);
  });
});

describe("writing the marker", () => {
  it("writes the repository and the commit, and the ledger line that says both", () => {
    expect(markLandedElsewhere("acme-web", "9f1c2b3a4d5e6f70819293a4b5c6d7e8f9012345")).toEqual({
      marker: "acme-web@9f1c2b3a4d5e6f70819293a4b5c6d7e8f9012345",
      note: "landed in acme-web as 9f1c2b3a4d5e, not in this repository",
    });
  });

  it("writes the repository alone when the commit is not known", () => {
    expect(markLandedElsewhere("acme-web")).toEqual({
      marker: "acme-web",
      note: "landed in acme-web, not in this repository",
    });
  });

  it("writes a marker the reader reads back as what was written", () => {
    const { marker } = markLandedElsewhere(" acme-web ", " 9f1c2b3a4d5e ");
    expect(foreignLanding(marker)).toEqual({ repo: "acme-web", sha: "9f1c2b3a4d5e" });
  });

  it("never says landed without saying it was not here", () => {
    expect(saidLandedElsewhere({ repo: "acme-web", sha: null })).toContain("not in this repository");
  });
});

describe("what the record makes of such a story", () => {
  it("does not accuse it of never having reached the base", () => {
    expect(deliveredStoryHasLanded(snapshot(story("import-the-schema", "acme-web@9f1c2b3a4d5e")))).toEqual([]);
  });

  it("still accuses a delivered story that has no marker of either kind", () => {
    expect(deliveredStoryHasLanded(snapshot(story("import-the-schema")))).toHaveLength(1);
  });

  it("still accuses one whose marker is empty — nothing said is not a landing", () => {
    expect(deliveredStoryHasLanded(snapshot(story("import-the-schema", "  ")))).toHaveLength(1);
  });

  it("does not offer it to the lander, this tick or any other", () => {
    expect(storiesToLand(snapshot(story("import-the-schema", "acme-web")))).toEqual([]);
  });

  it("says where it went rather than passing it over in silence", () => {
    expect(landingSkipped(story("import-the-schema", "acme-web@9f1c2b3a4d5e"))).toBe(
      "landed in acme-web as 9f1c2b3a4d5e, not in this repository",
    );
    expect(landedElsewhereNote("acme-web@9f1c2b3a4d5e")).toBe("landed in acme-web as 9f1c2b3a4d5e, not in this repository");
    expect(landedElsewhereNote(null)).toBeNull();
  });

  it("never calls it already in the base — no base of ours holds it", () => {
    expect(landingSkipped(story("import-the-schema", "acme-web"))).not.toContain("already in the base");
  });

  it("prefers the local commit when the record somehow holds both", () => {
    expect(landingSkipped(story("import-the-schema", "acme-web", "abcdef1234567890"))).toBe(
      "already in the base as abcdef123456",
    );
  });

  it("leaves a story that has not been delivered alone", () => {
    const open = { ...story("import-the-schema", "acme-web"), state: "in_progress" };
    expect(landingSkipped(open)).toBe("in_progress, and only a delivered story lands");
  });
});

describe("landing one here by hand", () => {
  it("refuses, naming the repository it went to and the commit there", () => {
    const said = refuseForeignLand(place, "acme-web@9f1c2b3a4d5e");
    expect(said).toContain("land story/import-the-schema refused in /repo");
    expect(said).toContain("landed in acme-web as 9f1c2b3a4d5e, not in this repository");
    expect(said).toContain("nothing here to merge into master");
    expect(said).toContain("clear it, then land again");
  });

  it("is quiet about a story with no such marker — the tree rules decide that one", () => {
    expect(refuseForeignLand(place, null)).toBeNull();
    expect(refuseForeignLand(place, "")).toBeNull();
  });
});
