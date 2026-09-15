/** One set of words, written in five places: the `Board` interface, the object `board()`
 *  actually returns, `FILTERS` in views.ts, `page.order` in views.yaml and the `filter:` of
 *  each view under it. The interface is proven against views.ts by `satisfies` at build
 *  time; everything else is proven here, against a real board rather than against a list
 *  copied into the test. */
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { board, open } from "@wecode/core";
import { tmp } from "../../core/test/tmpdir.js";
import { FILTERS, loadViews, ViewError } from "../src/views.js";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));
const yaml = parse(readFileSync(CONFIG, "utf8")) as {
  page: { order: string[] };
  views: Record<string, { filter: string }>;
};

/** The board as it is at runtime, not as it is declared: an empty workspace still answers
 *  with every group, so its keys are the names a filter has to be one of. */
const groups = Object.keys(board(open(":memory:")));

const write = (text: string): string => {
  const p = join(tmp("wecode-filter-names-"), "views.yaml");
  writeFileSync(p, text);
  return p;
};

describe("filter names", () => {
  it("names only groups a real board has", () => {
    expect(groups).toEqual(expect.arrayContaining([...FILTERS]));
  });

  it("orders exactly the views it declares", () => {
    expect([...yaml.page.order].sort()).toEqual(Object.keys(yaml.views).sort());
  });

  it("gives every declared view a filter the code knows", () => {
    for (const [name, v] of Object.entries(yaml.views)) {
      expect(FILTERS, `${name}: ${v.filter}`).toContain(v.filter);
    }
  });

  it("loads every ordered box, in order, with its filter on the board", () => {
    const views = loadViews();
    expect(views.map((v) => v.name)).toEqual(yaml.page.order);
    for (const v of views) expect(groups).toContain(v.filter);
  });

  it("refuses a filter no board group answers to", () => {
    const p = write("page:\n  order: [a]\nviews:\n  a:\n    filter: nonsense\n");
    expect(() => loadViews(p)).toThrow(/unknown filter nonsense/);
  });

  it("refuses an ordered name no view declares", () => {
    const p = write("page:\n  order: [ghost]\nviews:\n  a:\n    filter: running\n");
    expect(() => loadViews(p)).toThrow(ViewError);
  });

  it("refuses a declared view the page never orders", () => {
    const p = write(
      "page:\n  order: [a]\nviews:\n  a:\n    filter: running\n  b:\n    filter: queued\n",
    );
    expect(() => loadViews(p)).toThrow(/views declares b/);
  });
});
