/** The cockpit's state — see config/tui-contract.yaml. Nothing here draws: an App is what
 *  a key does to what is on screen, and screens.ts is what that looks like. */
import type { DatabaseSync } from "node:sqlite";
import {
  board,
  Engine,
  loadMachines,
  Repo,
  tree,
  type Board,
  type MachineSet,
  type Node,
  type StatefulEntity,
} from "@wecode/core";
import type { Row } from "./list.js";
import type { View } from "./views.js";

export type Screen =
  | { readonly kind: "dashboard" }
  | { readonly kind: "box"; readonly view: View }
  | { readonly kind: "node"; readonly entity: StatefulEntity; readonly id: number };

/** A screen and where the cursor was on it, so esc comes back to the row you left. */
interface Frame {
  readonly screen: Screen;
  cursor: number;
}

/** A row and what it is a row of. The board's filters are queries over different tables,
 *  so which entity a line names is not recoverable from the line itself. */
interface Item {
  readonly row: Row;
  readonly entity: StatefulEntity | null;
}

const ENTITY: Readonly<Record<keyof Board, StatefulEntity | null>> = {
  projects: "project",
  running: "assignment",
  needs_human: "assignment",
  queued: "task",
  failed: "task",
  stale: "task",
  // Two tables in one box; board.ts tags which in the detail.
  roadmap: null,
  delivered: "story",
};

/** What a terminal sends for the esc key, by code point rather than as a literal control
 *  character. `key("esc")` is the same key by name. */
const ESC = String.fromCharCode(27);
const ENTER = ["enter", "\r", "\n"];

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

export class App {
  readonly views: readonly View[];
  status = "";
  quit = false;

  private readonly db: DatabaseSync;
  private readonly engine: Engine;
  private readonly machines: MachineSet;
  private readonly repo: Repo;
  private readonly keys: ReadonlyMap<string, View>;
  private frames: Frame[] = [{ screen: { kind: "dashboard" }, cursor: 0 }];
  private items: Item[] = [];
  private forest: readonly Node[] = [];
  private snapshot: Board | null = null;
  /** What the last key armed: v waits for a box's letter, a waits for a verb's. */
  private armed: null | "view" | "verb" = null;

  constructor(db: DatabaseSync, views: readonly View[], machines: MachineSet = loadMachines()) {
    this.db = db;
    this.views = views;
    this.machines = machines;
    this.engine = new Engine(db, machines);
    this.repo = new Repo(db);
    this.keys = boxKeys(views);
    this.refresh();
  }

  get screen(): Screen {
    return this.frames[this.frames.length - 1]?.screen ?? { kind: "dashboard" };
  }

  get cursor(): number {
    return this.frames[this.frames.length - 1]?.cursor ?? 0;
  }

  set cursor(n: number) {
    const frame = this.frames[this.frames.length - 1];
    const last = Math.max(this.items.length - 1, 0);
    if (frame !== undefined) frame.cursor = Math.min(Math.max(n, 0), last);
  }

  /** Re-read the database. The cursor is clamped rather than reset: work finishing under
   *  you should not move the row you were about to act on further than it has to. */
  refresh(): void {
    this.snapshot = board(this.db);
    this.forest = tree(this.db);
    this.items = this.itemsOf(this.screen);
    this.cursor = this.cursor;
  }

  lines(): Row[] {
    return this.items.map((i) => i.row);
  }

  /** The board as of the last refresh, for screens.ts to draw the boxes from. */
  boardNow(): Board {
    return this.snapshot ?? board(this.db);
  }

  /** The verbs the row under the cursor may take, read off its machine. Automatic
   *  transitions are absent: no actor invokes them, so offering one would be a lie. */
  verbs(): string[] {
    const item = this.current();
    if (item === null || item.entity === null) return [];
    const state = this.repo.stateOf(item.entity, item.row.id);
    if (state === null) return [];
    const legal = this.machines[item.entity].transitions.filter(
      (t) => t.automatic !== true && t.from.includes(state),
    );
    return [...new Set(legal.map((t) => t.verb))];
  }

