/** Who is working, what on, and at what cost.
 *
 *  The board answers *what is moving* — its `running` box is one line per assignment, and
 *  the line is sorted by assignment id, so the same agent's two seats can sit pages apart
 *  and nothing anywhere says how much a given worker is spending. This page asks the
 *  question the other way round: the agent is the row, and the work is what hangs under it.
 *
 *  It is the same rows, read through the `board` reading, and never a second query — a
 *  second opinion about who is running is a second board. What a running row carries about
 *  a seat is in its detail, which `core`'s board writes as `<worker> · <minutes>m ·
 *  <thousands>k`; this page reads that back rather than counting anything itself, and a row
 *  whose detail says something else still gets its words, under the unnamed worker.
 *
 *  The board arrives as a function, as every other page's reading does: what is proved here
 *  is the page, and where a workspace is, is `bin.ts`'s.
 *
 *  Every node `packages/webapp/config/ui.yaml` declares under `agents` is drawn here,
 *  carrying its `data-ui` name and the words the definition gives it — the page itself,
 *  the running card with its elapsed, tokens and last said, the chore card with its
 *  elapsed, the idle card and today's. `agents.running.transcript` and `.stop` are not:
 *  both are verbs, and whether this surface acts at all is the operator's to say. */
import type { Board, Row } from "@wecode/core";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { document, shelled } from "./shell.js";

/** This page is a view of what is moving, so it is served the board and not the record. */
export const READS = "board";

/** What the page says when nobody is working. A page that came back blank reads as a page
 *  that failed to draw. */
const NOBODY = "nobody is working right now";

/** The worker a running row names when its detail does not name one. `board()` already
 *  writes `?` for an assignment with no worker on it; a detail in any other shape lands
 *  here too, because an unattributable seat is still a seat somebody is paying for. */
export const UNNAMED = "?";

/** What a declared reading shows when the board holds nothing to read for it. A dash
 *  rather than a zero, for the reason a null minute is not a zero one: nothing measured
 *  is not the same as measured as none. */
export const NOTHING = "—";

/** The three cards the definition declares beside the running one, and the words it gives
 *  them. Every one of them asks the board something the board does not carry — it has no
 *  chore box, no roster of who is not working, and no history of the day — so each is
 *  drawn as the word that says so rather than as an empty list. A node nothing is said
 *  under is a node a reader cannot tell from one that failed to draw.
 *
 *  They are cards in the same list as the running ones because the definition parents all
 *  four to `agents` in one run, and the look gives that list one shape. */
const FLEET: readonly (readonly [string, string, string])[] = [
  ["agents.chore", "chore", "no chore box on the board"],
  ["agents.idle", "Idle", "the board names only who is working"],
  ["agents.today", "Today", "no day on the board — the ledger counts it"],
];

/** One seat: the work an agent has in hand, what it is running as, and what it has cost
 *  so far. The three settings are optional on the board row because older records do not
 *  have them; absence stays absence rather than becoming a page-invented setting. */
export interface Seat {
  readonly id: number;
  readonly what: string;
  readonly phase: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly harness: string | null;
  /** Minutes since the seat was cut, when the row dates it. */
  readonly minutes: number | null;
  /** Thousands of tokens spent, when the row counts them. */
  readonly spent: number | null;
}

type RecordedRow = Row & {
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly harness?: string | null;
};

const recorded = (row: Row, key: "model" | "effort" | "harness"): string | null => {
  const record = row as RecordedRow;
  if (key in record) return typeof record[key] === "string" ? record[key]! : null;
  return new RegExp(`(?:^| · )${key}=([^ ·]+)`).exec(row.detail)?.[1] ?? null;
};

/** One agent, with every seat it is holding. */
export interface Worker {
  readonly name: string;
  readonly seats: readonly Seat[];
  /** What the agent is spending across its seats, in thousands, and how long its oldest
   *  seat has been open. Both are of what the rows say, and both are null when no seat of
   *  the agent says it — a zero would read as measured. */
  readonly spent: number | null;
  readonly minutes: number | null;
  /** The work of the agent's newest seat — the nearest thing the board has to what the
   *  agent last said. A board row carries no transcript, so the objective it was cut
   *  against is what stands in for one. */
  readonly said: string;
}

const number = (said: string | undefined, unit: string): number | null => {
  if (said === undefined || !said.endsWith(unit)) return null;
  const n = Number(said.slice(0, -unit.length));
  return Number.isFinite(n) ? n : null;
};

/** A running row's detail, taken apart: who, how long, how much. */
export function seatOf(row: Row): { readonly worker: string; readonly seat: Seat } {
  const [worker, age, cost] = row.detail.split(" · ");
  return {
    worker: worker === undefined || worker.trim() === "" ? UNNAMED : worker.trim(),
    seat: {
      id: row.id,
      what: row.what,
      phase: row.state,
      model: recorded(row, "model"),
      effort: recorded(row, "effort"),
      harness: recorded(row, "harness"),
      minutes: number(age?.trim(), "m"),
      spent: number(cost?.trim(), "k"),
    },
  };
}

/** Every agent holding a seat, the busiest first and the same name once.
 *
 *  Busiest is by spend, because that is the question the page is for — who is costing what
 *  — and ties go to the name, so the order is the board's own facts and never the order a
 *  map happened to be filled in. */
