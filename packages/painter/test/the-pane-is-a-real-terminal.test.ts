// @vitest-environment happy-dom
/** The pane is a real xterm.js terminal: output reaches the emulator unchanged, so
 * full-screen programs can colour, move, clear, and redraw their own screen. */
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { Terminal } from "@xterm/xterm";
import { attach, encode, IDS, keyOf, pane } from "../src/client/terminal.js";
import type { ToSession } from "../src/client/terminal.js";

const settled = (terminal: Terminal): Promise<void> =>
  new Promise((resolve) => terminal.write("", resolve));

function wired() {
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
  const attached = attach(
    { screen, keyboard: { addEventListener: on }, composer, send: { addEventListener: on } },
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

  it("keeps the prompt door and pane markup", () => {
    const page = wired();
    page.composer.value = "draw the board";
    page.click();
    expect(page.sent).toEqual([{ kind: "prompt", text: "draw the board" }]);
    expect(page.composer.value).toBe("");
    const markup = pane();
    expect(markup).toContain(`<div id="${IDS.screen}"`);
    expect(markup).not.toContain("<pre");
    for (const id of Object.values(IDS)) expect(markup).toContain(`id="${id}"`);
  });
});
