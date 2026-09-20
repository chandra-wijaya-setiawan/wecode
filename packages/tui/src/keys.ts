/** What a key means — see config/tui-contract.yaml. Nothing here knows what is on screen:
 *  a keystroke is a name for an action, and app.ts is what the action does. The two halves
 *  are split because the question "what is `n` bound to" and the question "what does
 *  jumping to the next match do" have different answers and different reasons to change. */
import type { View } from "./views.js";

/** What the last key armed: v waits for a box's letter, a waits for a verb's, f waits for
 *  a scope's, t waits for a direction to take the whole tree's depth in, / takes words. */
export type Mode = "view" | "verb" | "answer" | "scope" | "search" | "depth";

/** What a terminal sends for the esc key, by code point rather than as a literal control
 *  character. `key("esc")` is the same key by name. */
export const ESC = String.fromCharCode(27);
export const ENTER = ["enter", "\r", "\n"];
/** What a terminal sends for backspace, by name and by both code points terminals use. */
export const RUBOUT = ["backspace", "delete", String.fromCharCode(8), String.fromCharCode(127)];

export const isEnter = (k: string): boolean => ENTER.includes(k);
export const isEsc = (k: string): boolean => k === "esc" || k === ESC;

const keyOf = (v: View): string | undefined => {
  const k = (v as { key?: unknown }).key;
  return typeof k === "string" && k.length === 1 ? k : undefined;
};

/** The letter a box is opened by. A view that declares one keeps it; the rest take the
 *  first letter of their name nothing else has taken, so `v` reaches every box. */
export function boxKeys(views: readonly View[]): ReadonlyMap<string, View> {
  const keys = new Map<string, View>();
  const rest: View[] = [];
  for (const v of views) {
    const k = keyOf(v);
    if (k !== undefined && !keys.has(k)) keys.set(k, v);
    else rest.push(v);
  }
  for (const v of rest) {
    const free = [...v.name].find((c) => /[a-z]/.test(c) && !keys.has(c));
    if (free !== undefined) keys.set(free, v);
  }
  return keys;
}

/** What a reader may ask of the screen behind it. Every action a key has is one of these,
 *  so a binding that reaches nothing on this list cannot be written. The `arm*` methods
 *  answer with the mode they armed, or null when the screen they need is not the one you
 *  are on — the refusal is the screen's to word, and the reader only records the mode. */
export interface Keyed {
  status: string;
  quit: boolean;
  cursor: number;
  /** How many rows the screen holds, for `G` to land on the last of them. */
  readonly rows: number;
  openBox(k: string): void;
  pickVerb(k: string): void;
  sayAnswer(k: string): void;
  narrow(k: string): void;
  stepDepth(k: string): void;
  descend(): void;
  pop(): void;
  move(by: number): void;
  refreshNow(): void;
  fold(open: boolean): void;
  jump(by: number): void;
  seek(query: string): void;
  armView(): Mode | null;
  armVerb(): Mode | null;
  armScope(): Mode | null;
  armDepth(): Mode | null;
  armSearch(): Mode | null;
}

/** The keyboard: which key does what, and the little state a key needs to mean something —
 *  the letter you are owed after `v`, the words you are part-way through typing after `/`. */
export class KeyReader {
  private readonly to: Keyed;
  private armed: Mode | null = null;
  /** What is being typed after `/`. It lives here rather than on the screen because it is
   *  not on the screen: it is the half-finished keystroke, and it dies with the prompt. */
  private typed = "";

  constructor(to: Keyed) {
    this.to = to;
  }

  /** What the last key armed, or null when the next key is a command. */
  get waitingFor(): Mode | null {
    return this.armed;
  }

  read(k: string): void {
    if (this.armed === "search") return this.type(k);
    const armed = this.armed;
    this.armed = null;
    const to = this.to;
    switch (armed) {
      case "view": return to.openBox(k);
      case "verb": return to.pickVerb(k);
      case "answer": return to.sayAnswer(k);
      case "scope": return to.narrow(k);
      case "depth": return to.stepDepth(k);
      default: break;
    }
    if (isEnter(k)) return to.descend();
    if (isEsc(k)) return to.pop();
    switch (k) {
      case "j": return to.move(1);
      case "k": return to.move(-1);
      case "g": to.cursor = 0; return;
      case "G": to.cursor = to.rows - 1; return;
      case "q": to.quit = true; return;
      case "r": return to.refreshNow();
      case "+": return to.fold(true);
      case "-": return to.fold(false);
      case "f": return this.arm(to.armScope());
      case "t": return this.arm(to.armDepth());
      case "/": return this.arm(to.armSearch());
      case "n": return to.jump(1);
      case "N": return to.jump(-1);
      case "v": return this.arm(to.armView());
      case "a": return this.arm(to.armVerb());
      default: to.status = `${k} does nothing here`;
    }
  }

  /** Record what a key armed. A refused arming leaves nothing armed, so the screen's
   *  explanation is not followed by a key that lands somewhere it was never offered. */
  private arm(mode: Mode | null): void {
    this.armed = mode;
    if (mode !== "search") return;
    this.typed = "";
    this.prompt();
  }

  private prompt(): void {
    this.to.status = `/${this.typed}`;
  }

  /** A key while the search line is open. Every printable key is a character of the query
   *  rather than a command — `n` and `j` are letters in a label, and a search box that
   *  moved the cursor on one of them would be unusable. Enter commits, esc abandons. */
  private type(k: string): void {
    if (isEnter(k)) {
      this.armed = null;
      return this.to.seek(this.typed.trim());
    }
    if (isEsc(k)) {
      this.armed = null;
      this.typed = "";
      this.to.status = "";
      return;
    }
    if (RUBOUT.includes(k)) this.typed = this.typed.slice(0, -1);
    else if (k.length === 1) this.typed += k;
    this.prompt();
  }
}
