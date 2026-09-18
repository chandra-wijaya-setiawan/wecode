/** The cockpit's state — see config/tui-contract.yaml. Nothing here draws: an App is what
 *  a key does to what is on screen, and screens.ts is what that looks like. */
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  actorOf,
  answerApproval,
  approvalById,
  ApprovalError,
  board,
  Engine,
  loadMachines,
  OPERATOR,
  Repo,
  tree,
  TRANSITIONS,
  Verbs,
  type Board,
  type MachineSet,
  type Approval,
  type Node,
  type Outcome,
  type StatefulEntity,
} from "@wecode/core";
import type { Row } from "./list.js";
import {
  atDepth,
  foldedTo,
  nodeKey,
  openDepth,
  openWork,
  outlineRows,
  OUTLINE,
  OutlineError,
  SCOPE_KEYS,
  SCOPE_LABEL,
  treeDepth,
  type OutlineScope,
} from "./outline.js";
import type { View } from "./views.js";

const VIEWS_CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));

/** Which scope the outline opens on, declared beside its title, key and depth. The outline
 *  is the screen you go to for what is left, so whether it lands narrowed is a product
 *  decision and belongs in views.yaml rather than in a literal here. The names it may take
 *  are SCOPE_KEYS' own, so this adds no second list of them, and an unknown one is a
 *  refusal to start rather than a screen that quietly holds the wrong rows. */
export function loadOutlineScope(path: string = VIEWS_CONFIG): OutlineScope {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  const outline = ((raw ?? {}) as Record<string, unknown>)["outline"];
  const declared = ((outline ?? {}) as Record<string, unknown>)["scope"];
  const scopes = [...SCOPE_KEYS.values()];
  if (!scopes.includes(declared as OutlineScope)) {
    throw new OutlineError(
      `outline.scope must be one of ${scopes.join(", ")}, not ${String(declared)}`,
    );
  }
  return declared as OutlineScope;
}

/** Read once, on the first App rather than on import: screens.tsx, app.ts and outline.tsx
 *  form an import cycle, so a constant initialised here would read SCOPE_KEYS before
 *  outline.tsx had finished defining it. */
let opensOn: OutlineScope | null = null;
export const outlineOpensOn = (): OutlineScope => (opensOn ??= loadOutlineScope());

export type Screen =
  | { readonly kind: "dashboard" }
  | { readonly kind: "box"; readonly view: View }
  | { readonly kind: "outline" }
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
  /** The tree node a row came from, on the outline. Elsewhere a row is a board row and
   *  there is no node behind it. */
  readonly node?: Node;
}

const ENTITY: Readonly<Record<keyof Board, StatefulEntity | null>> = {
  projects: "project",
  running: "assignment",
  needs_human: "assignment",
  queued: "task",
  failed: "task",
  dropped: "task",
  stale: "task",
  unproven: "acceptance_test",
  // Two tables in one box; board.ts tags which in the detail.
  open: null,
  delivered: "story",
  unmergeable: "story",
};

/** What a terminal sends for the esc key, by code point rather than as a literal control
 *  character. `key("esc")` is the same key by name. */
const ESC = String.fromCharCode(27);
const ENTER = ["enter", "\r", "\n"];
/** What a terminal sends for backspace, by name and by both code points terminals use. */
const RUBOUT = ["backspace", "delete", String.fromCharCode(8), String.fromCharCode(127)];

/** Whether a query names a row by its number rather than by its words. A bare number is
 *  read as an id: ids are what the other screens print and what the cli takes, so the
 *  number you copied off one of them has to find the row here. */
const isId = (q: string): boolean => /^#?\d+$/.test(q);

/** Whether a row answers a query. A number matches the row's id exactly — `1` must not
 *  land on `21`, or the id you typed would not be the row you get. Words match the label
 *  case-insensitively and all of them must be in it, in any order: a search is how you
 *  narrow, so a second word can only ever mean fewer rows. */
const matches = (node: Node, q: string): boolean => {
  const query = q.trim();
  if (query === "") return false;
  if (isId(query)) return node.id === Number(query.replace("#", ""));
  const label = node.label.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => label.includes(word));
};