/** The work of the youngest seat an agent holds — the least minutes open, and the first
 *  of them when no seat is dated. */
const newest = (seats: readonly Seat[]): string =>
  (seats.filter((s) => s.minutes !== null).sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0))[0] ??
    seats[0])?.what ?? NOTHING;

export function workers(board: Board): readonly Worker[] {
  const held = new Map<string, Seat[]>();
  for (const row of board.running) {
    const { worker, seat } = seatOf(row);
    (held.get(worker) ?? (held.set(worker, []), held.get(worker) as Seat[])).push(seat);
  }
  const sum = (said: readonly (number | null)[], of: (a: number, b: number) => number): number | null =>
    said.filter((n): n is number => n !== null).reduce<number | null>((n, m) => (n === null ? m : of(n, m)), null);
  return [...held]
    .map(([name, seats]) => ({
      name,
      seats,
      spent: sum(seats.map((s) => s.spent), (a, b) => a + b),
      minutes: sum(seats.map((s) => s.minutes), Math.max),
      said: newest(seats),
    }))
    .sort((a, b) => (b.spent ?? 0) - (a.spent ?? 0) || a.name.localeCompare(b.name));
}

const setting = (name: "model" | "effort" | "harness", value: string | null): string =>
  value === null ? "" : `<span class="${name}">${escape(value)}</span>`;

const seatLine = (seat: Seat): string =>
  `<li id="seat-${seat.id}"><span class="id">#${seat.id}</span>` +
  `<span class="what">${escape(seat.what)}</span>` +
  `<span class="phase">${escape(seat.phase)}</span>` +
  setting("model", seat.model) +
  setting("effort", seat.effort) +
  setting("harness", seat.harness) +
  (seat.minutes === null ? "" : `<span class="age">${seat.minutes}m</span>`) +
  (seat.spent === null ? "" : `<span class="cost">${seat.spent}k</span>`) +
  `</li>`;

/** One reading of a card, by the name the definition declares it under: the word it is
 *  labelled with, and what the board says for it. It is a row of the card's own list, so
 *  the look already dresses it — the surface gains a reading, not a second shape. */
const reading = (id: string, label: string, said: string, mark: string): string =>
  `<li data-ui="${id}"><span class="what">${label}</span>` +
  `<span class="${mark}">${escape(said)}</span></li>`;

const card = (worker: Worker): string =>
  `<li class="worker" id="worker-${escape(worker.name)}" data-ui="agents.running">` +
  `<span class="name">${escape(worker.name)}</span>` +
  `<span class="seats">${worker.seats.length} working</span>` +
  (worker.spent === null ? "" : `<span class="cost">${worker.spent}k</span>`) +
  (worker.minutes === null ? "" : `<span class="age">${worker.minutes}m</span>`) +
  `<ul class="seats">` +
  reading("agents.running.elapsed", "elapsed", worker.minutes === null ? NOTHING : `${worker.minutes}m`, "age") +
  reading("agents.running.tokens", "tokens", worker.spent === null ? NOTHING : `${worker.spent}k`, "cost") +
  reading("agents.running.last-said", "last said", worker.said, "phase") +
  `${worker.seats.map(seatLine).join("")}</ul></li>`;

/** A card for a reading the board does not carry: its name, the word that says so, and —
 *  for the chore card, which the definition gives an `elapsed` of its own — that row. */
const spare = ([id, name, says]: readonly [string, string, string]): string =>
  `<li class="worker" id="${id.replace(".", "-")}" data-ui="${id}">` +
  `<span class="name">${name}</span><span class="seats">${says}</span>` +
  (id === "agents.chore"
    ? `<ul class="seats">${reading("agents.chore.elapsed", "elapsed", NOTHING, "age")}</ul>`
    : "") +
  `</li>`;

/** What the page says: one card per agent, and nothing around them. The frame is the
 *  shell's, and the heading is an `h2` because the document's one `h1` is the banner.
 *
 *  The whole of it is in one section, which is the shape `look.roots` scopes this page's
 *  rules to. It is a section and not a bare run of elements because a bare `h2` in the
 *  shell's one element is `main > h2`, which is the projects page's root — two pages
 *  drawing one shape is one page's rules reaching the other's markup. */
export function agentsContents(board: Board): string {
  const all = workers(board);
  const inside =
    all.length === 0
      ? `<h2>Agents</h2><p class="empty">${NOBODY}</p>`
      : `<h2>Agents</h2>` +
        `<p class="total">${all.length} working · ${board.running.length} seats · ` +
        `${all.reduce((n, w) => n + (w.spent ?? 0), 0)}k</p>` +
        `<ul class="agents">${all.map(card).join("")}${FLEET.map(spare).join("")}</ul>`;
  return `<section class="agents" data-ui="agents">${inside}</section>`;
}

/** The whole document: what the page says, in the shell design.yaml declares. */
export const agentsPage = (board: Board): Reply => html(document(agentsContents(board)));

/** The page, bound to a way of reading the board now. Read on every request, for the reason
 *  the board is: an agent finishes without anybody reloading. */
export const agentsAt = (read: () => Board): Page => shelled(() => agentsContents(read()));
