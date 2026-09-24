// @vitest-environment happy-dom
/** The pane is a real xterm.js terminal: output reaches the emulator unchanged, so
 * full-screen programs can colour, move, clear, and redraw their own screen. */
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { Terminal } from "@xterm/xterm";
import { attach, decode, encode, fits, IDS, keyOf, pane, roomIn } from "../src/client/terminal.js";
import type { ToSession } from "../src/client/terminal.js";

const settled = (terminal: Terminal): Promise<void> =>
  new Promise((resolve) => terminal.write("", resolve));

/** A pane over a real emulator. `door` is whether the page hands in a composer and a way of
 *  sending it: `pane()` draws neither any more, and the webapp's dock still draws both, so
 *  both shapes are the shape of a page that exists. */
function wired(door = true) {
  const handlers = new Map<string, ((event: never) => void)[]>();
  const on = (type: string, handler: (event: never) => void): void =>
    void handlers.set(type, [...(handlers.get(type) ?? []), handler]);
  const fire = (type: string, event: object): void => {
    for (const handler of handlers.get(type) ?? []) (handler as (event: object) => void)(event);
  };
  const screen = document.createElement("div");
  const composer = { value: "" };
  const sent: ToSession[] = [];
  const terminal = new Terminal();
  const keyboard = { addEventListener: on };
  const attached = attach(
    door ? { screen, keyboard, composer, send: { addEventListener: on } } : { screen, keyboard },
    terminal,
    (message) => sent.push(message),
  );
  return {
    screen, composer, sent, terminal, ...attached,
    press: (event: object) => fire("keydown", event),
    click: () => fire("click", {}),
  };
}

const line = (terminal: Terminal, y: number): string =>
  terminal.buffer.active.getLine(y)?.translateToString(true) ?? "";
const cell = (terminal: Terminal, x: number, y: number) =>
  terminal.buffer.active.getLine(y)?.getCell(x);

async function down(chunk: string): Promise<Terminal> {
  const page = wired();
  page.receive(encode({ kind: "output", chunk }));
  await settled(page.terminal);
  return page.terminal;
}