/** The forest a query leaves: every row that answers it, and the rows above those, and
 *  nothing else. A search is a filter rather than a jump — a tree that still held the
 *  hundred rows you were not looking for would leave you reading it to find the one you
 *  were. The rows under a match go with it: what is under a match is what folding is for.
 *  A query nothing answers prunes to nothing, and `matching` leaves the tree as it was. */
const matching = (forest: readonly Node[], query: string): readonly Node[] => {
  const prune = (nodes: readonly Node[]): Node[] =>
    nodes.flatMap((n) => {
      if (matches(n, query)) return [n];
      const under = prune(n.children);
      return under.length === 0 ? [] : [{ ...n, children: under }];
    });
  const pruned = prune(forest);
  return pruned.length === 0 ? forest : pruned;
};

/** The facade's methods, by the entity and verb each one invokes. Automatic transitions are
 *  absent, because the facade has no method for one — the cockpit can only offer a verb it
 *  can name a method for, so `a` cannot arm something no actor may invoke. */
const METHODS: ReadonlyMap<string, keyof Verbs> = new Map(
  TRANSITIONS.flatMap((t) =>
    t.method === null ? [] : [[`${t.entity}.${t.verb}`, t.method as keyof Verbs] as const],
  ),
);

/** Who the cockpit answers an approval as. The same variable the cli reads, defaulting to
 *  the same name, so one person is one identity whichever way in they took. The name still
 *  has to be a human worker's: core refuses an answer given on somebody else's behalf. */
