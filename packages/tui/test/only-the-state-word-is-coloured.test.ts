/** Only the state word is coloured.
 *
 *  The board painted the whole line in the state's colour: a row wanting a person was red
 *  end to end — its id, its title and the why beside it — and a settled row was dim end to
 *  end. That spends the colour on words the colour is not a fact about, and on a screen
 *  holding three or four such rows there is nothing left for the eye to land on. The
 *  colour is a fact about one word, and that word is already on the line.
 *
 *  So the line is drawn in the foreground the terminal already had, and the state word
 *  inside it carries the colour. A line that does not say a state — the "… and N more"
 *  tally, the lower two lines of a running row — is drawn plain throughout, because there
 *  is no word there for the colour to be about.
 *
 *  Asserted against rendered frames, since which characters the terminal paints is the
 *  whole of what this decides. */
import { GREEN, RED, coloured, inverted, plain } from "./force-color.js";
import { describe, expect, it } from "vitest";
import { createElement, isValidElement } from "react";
import { render } from "ink-testing-library";
import { List, listLines, say, type Line, type Row } from "../src/list.js";

/** chalk's `gray`, the bright-black foreground, closes with the same reset as any colour. */
const DIM = 90;

/** One row of each kind of colour: an ask (red), a settled row (dim), and one whose group
 *  declares no colour at all. Each title is a word no state is spelled with, so a coloured
 *  run holding one of them is a run that overreached. */
const ROWS: readonly Row[] = [
  { id: 1, what: "land the release", state: "approval", detail: "" },
  { id: 22, what: "shipped last week", state: "delivered", detail: "" },
  { id: 333, what: "ran out of attempts", state: "failed", detail: "" },
];

const frame = (rows: readonly Row[] = ROWS, cursor: number | null = null, height = 10): string =>
  render(createElement(List, { rows, height, cursor, width: 60 })).lastFrame() ?? "";

describe("the word that carries the colour", () => {
  it("paints the state word and nothing else in the line's colour", () => {
    expect(coloured(frame(), RED)).toEqual(["approval"]);
    expect(coloured(frame(), DIM)).toEqual(["delivered"]);
  });

  it("draws the rest of the line in the foreground the terminal already had", () => {
    const out = frame();
    // The words are all still on the screen — this is about colour, not about content.
    for (const row of ROWS) expect(plain(out)).toContain(row.what);
    for (const code of [RED, DIM, GREEN]) {
      for (const run of coloured(out, code)) {
        for (const row of ROWS) expect(run, `${run} reaches past the state`).not.toContain(row.what);
        expect(run, `${run} reaches past the state`).not.toContain("#");
      }
    }
  });

  it("leaves a row whose group declares no colour in no colour run at all", () => {
    for (const code of [RED, DIM, GREEN]) {
      for (const run of coloured(frame(), code)) expect(run).not.toBe("failed");
    }
  });
});

describe("a line with no state word on it", () => {
  it("draws the tally plain, there being no row behind it", () => {
    const short = frame(ROWS, null, 2);
    expect(plain(short)).toContain("… and 2 more");
    for (const code of [RED, DIM, GREEN]) {
      for (const run of coloured(short, code)) expect(run).not.toContain("more");
    }
    // And the tally is the only line the full frame does not have.
    expect(plain(frame())).not.toContain("more");
  });

  it("says so through `say`: a line that does not spell its state is one plain string", () => {
    expect(say({ text: "… and 2 more", state: "", cursor: false })).toBe("… and 2 more");
    expect(say({ text: "  wrapped title", state: "running", cursor: false }))
      .toBe("  wrapped title");
  });

  it("splits a line that does spell it into the words before, the state, and the rest", () => {
    const line = listLines([ROWS[0] as Row], 1, null, 60)[0] as Line;
    const parts = say(line) as unknown[];
    expect(Array.isArray(parts)).toBe(true);
    const [before, word, after] = parts;
    expect(isValidElement(word)).toBe(true);
    expect((word as { props: { children: string; color: string } }).props.children).toBe("approval");
    expect((word as { props: { color: string } }).props.color).toBe("red");
    expect(`${before as string}approval${after as string}`).toBe(line.text);
  });
});

describe("what the colour does not take over", () => {
  it("still inverts the whole of the cursor's row, colour or no colour", () => {
    const runs = inverted(frame(ROWS, 0));
    expect(runs.join("")).toContain("approval");
    expect(runs.join("")).toContain("land the release");
  });
});