describe("the screen", () => {
  it("uses xterm.js pinned to an exact version", () => {
    const version = (pkg.dependencies as Record<string, string>)["@xterm/xterm"];
    expect(version).toBe("6.0.0");
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("opens the supplied terminal on the supplied element", () => {
    const page = wired();
    expect(page.terminal.element?.parentElement).toBe(page.screen);
  });

  it("interprets output escapes instead of stripping them", async () => {
    const terminal = await down("\x1b[31mred\x1b[0m plain\r\nrow two\r\n\x1b[4;7Hhere");
    expect(cell(terminal, 0, 0)?.getChars()).toBe("r");
    expect(cell(terminal, 0, 0)?.getFgColor()).toBe(1);
    expect(line(terminal, 0)).toBe("red plain");
    expect(line(terminal, 1)).toBe("row two");
    expect(cell(terminal, 6, 3)?.getChars()).toBe("h");
    expect(line(terminal, 3)).not.toContain("[4;7H");
  });

  it("supports alternate screens and clearing", async () => {
    const page = wired();
    page.receive(encode({ kind: "output", chunk: "the page\r\n\x1b[?1049h" }));
    await settled(page.terminal);
    expect(page.terminal.buffer.active.type).toBe("alternate");
    page.receive(encode({ kind: "output", chunk: "frame\x1b[?1049l" }));
    await settled(page.terminal);
    expect(page.terminal.buffer.active.type).toBe("normal");
    expect(line(page.terminal, 0)).toBe("the page");
    const cleared = await down("one\r\ntwo\r\n\x1b[2J\x1b[Hthree");
    expect(line(cleared, 0)).toBe("three");
    expect(line(cleared, 1)).toBe("");
  });

  it("handles carriage returns as terminal redraws", async () => {
    const terminal = await down("| working\r/ working\r- working\r\\ working");
    expect(line(terminal, 0)).toBe("\\ working");
    expect(line(terminal, 1)).toBe("");
  });
});

describe("the unchanged wire and controls", () => {
  it("ignores frames that are not output and reports exit on the terminal", async () => {
    const page = wired();
    page.receive("garbage");
    page.receive(encode({ kind: "prompt", text: "up" }));
    page.receive(encode({ kind: "output", chunk: "busy\r\n" }));
    page.receive(encode({ kind: "exit", code: 2 }));
    await settled(page.terminal);
    expect(line(page.terminal, 0)).toBe("busy");
    expect(line(page.terminal, 1)).toBe("[session left with 2]");
  });

  it("sends keys unread and keeps the browser out of them", () => {
    const page = wired();
    let prevented = 0;
    page.press({ key: "a", preventDefault: () => (prevented += 1) });
    page.press({ key: "Enter", preventDefault: () => (prevented += 1) });
    expect(page.sent).toEqual([{ kind: "keys", data: "a" }, { kind: "keys", data: "\r" }]);
    expect(prevented).toBe(2);
    expect(keyOf({ key: "ArrowUp" })).toBe("\x1b[A");
  });

  it("keeps the prompt door for a page that draws one", () => {
    const page = wired();
    page.composer.value = "draw the board";
    page.click();
    expect(page.sent).toEqual([{ kind: "prompt", text: "draw the board" }]);
    expect(page.composer.value).toBe("");
  });
});

/** The composer is cut from the pane.
 *
 *  It was a box under the screen: the designer typed a line into it and pressed a button,
 *  and the line went up as a prompt. That is what a transcript needs, and the screen is not
 *  a transcript any more — it is a terminal, and the keyboard reaches the far end one
 *  keystroke at a time, through the shell's own line editor, with history and Ctrl-C and a
 *  cursor. Two boxes were two answers to where the next word goes, and the lower one could
 *  say nothing but a whole line.
 *
 *  So `pane()` draws a screen and nothing else, and the screen has the pane's whole box —
 *  which is what the fit below then has something to divide. The door is not deleted from
 *  the wire or from `attach`, because a page may still draw one and the webapp's dock does;
 *  it is a part a page hands in, and a pane handed neither wires neither. */
describe("the composer is cut from the pane", () => {
  it("draws a screen and nothing else", () => {
    const markup = pane();
    expect(markup).toContain(`<div id="${IDS.screen}"`);
    expect(markup).not.toContain("<pre");
    for (const id of Object.values(IDS)) expect(markup).toContain(`id="${id}"`);
    // Nothing to type a line into, nothing to send it with, and no id left naming either.
    for (const gone of ["<textarea", "<form", "<button", "composer", "prompt", "send"]) {
      expect(markup, gone).not.toContain(gone);
    }
    expect(Object.keys(IDS).sort()).toEqual(["pane", "screen"]);
  });

  it("wires nothing for a door the page did not draw, and still takes every key", () => {
    const page = wired(false);
    page.press({ key: "x" });
    expect(page.sent).toEqual([{ kind: "keys", data: "x" }]);
    // A click, which is what a composer's own button raises. It must reach nothing: a pane
    // with no composer has no box to read and no empty prompt to send, and a listener on an
    // element that is not there is the shape of a pane that quietly does nothing.
    page.click();
    expect(page.sent).toEqual([{ kind: "keys", data: "x" }]);
  });

  it("is why there is a fit: the screen is the pane, so the pane's box is the screen's", () => {
    const page = wired(false);
    page.terminal.resize(24, 6);
    // The grid as drawn — 24 × 6 cells in 240 × 120 pixels — and the pane's whole box, which
    // is now the screen's whole box because there is nothing under it taking a strip.
    expect(page.fit({ width: 800, height: 240 }, { width: 240, height: 120 })).toEqual({
      cols: 80,
      rows: 12,
    });
    expect(page.sent).toEqual([{ kind: "resize", cols: 80, rows: 12 }]);
  });
});

/** The emulator is fitted to the box it is drawn in, and the size goes up the wire.
 *
 *  A pty is opened at a size and keeps composing frames for that size until it is told
 *  another one. So a pane whose box is not the pty's size is not a smaller view of the
 *  session — it is a different screen: lines wrap where the far end did not wrap them, a
 *  status bar lands in the middle of the pane, and a full-screen program redraws at a
 *  width nothing is showing. Two things have to happen and they are one act: the emulator
 *  takes the new grid, and the far end is told.
 *
 *  The arithmetic is stated on pixels rather than on elements. A fit that could only be
 *  checked by laying out a document in a browser is a fit nothing checks — so `fits` takes
 *  the pane's box, the box the emulator's grid currently fills, and the grid it currently
 *  is, and hands back cells. One cell is the grid's box over the grid's cells, which is
 *  how this asks xterm how big a cell is without asking xterm anything: the emulator has
 *  already said, by drawing some. */
describe("the fit", () => {
  const grid = { width: 400, height: 160 }; // 40 × 8 cells, so a cell is 10 × 20
  const now = { cols: 40, rows: 8 };

  it("divides the cell out of what is drawn, and fills the box with it", () => {
    expect(fits({ width: 800, height: 240 }, grid, now)).toEqual({ cols: 80, rows: 12 });
  });

  it("floors, because half a column is not a column the far end can draw in", () => {
    // 795/10 is 79.5 and 235/20 is 11.75. A pane that rounded up would hand the far end a
    // column and a row it has no pixels for, and the last of each would be clipped.
    expect(fits({ width: 795, height: 235 }, grid, now)).toEqual({ cols: 79, rows: 11 });
  });

  it("refuses a box nothing is drawn in yet, rather than dividing by nothing", () => {
    // The dock before its first frame, and the dock while it is shut: `display: none`
    // measures zero. Either way there is no cell to divide by and nothing to propose.
    expect(fits({ width: 800, height: 240 }, { width: 0, height: 0 }, now)).toBeNull();
    expect(fits({ width: 800, height: 240 }, grid, { cols: 0, rows: 0 })).toBeNull();
  });

  it("refuses a box that will not hold one whole cell", () => {
    // A pty resized to nought columns is a pty every program on it draws garbage into, so
    // a window dragged down to nothing leaves the session at the size it last had.
    expect(fits({ width: 0, height: 0 }, grid, now)).toBeNull();
    expect(fits({ width: 9, height: 240 }, grid, now)).toBeNull();
    expect(fits({ width: 800, height: 19 }, grid, now)).toBeNull();
  });

  it("refuses a size the screen already is, so a drag is not a frame per pixel", () => {
    expect(fits({ width: 400, height: 160 }, grid, now)).toBeNull();
    // …and a box that grew by less than a cell is the same size, which is the common one:
    // the fit runs on every beat and almost every beat has nothing to do.
    expect(fits({ width: 409, height: 179 }, grid, now)).toBeNull();
  });
});

/** What the pane's box is, before `fits` divides it.
 *
 *  A browser measures an element as a rectangle, and a rectangle is the border box: it is
 *  everything that was painted, padding and rule included. Neither is room — the emulator
 *  may not put a cell under the border the design drew round the screen, nor in the gap it
 *  asked for inside it — so a pane fitted to the rectangle is told it is bigger than it is,
 *  and the far end composes a frame whose last column the reader cannot see the edge of.
 *
 *  It is here rather than in the page that measures, for the reason `fits` is: an element
 *  is the browser's, the subtraction is not, and arithmetic that can only be checked by
 *  laying out a document is arithmetic nothing checks. What the page hands in is a
 *  rectangle and a computed style, which is what it already has. */
describe("the room in a rectangle", () => {
  const rect = { width: 800, height: 240 };
  const px = (n: number): string => `${n}px`;

  it("is the whole rectangle when nothing is spent on trim", () => {
    expect(roomIn(rect, {})).toEqual(rect);
  });

  it("takes off the padding, which is the gap the design asked for inside the screen", () => {
    const edges = { paddingLeft: px(14), paddingRight: px(14), paddingTop: px(9), paddingBottom: px(9) };
    expect(roomIn(rect, edges)).toEqual({ width: 772, height: 222 });
  });

  it("takes off the border too, which is the pixel the old sheet ruled the screen with", () => {
    // The rule that used to run along the top and bottom of the dock's screen. Two pixels
    // is less than a row, so the pane that ignored them fitted a row too many exactly when
    // the panel's height landed near a boundary — and drew its last one under the rule.
    const edges = { borderTopWidth: px(1), borderBottomWidth: px(1), borderLeftWidth: px(1), borderRightWidth: px(1) };
    expect(roomIn(rect, edges)).toEqual({ width: 798, height: 238 });
  });

  it("reads what a browser actually answers, and calls the rest nought", () => {
    // `0px` for a side with nothing on it, `medium` for a border width nobody gave a length
    // to, and nothing at all for a property this browser does not know. A measurement that
    // threw or gave NaN on any of them is a pane that never fits at all.
    const edges = { paddingLeft: "0px", paddingRight: "", borderLeftWidth: "medium", borderRightWidth: undefined };
    expect(roomIn(rect, edges)).toEqual(rect);
  });

  it("never goes below nought, however much trim is on a box with nothing in it", () => {
    // A dock the reader has shut measures zero and still has its padding declared. Negative
    // pixels are not a box; `fits` has the answer for a box too small to hold a cell.
    expect(roomIn({ width: 0, height: 0 }, { paddingLeft: px(14), paddingTop: px(9) })).toEqual({
      width: 0,
      height: 0,
    });
  });
});

describe("the fit reaches the emulator and the far end together", () => {
  /** The grid the pane is told the emulator is filling. A terminal of 24 × 6 in cells of
   *  10 × 20, so a box of 800 × 240 is 80 × 12. */
  const grid = { width: 240, height: 120 };

  it("resizes the terminal and sends the size up the same wire as the keys", () => {
    const page = wired();
    page.terminal.resize(24, 6);
    expect(page.fit({ width: 800, height: 240 }, grid)).toEqual({ cols: 80, rows: 12 });
    // The emulator first: the screen the reader is looking at is the right shape before
    // the far end starts composing frames for it.
    expect([page.terminal.cols, page.terminal.rows]).toEqual([80, 12]);
    expect(page.sent).toEqual([{ kind: "resize", cols: 80, rows: 12 }]);
  });

  it("takes the screen's own trim off before it divides, when the page hands it in", () => {
    const page = wired();
    page.terminal.resize(24, 6);
    // The same 800 × 240 rectangle, with the dock's padding and a rule round it declared:
    // 800 − 2×14 − 2×1 is 770, and 240 − 2×9 − 2×1 is 220, which is 77 × 11 cells and not
    // 80 × 12. Those three columns are what the pane used to claim it had and did not.
    const trim = {
      paddingLeft: "14px",
      paddingRight: "14px",
      paddingTop: "9px",
      paddingBottom: "9px",
      borderTopWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderRightWidth: "1px",
    };
    expect(page.fit({ width: 800, height: 240 }, grid, trim)).toEqual({ cols: 77, rows: 11 });
    expect([page.terminal.cols, page.terminal.rows]).toEqual([77, 11]);
    expect(page.sent).toEqual([{ kind: "resize", cols: 77, rows: 11 }]);
  });

  it("sends nothing when there is nothing to fit", () => {
    const page = wired();
    page.terminal.resize(24, 6);
    // Already the size it should be, and a grid nothing has drawn into: both are `fits`
    // answering null, and a null must not reach the wire as a frame.
    expect(page.fit({ width: 240, height: 120 }, grid)).toBeNull();
    expect(page.fit({ width: 800, height: 240 }, { width: 0, height: 0 })).toBeNull();
    expect(page.sent).toEqual([]);
    expect([page.terminal.cols, page.terminal.rows]).toEqual([24, 6]);
  });

  it("is a frame of the wire, read back as one, and a broken one is not", () => {
    // The far end decodes what the pane encoded, so the two halves agree on the message
    // rather than on a shape one of them invented.
    expect(decode(encode({ kind: "resize", cols: 80, rows: 12 }))).toEqual({
      kind: "resize",
      cols: 80,
      rows: 12,
    });
    // A count of cells is whole and at least one. A pty asked for nought columns, or for
    // 79.5 of them, is a pty asked for a screen that cannot exist — and a socket can be
    // handed anything, so it is refused here rather than passed on to `resize`.
    expect(decode(`{"kind":"resize","cols":0,"rows":12}`)).toBeNull();
    expect(decode(`{"kind":"resize","cols":79.5,"rows":12}`)).toBeNull();
    expect(decode(`{"kind":"resize","cols":80}`)).toBeNull();
    expect(decode(`{"kind":"resize","cols":"80","rows":"12"}`)).toBeNull();
  });
});
