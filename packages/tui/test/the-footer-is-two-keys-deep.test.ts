/** The detail page's footer is two lines deep, and design.yaml is where that is said.
 *
 *  The cockpit's bar is one flat list because every key on it does the same thing wherever
 *  the cursor is. A record's page answers two questions at once — what can be done to this
 *  record, and how to get back out — and one line runs them together. This file holds the
 *  declaration that splits them: two levels, the record's keys above and the keys that mean
 *  the same everywhere on the terminal's last line, where they sit on every other screen.
 *
 *  It gates the declaration, not the drawing. What screens.tsx puts on the page is gated by
 *  the-cockpit-matches-its-design; this is the design that drawing has to reach.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

const footer = design.detail?.footer as Record<string, any>;
const levels = (footer?.levels ?? []) as { level: string; keys: string[] }[];
const level = (name: string) => levels.find((l) => l.level === name);
const barKeys = (design.key_bar.keys as { key: string; does: string }[]).map((k) => k.key);

describe("the footer is two keys deep", () => {
  it("declares a footer on the detail page at all", () => {
    expect(footer).toBeTruthy();
    expect(design.detail.screens).toEqual(["node", "assignment"]);
  });

  it("is two lines, and two levels, not one list split by a separator", () => {
    expect(footer.lines).toBe(2);
    expect(levels).toHaveLength(2);
    expect(levels.map((l) => l.level)).toEqual(["record", "global"]);
  });

  it("puts what acts on the record above, and what means the same everywhere below", () => {
    expect(footer.order).toEqual(["record", "global"]);
    expect(level("record")!.keys).toEqual(["j/k", "g/G", "enter", "a"]);
    expect(level("global")!.keys).toEqual(["esc", "v", "v t", "r", "q"]);
  });

  it("keeps the global level on the last line, where every other screen has it", () => {
    expect(footer.sits).toBe("last");
    expect(footer.global_level).toBe("last_line");
    expect(design.bars.key_bar).toBe("last");
  });

  it("changes nothing else about how a key is written", () => {
    expect(footer.gap).toBe(design.key_bar.gap);
    expect(footer.entry).toBe(design.key_bar.entry);
  });

  it("invents no key: every key on both levels is one key_bar already declares", () => {
    expect(footer.keys_from).toBe("key_bar");
    for (const l of levels) {
      for (const key of l.keys) expect(barKeys, `${l.level}: ${key}`).toContain(key);
    }
  });

  it("omits the fold, which key_bar gives to the outline alone", () => {
    const fold = (design.key_bar.keys as { key: string; only_on?: string[] }[]).find(
      (k) => k.does === "fold",
    )!;
    expect(fold.only_on).toEqual(["outline"]);
    expect(footer.omits).toContain(fold.key);
    for (const l of levels) expect(l.keys).not.toContain(fold.key);
  });

  it("names every other key the bar offers a detail page, dropping none of them", () => {
    const withheld = new Set<string>(footer.omits as string[]);
    const named = levels.flatMap((l) => l.keys);
    for (const key of barKeys) {
      if (withheld.has(key)) continue;
      expect(named, key).toContain(key);
    }
    expect(named).toHaveLength(new Set(named).size);
  });
});