const whoAnswers = (): string => actorOf(process.env["WECODE_ACTOR"]) ?? OPERATOR;

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
  /** The only way this screen changes the record. Every verb it offers is one of these
   *  methods, so a transition the machine table does not declare cannot be spelled here. */
  private readonly facade: Verbs;
  private readonly repo: Repo;
  private readonly keys: ReadonlyMap<string, View>;
  private frames: Frame[] = [{ screen: { kind: "dashboard" }, cursor: 0 }];
  private items: Item[] = [];
  private forest: readonly Node[] = [];
  private snapshot: Board | null = null;
  /** Which outline nodes are open. It belongs to the screen and outlives nothing else:
   *  folding is not a descent, so it must not cost an esc to undo. */
  private expanded: ReadonlySet<string> = new Set();
  /** How much of the tree the outline draws. It opens on the scope views.yaml names, and
   *  reopening returns to it rather than to wherever `f` last left it: an outline that
   *  opened narrowed by a keystroke from an hour ago would be one you could not read. */
  private scope: OutlineScope = outlineOpensOn();
  /** What the last key armed: v waits for a box's letter, a waits for a verb's, f waits for
   *  a scope's, t waits for a direction to take the whole tree's depth in. */
  private armed: null | "view" | "verb" | "answer" | "scope" | "search" | "depth" = null;
  /** What is being typed after `/`, and what was typed the last time it was committed.
   *  They are two fields because the committed one outlives the typing: `n` is only worth
   *  a key if it goes on working after the prompt it came from has gone. */
  private typed = "";
  private query = "";

  constructor(db: DatabaseSync, views: readonly View[], machines: MachineSet = loadMachines()) {
    this.db = db;
    this.views = views;
    this.facade = new Verbs(new Engine(db, machines));
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

  /** The verbs the row under the cursor may take, read off the facade. Automatic
   *  transitions are absent: no actor invokes them, so offering one would be a lie. */
  verbs(): string[] {
    const item = this.current();
    if (item === null || item.entity === null) return [];
    const state = this.repo.stateOf(item.entity, item.row.id);
    if (state === null) return [];
    return TRANSITIONS.filter(
      (t) => t.entity === item.entity && t.method !== null && t.from.includes(state),
    ).map((t) => t.verb);
  }

  key(k: string): void {
    if (this.armed === "search") return this.type(k);
    if (this.armed === "view") {
      this.armed = null;
      return this.openBox(k);
    }
    if (this.armed === "verb") {
      this.armed = null;
      return this.pick(k);
    }
    if (this.armed === "answer") {
      this.armed = null;
      return this.say(k);
    }
    if (this.armed === "scope") {
      this.armed = null;
      return this.narrow(k);
    }
    if (this.armed === "depth") {
      this.armed = null;
      return this.step(k);
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
      case "+": return this.fold(true);
      case "-": return this.fold(false);
      case "f": return this.armScope();
      case "t": return this.armDepth();
      case "/": return this.armSearch();
      case "n": return this.jump(1);
      case "N": return this.jump(-1);
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
    const boxes = [...this.keys].map(([k, v]) => `${k} ${v.title}`);
    this.status = `box? ${[...boxes, `${OUTLINE.key} ${OUTLINE.title}`].join("  ")}`;
  }

  /** Which scope the outline is drawing, for the box to title itself with. */
  get outlineScope(): OutlineScope {
    return this.scope;
  }

  /** The tree the outline draws: the whole forest, or only the work still owed. Everything
   *  the outline does — folding, the rows, the fold keys — reads it through here, so the
   *  narrowing cannot apply to the rows and not to the folding. */
  private outlineForest(): readonly Node[] {
    const scoped = this.scope === "open" ? openWork(this.forest) : this.forest;
    return this.query === "" ? scoped : matching(scoped, this.query);
  }

  /** The outline opens folded to the level its config names, and in the scope it names.
   *  Reopening refolds and re-narrows it: `v t` is how you ask for the overview, and an
   *  overview that remembered last time's expansions or last time's `f` would not be one. */
  private openOutline(): void {
    this.scope = outlineOpensOn();
    // Same reading as the scope: `v t` asks for the overview, and an overview still
    // standing open where an hour-old search left it would not be one.
    this.query = "";
    this.expanded = foldedTo(this.outlineForest(), OUTLINE.depth);
    this.push({ kind: "outline" });
    this.status = `${OUTLINE.title} — ${SCOPE_LABEL[this.scope]} · f narrows`;
  }

  private armScope(): void {
    if (this.screen.kind !== "outline") {
      this.status = `f narrows the outline — v ${OUTLINE.key}`;
      return;
    }
    this.armed = "scope";
    this.status = `show? ${[...SCOPE_KEYS].map(([k, s]) => `${k} ${SCOPE_LABEL[s]}`).join("  ")}`;
  }

  /** Narrow the outline to open work, or widen it back to all of it. The fold keys are
   *  re-derived rather than kept: the rows a narrowing removes take their fold state with
   *  them, so widening again stands open to the level the outline opens at. */
  private narrow(k: string): void {
    const scope = SCOPE_KEYS.get(k);
    if (scope === undefined) {
      this.status = `no scope on ${k}`;
      return;
    }
    this.scope = scope;
    this.expanded = foldedTo(this.outlineForest(), OUTLINE.depth);
    this.items = this.itemsOf(this.screen);
    this.cursor = this.cursor;
    this.status = `${OUTLINE.title} — ${SCOPE_LABEL[scope]}`;
  }

  /** What the last committed search was looking for, for the screen to say so with. */
  get outlineQuery(): string {
    return this.query;
  }

  /** Start typing a search. A box keeps rows by their state; what you have in hand is a
   *  number off another screen or two words out of a title, and what you want back is the
   *  tree with only those rows in it. */
  private armSearch(): void {
    if (this.screen.kind !== "outline") {
      this.status = `/ searches the outline — v ${OUTLINE.key}`;
      return;
    }
    this.armed = "search";
    this.typed = "";
    this.prompt();
  }

  private prompt(): void {
    this.status = `/${this.typed}`;
  }

  /** A key while the search line is open. Every printable key is a character of the query
   *  rather than a command — `n` and `j` are letters in a label, and a search box that
   *  moved the cursor on one of them would be unusable. Enter commits, esc abandons. */
  private type(k: string): void {
    if (ENTER.includes(k)) {
      this.armed = null;
      return this.seek(this.typed.trim());
    }
    if (k === "esc" || k === ESC) {
      this.armed = null;
      this.typed = "";
      this.status = "";
      return;
    }
    if (RUBOUT.includes(k)) this.typed = this.typed.slice(0, -1);
    else if (k.length === 1) this.typed += k;
    this.prompt();
  }

  /** Commit a query: filter the tree down to the rows that answer it and land on the first.
   *
   *  Filtering is the point. A search that only moved the cursor left the other hundred rows
   *  on screen, so finding the second match meant reading past them; the outline is for
   *  seeing where a row hangs, and the rows above a match are the only ones that say so.
   *  Those ancestors are also expanded, because a match kept behind a fold is a search that
   *  told you the row exists and not where. */
  private seek(query: string): void {
    this.query = query;
    if (query === "") {
      this.status = "nothing to search for";
      return;
    }
    this.expanded = new Set([...this.expanded, ...this.ancestors(query)]);
    this.items = this.itemsOf(this.screen);
    const hits = this.hits();
    if (hits.length === 0) {
      this.cursor = this.cursor;
      this.status = `nothing matches ${query}`;
      return;
    }
    this.cursor = hits[0] as number;
    this.at(hits, 0);
  }

  /** The fold keys of every node above a match, so committing a search opens the branches
   *  its matches hang in and no others. */
  private ancestors(query: string): ReadonlySet<string> {
    const keys = new Set<string>();
    const walk = (nodes: readonly Node[], above: readonly Node[]): boolean => {
      let found = false;
      for (const n of nodes) {
        const under = walk(n.children, [...above, n]);
        if (under || matches(n, query)) {
          for (const a of above) keys.add(nodeKey(a));
          found = true;
        }
      }
      return found;
    };
    walk(this.outlineForest(), []);
    return keys;
  }

  /** Where the matches are among the rows on screen, in the order the outline draws them:
   *  `n` goes down the tree, which is the direction `j` goes. */
  private hits(): number[] {
    return this.items.flatMap((item, i) =>
      item.node !== undefined && matches(item.node, this.query) ? [i] : [],
    );
  }

  /** The next match after the cursor, or the previous one before it, wrapping. Wrapping
   *  rather than stopping: the count is on the line, so you can see you have come round. */
  private jump(by: number): void {
    if (this.screen.kind !== "outline") {
      this.status = `n walks the outline's matches — v ${OUTLINE.key}`;
      return;
    }
    if (this.query === "") {
      this.status = "nothing searched — / searches";
      return;
    }
    const hits = this.hits();
    if (hits.length === 0) {
      this.status = `nothing matches ${this.query}`;
      return;
    }
    const here = this.cursor;
    const past = by > 0 ? hits.find((i) => i > here) : [...hits].reverse().find((i) => i < here);
    const index = past === undefined ? (by > 0 ? 0 : hits.length - 1) : hits.indexOf(past);
    this.cursor = hits[index] as number;
    this.at(hits, index);
  }

  private at(hits: readonly number[], index: number): void {
    this.status = `${index + 1}/${hits.length} matching ${this.query}`;
  }

  /** Open or close the node under the cursor by one level. The rows are rebuilt rather
   *  than a screen pushed, so the cursor stays where it was and esc still means back. */
  private fold(open: boolean): void {
    if (this.screen.kind !== "outline") {
      this.status = `${open ? "+" : "-"} folds the outline — v ${OUTLINE.key}`;
      return;
    }
    const node = this.current()?.node;
    if (node === undefined) return;
    if (open && node.children.length === 0) {
      this.status = `${node.label} has nothing under it`;
      return;
    }
    const keys = new Set(this.expanded);
    if (open) keys.add(nodeKey(node));
    else keys.delete(nodeKey(node));
    this.expanded = keys;
    this.items = this.itemsOf(this.screen);
    this.cursor = this.cursor;
    this.status = "";
  }

  /** Arm the depth keys. `t` is the tree's own letter — the same one `v` opens the outline
   *  with — so `t e` and `t f` read as "the tree, one level further in / out". */
  private armDepth(): void {
    if (this.screen.kind !== "outline") {
      this.status = `t e steps the outline in — v ${OUTLINE.key}`;
      return;
    }
    this.armed = "depth";
    this.status = `depth? e in  f out — ${this.depthNow()}`;
  }

  /** Take the whole tree one level in or out. `+`/`-` open the node under the cursor; these
   *  move every branch at once, because reading a tree a node at a time never ends. */
  private step(k: string): void {
    const by = k === "e" ? +1 : k === "f" ? -1 : 0;
    if (by === 0) {
      this.status = `no depth on ${k}`;
      return;
    }
    const was = openDepth(this.outlineForest(), this.expanded);
    this.expanded = atDepth(this.outlineForest(), this.expanded, by);
    this.items = this.itemsOf(this.screen);
    this.cursor = this.cursor;
    const now = openDepth(this.outlineForest(), this.expanded);
    // Both ends are walls: saying so is the difference between a key that did nothing and
    // a key that is not bound.
    const wall = by > 0 ? "nothing further in" : "nothing further out";
    this.status = now === was ? `${this.depthNow()} — ${wall}` : this.depthNow();
  }

  /** How far open the outline stands, out of how far it goes. */
  private depthNow(): string {
    const forest = this.outlineForest();
    return `depth ${openDepth(forest, this.expanded)}/${treeDepth(forest)}`;
  }

  private openBox(k: string): void {
    if (k === OUTLINE.key) return this.openOutline();
    const view = this.keys.get(k);
    if (view === undefined) {
      this.status = `no box on ${k}`;
      return;
    }
    this.push({ kind: "box", view });
    this.status = view.title;
  }

  /** The approval under the cursor, if the row is one and it is still waiting. An
   *  assignment an agent raised for itself is not one: only a question asked of a person
   *  carries options a key could pick. */
  private approvalHere(): Approval | null {
    const item = this.current();
    if (item === null || item.entity !== "assignment") return null;
    const approval = approvalById(this.db, item.row.id);
    return approval !== null && approval.phase === "waiting" ? approval : null;
  }

  /** `a` on a waiting approval offers its answers rather than the machine's verbs. Both
   *  routes end in `waiting → running`, but only this one writes down what was said and
   *  who said it, and the bare verb would leave the question standing. */
  private armAnswer(approval: Approval): void {
    const options = approval.options;
    if (options === null) {
      this.status = `assignment #${approval.id} asks an open question, and a key is not an answer to one`;
      return;
    }
    this.armed = "answer";
    this.status = `answer? ${options.map((o) => `${o[0]} ${o}`).join("  ")}`;
  }

  /** Answer the approval under the cursor with the option that letter names, in the
   *  answerer's own name. A letter two options share is refused: an answer is a decision
   *  the record keeps, and guessing which one was meant is not available. */
  private say(k: string): void {
    const approval = this.approvalHere();
    const match = (approval?.options ?? []).filter((o) => o.startsWith(k));
    if (approval === null || match.length === 0) {
      this.status = `no answer on ${k}`;
      return;
    }
    if (match.length > 1) {
      this.status = `${k} is ambiguous: ${match.join(", ")}`;
      return;
    }
    const said = match[0] as string;
    const by = whoAnswers();
    try {
      answerApproval(this.db, approval.id, said, by);
      this.status = `assignment #${approval.id} answered ${said} by ${by}`;
    } catch (e) {
      this.status = e instanceof ApprovalError ? e.message : String(e);
    }
    this.refresh();
  }

  private armVerb(): void {
    const approval = this.approvalHere();
    if (approval !== null) return this.armAnswer(approval);
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
    const out = this.invoke(item.entity, verb, item.row.id);
    this.refresh();
    this.status = out.ok
      ? `${item.entity} #${item.row.id} ${verb} → ${out.changes[0]?.to ?? ""}`
      : out.why;
  }

  /** The facade method for a verb the row may take. `verbs()` reads the same table, so a
   *  verb that reaches here always has one. */
  private invoke(entity: StatefulEntity, verb: string, id: number): Outcome {
    const method = METHODS.get(`${entity}.${verb}`);
    if (method === undefined) throw new Error(`no facade method for ${entity}.${verb}`);
    return this.facade[method](id, "operator");
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
    if (screen.kind === "outline") {
      // The head of the queue box is the next task the allocator will take, and the board
      // is where that order is decided. The outline only marks the row it names.
      const now = this.snapshot ?? board(this.db);
      return outlineRows(this.outlineForest(), this.expanded, now.queued[0]?.id ?? null);
    }
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
