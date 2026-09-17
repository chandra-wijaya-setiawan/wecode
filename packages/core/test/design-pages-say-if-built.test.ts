/** docs/design is read as inventory. A page that describes behaviour nobody has written yet
 *  reads exactly like a page that describes what shipped, so an agent plans around
 *  capabilities wecode does not have. The fix is one frontmatter key — `built` — and a
 *  ceiling on it: the page may not claim more than the epic it names has reached in the
 *  ledger.
 *
 *  Two halves, because only one of them can be hermetic:
 *    - every page carries a built state, and one above the floor cites an epic. Checked
 *      against the real pages.
 *    - the claim is capped by that epic's state. Checked against an epic table, so the
 *      ceiling is proven against the ledger's own states rather than a list of words.
 *  `wecodeHome` hands a test run a temp home on purpose, so no test can read the operator's
 *  workspace database — the cap over the *live* ledger belongs to a command, not to this. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { freshDb, seed } from "./helpers.js";

const designDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "design");

/** How far along the thing a page describes is. Three, because the reader's question is
 *  only ever "can I use this today" — and "in progress" is the honest answer to a page
 *  whose subject is half written. */
const BUILT = ["not started", "in progress", "built"] as const;
type Built = (typeof BUILT)[number];

/** The most a page may claim, per state of the epic it names. Dropped work is as good as
 *  never started: whatever was built under it is not a capability anybody promised. */
const CEILING: Record<string, Built> = {
  planned: "not started",
  dropped: "not started",
  on_hold: "in progress",
  in_progress: "in progress",
  delivered: "built",
};

const rank = (b: Built): number => BUILT.indexOf(b);

interface Page {
  readonly file: string;
  readonly built: unknown;
  readonly epic: unknown;
}

/** The frontmatter of one page, or null where there is none to read. */
function frontmatter(file: string): Record<string, unknown> | null {
  const text = readFileSync(join(designDir, file), "utf8");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const parsed: unknown = parse(text.slice(4, end));
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

const pages = (): Page[] =>
  readdirSync(designDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const fm = frontmatter(file) ?? {};
      return { file, built: fm["built"], epic: fm["epic"] };
    });

/** What the ledger says about every epic, keyed by slug. A slug is not unique — the same
 *  epic can be replanned onto a later release, and a dropped and a delivered row can share
 *  a name — so the ceiling comes from the furthest any row of that name reached. */
function ledger(db: DatabaseSync): Map<string, Built> {
  const best = new Map<string, Built>();
  for (const row of db.prepare("SELECT slug, state FROM epic").all() as {
    slug: string;
    state: string;
  }[]) {
    const ceiling = CEILING[row.state];
    if (ceiling === undefined) throw new Error(`unknown epic state: ${row.state}`);
    const seen = best.get(row.slug);
    if (seen === undefined || rank(ceiling) > rank(seen)) best.set(row.slug, ceiling);
  }
  return best;
}

/** One complaint, or null when the page is honest. */
function judge(page: Page, epics: Map<string, Built>): string | null {
  const { built, epic, file } = page;
  if (built === undefined) return `${file}: no built state in its frontmatter`;
  if (typeof built !== "string" || !BUILT.includes(built as Built)) {
    return `${file}: built is ${JSON.stringify(built)}, not one of ${BUILT.join(", ")}`;
  }
  const claim = built as Built;
  if (claim === "not started") return null;
  if (typeof epic !== "string" || epic === "") {
    return `${file}: claims ${claim} but names no epic, so nothing in the ledger backs it`;
  }
  const ceiling = epics.get(epic);
  if (ceiling === undefined) return `${file}: names epic ${epic}, which is not in the ledger`;
  if (rank(claim) > rank(ceiling)) {
    return `${file}: claims ${claim}, but epic ${epic} allows at most ${ceiling}`;
  }
  return null;
}

/** Epics in given states, so the ceiling is read back out of the epic table the engine
 *  writes rather than out of a literal. A third element names a further release: an epic
 *  slug is unique per release and not per project, which is how the same epic comes to have
 *  two rows — replanned onto a later release after the first was dropped. */