  key(k: string): void {
    if (this.armed === "view") {
      this.armed = null;
      return this.openBox(k);
    }
    if (this.armed === "verb") {
      this.armed = null;
      return this.pick(k);
    }
    if (ENTER.includes(k)) return this.descend();
    if (k === "esc" || k === ESC) return this.pop();
    switch (k) {
      case "j": return this.move(1);
      case "k": return this.move(-1);
      case "g": this.cursor = 0; return;
      case "G": this.cursor = this.items.length - 1; return;
      case "q": this.quit = true; return;
      case "r": this.refresh(); this.status = "refreshed"; return;
      case "v": return this.armView();
      case "a": return this.armVerb();
      default: this.status = `${k} does nothing here`;
    }
  }

  private current(): Item | null {
    return this.items[this.cursor] ?? null;
  }

  private move(by: number): void {
    this.cursor = this.cursor + by;
    this.status = "";
  }

  private armView(): void {
    this.armed = "view";
    this.status = `box? ${[...this.keys].map(([k, v]) => `${k} ${v.title}`).join("  ")}`;
  }

  private openBox(k: string): void {
    const view = this.keys.get(k);
    if (view === undefined) {
      this.status = `no box on ${k}`;
      return;
    }
    this.push({ kind: "box", view });
    this.status = view.title;
  }

  private armVerb(): void {
    const verbs = this.verbs();
    if (verbs.length === 0) {
      this.status = "nothing may be done to this row";
      return;
    }
    this.armed = "verb";
    this.status = `verb? ${verbs.map((v) => `${v[0]} ${v}`).join("  ")}`;
  }

  /** A letter that fits two verbs is refused. Guessing would apply the wrong one, and a
   *  state change is not a keystroke you can take back. */
  private pick(k: string): void {
    const item = this.current();
    const match = this.verbs().filter((v) => v.startsWith(k));
    if (item === null || item.entity === null || match.length === 0) {
      this.status = `no verb on ${k}`;
      return;
    }
    if (match.length > 1) {
      this.status = `${k} is ambiguous: ${match.join(", ")}`;
      return;
    }
    const verb = match[0] as string;
    const out = this.engine.apply(item.entity, item.row.id, verb, "operator");
    this.refresh();
    this.status = out.ok
      ? `${item.entity} #${item.row.id} ${verb} → ${out.changes[0]?.to ?? ""}`
      : out.why;
  }

  private descend(): void {
    const item = this.current();
    if (item === null || item.entity === null) {
      this.status = "nothing to open";
      return;
    }
    if (this.find(item.entity, item.row.id) === null) {
      this.status = `${item.entity} #${item.row.id} has nothing under it`;
      return;
    }
    this.push({ kind: "node", entity: item.entity, id: item.row.id });
    this.status = `${item.entity} #${item.row.id}`;
  }

  private push(screen: Screen): void {
    this.frames.push({ screen, cursor: 0 });
    this.items = this.itemsOf(screen);
    this.cursor = 0;
  }

  private pop(): void {
    if (this.frames.length === 1) {
      this.status = "this is the dashboard";
      return;
    }
    this.frames.pop();
    this.items = this.itemsOf(this.screen);
    this.cursor = this.cursor;
    this.status = "";
  }

  private itemsOf(screen: Screen): Item[] {
    if (screen.kind === "node") {
      const node = this.find(screen.entity, screen.id);
      return (node?.children ?? []).map((c) => ({
        entity: c.entity as StatefulEntity,
        row: { id: c.id, what: c.label, state: c.state, detail: c.entity },
      }));
    }
    const boxes = screen.kind === "box" ? [screen.view] : this.views;
    const now = this.snapshot ?? board(this.db);
    return boxes.flatMap((v) =>
      now[v.filter].map((row) => ({
        entity: ENTITY[v.filter] ?? (row.detail === "epic" ? "epic" : "story"),
        row: { ...row },
      })),
    );
  }

  /** The node for an entity, wherever it hangs in the tree. */
  private find(entity: StatefulEntity, id: number): Node | null {
    const walk = (nodes: readonly Node[]): Node | null => {
      for (const n of nodes) {
        if (n.entity === entity && n.id === id) return n;
        const hit = walk(n.children);
        if (hit !== null) return hit;
      }
      return null;
    };
    return walk(this.forest);
  }
}
