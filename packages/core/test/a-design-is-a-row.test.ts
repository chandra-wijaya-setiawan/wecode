import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ROW_FIELDS, Repo, guards } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** A design is the mockup a person signed, kept as a row rather than as a conversation.
 *
 *  Two questions can then be asked of it and refused: does it name a picture, and did a
 *  person sign it. Both read the stored row and only the stored row — no file is stat'd
 *  and no clock is read, because a guard is evaluated wherever a verb is applied. */

const T = "2026-09-20T00:00:00.000Z";

let db: DatabaseSync;
let story: number;

const addDesign = (fields: Partial<{ mockup: string; signed_by: string | null; state: string }> = {}): number => {
  db.prepare(
    "INSERT INTO design (slug,story_id,title,mockup,signed_by,signed_at,state,created_at,updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "reset-screen",
    story,
    "the password reset screen",
    fields.mockup ?? "docs/design/mockups/reset.md",
    fields.signed_by ?? null,
    fields.signed_by === undefined || fields.signed_by === null ? null : T,
    fields.state ?? "planned",
    T,
    T,
  );
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const addWorker = (name: string, kind: string): void => {
  db.prepare("INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(
    name,
    name,
    "engineer",
    kind,
    T,
    T,
  );
};

const guard = (name: "mockup_resolves" | "signature_is_a_persons", id: number) =>
  guards(new Repo(db))[name]({ entity: "design", id });

beforeEach(() => {
  db = freshDb();
  story = seed(db).story;
});

describe("the design row", () => {
  it("is in the migrated schema, with the columns its interface declares", () => {
    const columns = (db.prepare("SELECT name FROM pragma_table_info('design')").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect([...columns].sort()).toEqual([...ROW_FIELDS["design"] ?? []].sort());
  });

  it("hangs off a story, and refuses one that does not exist", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO design (slug,story_id,title,mockup,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run("orphan", story + 999, "a screen for no story", "mock.md", "planned", T, T),
    ).toThrow();
  });

  it("is unsigned until somebody signs it", () => {
    const id = addDesign();
    expect(db.prepare("SELECT signed_by, signed_at FROM design WHERE id = ?").get(id)).toEqual({
      signed_by: null,
      signed_at: null,
    });
  });

  it("keeps one design per slug per story, so a second draft is a revision and not a rival", () => {
    addDesign();
    expect(() => addDesign()).toThrow();
  });
});

describe("mockup_resolves", () => {
  it("allows a design that names a picture", () => {
    expect(guard("mockup_resolves", addDesign())).toEqual({ ok: true });
  });

  it("refuses a design whose mockup is blank, and names the design", () => {
    const r = guard("mockup_resolves", addDesign({ mockup: "   " }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("reset-screen");
    expect(r.ok === false && r.why).toContain("nothing to look at");
  });

  it("refuses a design nobody has recorded", () => {
    expect(guard("mockup_resolves", 404)).toEqual({ ok: false, why: "no design #404" });
  });

  it("is not asked of anything else, so a test's artefact cannot answer for a picture", () => {
    const r = guards(new Repo(db)).mockup_resolves({ entity: "acceptance_test", id: 1 });
    expect(r).toEqual({ ok: false, why: "acceptance_test names no mockup" });
  });
});

describe("signature_is_a_persons", () => {
  it("allows a design a person signed", () => {
    addWorker("dana", "human");
    expect(guard("signature_is_a_persons", addDesign({ signed_by: "dana" }))).toEqual({ ok: true });
  });

  it("refuses an unsigned design, and says what to record", () => {
    const r = guard("signature_is_a_persons", addDesign());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("is unsigned");
    expect(r.ok === false && r.why).toContain("the password reset screen");
  });

  /** Capability parity, never authority parity: an agent may draw the mockup and may not
   *  be the one who approved it. */
  it("refuses a signature an agent gave", () => {
    addWorker("scribe", "agent");
    const r = guard("signature_is_a_persons", addDesign({ signed_by: "scribe" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("authority is not relayed");
  });

  it("refuses a name nobody has registered, rather than trusting it", () => {
    const r = guard("signature_is_a_persons", addDesign({ signed_by: "someone" }));
    expect(r).toEqual({ ok: false, why: "someone is not a registered worker — nobody by that name can have signed" });
  });

  it("treats whitespace as no signature at all", () => {
    const r = guard("signature_is_a_persons", addDesign({ signed_by: "  " }));
    expect(r.ok === false && r.why).toContain("is unsigned");
  });
});