function withEpics(
  db: DatabaseSync,
  epics: readonly (readonly [string, string] | readonly [string, string, string])[],
): void {
  const { project, release } = seed(db);
  const at = "2026-09-17T00:00:00.000Z";
  const releases = new Map<string, number>([["", release]]);
  for (const [slug, state, onto = ""] of epics) {
    let target = releases.get(onto);
    if (target === undefined) {
      db.prepare(
        "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ).run(onto, project, onto, "planned", at, at);
      target = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      releases.set(onto, target);
    }
    db.prepare(
      "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run(slug, target, slug, state, at, at);
  }
}

describe("every design page says whether it is built", () => {
  it("carries a built state", () => {
    const missing = pages().filter((p) => p.built === undefined);
    expect(missing.map((p) => p.file)).toEqual([]);
  });

  it("carries one of the three states and nothing else", () => {
    const wrong = pages().filter(
      (p) => p.built !== undefined && !BUILT.includes(p.built as Built),
    );
    expect(wrong.map((p) => `${p.file}: ${String(p.built)}`)).toEqual([]);
  });

  it("cites an epic wherever it claims more than not started", () => {
    const uncited = pages().filter(
      (p) =>
        (p.built === "in progress" || p.built === "built") &&
        (typeof p.epic !== "string" || p.epic === ""),
    );
    expect(uncited.map((p) => p.file)).toEqual([]);
  });

  it("finds a page under docs/design at all", () => {
    expect(pages().length).toBeGreaterThan(0);
  });
});

describe("a page cannot claim more than the ledger", () => {
  const page = (built: unknown, epic?: unknown): Page => ({ file: "99. Page.md", built, epic });

  it("refuses built while the epic it names is planned", () => {
    const db = freshDb();
    withEpics(db, [["subscriptions", "planned"]]);
    expect(judge(page("built", "subscriptions"), ledger(db))).toBe(
      "99. Page.md: claims built, but epic subscriptions allows at most not started",
    );
  });

  it("refuses in progress while the epic it names is planned", () => {
    const db = freshDb();
    withEpics(db, [["subscriptions", "planned"]]);
    expect(judge(page("in progress", "subscriptions"), ledger(db))).toBe(
      "99. Page.md: claims in progress, but epic subscriptions allows at most not started",
    );
  });

  it("refuses built while the epic it names is only in progress", () => {
    const db = freshDb();
    withEpics(db, [["roadmap-0-0-2", "in_progress"]]);
    expect(judge(page("built", "roadmap-0-0-2"), ledger(db))).toBe(
      "99. Page.md: claims built, but epic roadmap-0-0-2 allows at most in progress",
    );
  });

  it("allows in progress under an in progress epic, and built under a delivered one", () => {
    const db = freshDb();
    withEpics(db, [
      ["roadmap-0-0-2", "in_progress"],
      ["bulk-actions", "delivered"],
    ]);
    const l = ledger(db);
    expect(judge(page("in progress", "roadmap-0-0-2"), l)).toBeNull();
    expect(judge(page("built", "bulk-actions"), l)).toBeNull();
  });

  it("treats a dropped epic as no evidence at all", () => {
    const db = freshDb();
    withEpics(db, [["typed-data-access", "dropped"]]);
    expect(judge(page("in progress", "typed-data-access"), ledger(db))).toBe(
      "99. Page.md: claims in progress, but epic typed-data-access allows at most not started",
    );
  });

  it("takes the furthest of two epics sharing a slug", () => {
    const db = freshDb();
    withEpics(db, [
      ["design-and-stack", "dropped"],
      ["design-and-stack", "in_progress", "0-0-3"],
    ]);
    expect(judge(page("in progress", "design-and-stack"), ledger(db))).toBeNull();
  });

  it("refuses an epic the ledger has never heard of", () => {
    const db = freshDb();
    withEpics(db, [["roadmap-0-0-2", "in_progress"]]);
    expect(judge(page("built", "invented"), ledger(db))).toBe(
      "99. Page.md: names epic invented, which is not in the ledger",
    );
  });

  it("refuses a page with no built state, and one with a state of its own invention", () => {
    const db = freshDb();
    withEpics(db, []);
    const l = ledger(db);
    expect(judge(page(undefined), l)).toBe("99. Page.md: no built state in its frontmatter");
    expect(judge(page("shipped"), l)).toBe(
      `99. Page.md: built is "shipped", not one of ${BUILT.join(", ")}`,
    );
  });

  it("lets not started stand with no epic, and refuses a higher claim with none", () => {
    const db = freshDb();
    withEpics(db, []);
    const l = ledger(db);
    expect(judge(page("not started"), l)).toBeNull();
    expect(judge(page("built"), l)).toBe(
      "99. Page.md: claims built but names no epic, so nothing in the ledger backs it",
    );
  });

  it("holds every real page to the same judgement, given the epics they name", () => {
    const db = freshDb();
    withEpics(
      db,
      [...new Set(pages().map((p) => p.epic).filter((e): e is string => typeof e === "string"))].map(
        (slug) => [slug, "in_progress"] as const,
      ),
    );
    const l = ledger(db);
    expect(pages().map((p) => judge(p, l)).filter((c) => c !== null)).toEqual([]);
  });
});
