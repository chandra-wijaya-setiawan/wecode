/** The running box's head says how many of the fleet's seats are busy.
 *
 *  Every other box's head carries one number, because its rows are only rows: five queued
 *  is five queued whatever the workspace has. A running row is not only a row — it is a
 *  worker held — so `3` there answers half the question an operator came with. Three of
 *  four seats is a workspace with nothing spare and a queue that will not move until
 *  something lands; three of twenty is nineteen workers standing idle and a queue nobody
 *  is feeding. The two call for opposite things, and the old head could not tell them
 *  apart.
 *
 *  Asserted off the rendered frame, and against the words config/design.yaml says the head
 *  is written in, so the drawing and the design cannot drift apart quietly. Those words are
 *  `proposal.head` — the head that opens with the section's mark in column zero and ends in
 *  the count with the box's letter raised onto it. The `── ` head this test used to look
 *  for, and the top-level `head:` block it read, are both retired. */
import { plain } from "./force-color.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit, raised } from "../src/screens.js";
import { sectionMark } from "../src/list.js";
import { loadViews } from "../src/views.js";
import { seed, T, ins } from "./seed.js";

interface Design {
  readonly proposal: {
    readonly head: {
      readonly case: string;
      readonly line: string;
      readonly count: string;
      readonly seated: { readonly box: string; readonly of: string; readonly count: string };
      readonly keys: { readonly sections: Record<string, string> };
    };
  };
}

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Design;

const HEAD = design.proposal.head;

/** The proposal names two sections in shorter words than views.yaml does, so the box the
 *  fraction is on is read through that mapping rather than assumed to be a view's name. */
const boxed = (box: string): string => HEAD.keys.sections[box] ?? box;

const SEATED = boxed(HEAD.seated.box);

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

const WIDTH = 100;

const lines = (): string[] =>
  plain(render(createElement(Cockpit, { app, width: WIDTH, height: 90 })).lastFrame() ?? "").split("\n");

/** How the design opens a head: the section's mark in column zero, then its name in
 *  capitals. There are no dashes on either side of it any more. */
const opening = (name: string, title: string): string =>
  HEAD.line
    .replace("{mark}", sectionMark(name))
    .replace("{title}", HEAD.case === "upper" ? title.toUpperCase() : title);

/** The head of the box named `name`, found by that opening. */
const head = (name: string): string => {
  const view = views.find((v) => v.name === name);
  expect(view, `no view ${name}`).toBeDefined();
  const opens = opening(name, view?.title ?? "");
  const at = lines().find((l) => l.startsWith(opens));
  expect(at, `no section headed ${opens}`).toBeDefined();
  return at as string;
};

const keyOf = (name: string): string => views.find((v) => v.name === name)?.key ?? "";

/** A worker is a seat, whatever role it is of and whatever it is doing. */
const worker = (slug: string, role = "engineer"): number =>
  ins(db, "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)", slug, slug, role, "agent", T, T);

/** An assignment in flight, which is what puts a row in the running box. */
const running = (slug: string, workerId: number): number =>
  ins(
    db,
    "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    slug, "task", tree.task, workerId, "{}", "{}", `/tmp/${slug}`, "running", "{}", T, T,
  );

/** What a head ends in: the count, with the letter that opens the box raised onto it. */
const ends = (name: string, count: string): string =>
  HEAD.count.replace("{count}", count).replace("{key}", raised(keyOf(name)));

/** What the seated head ends in when it says `held` of `seats`. */
const fraction = (held: number, seats: number): string =>
  ends(SEATED, HEAD.seated.count.replace("{held}", String(held)).replace("{seats}", String(seats)));

/** What a plain head ends in: the one number every other box says. */
const plainCount = (name: string, n: number): string => ends(name, String(n));

const held = (name: string): number => {
  const view = views.find((v) => v.name === name);
  const board = app.boardNow() as unknown as Record<string, readonly unknown[]>;
  return (board[view?.filter ?? ""] ?? []).length;
};

describe("the running head", () => {
  it("says how many of the fleet's seats its rows are holding", () => {
    worker("eng-1");
    worker("eng-2");
    worker("rev-1", "reviewer");
    running("a", worker("eng-3"));
    running("b", worker("eng-4"));
    app.refresh();

    expect(held(SEATED)).toBe(2);
    const line = head(SEATED);
    expect(line).toHaveLength(WIDTH);
    expect(line.endsWith(fraction(2, 5)), line).toBe(true);
  });

  it("counts a seat the fleet has and nobody is sitting in", () => {
    worker("eng-1");
    worker("eng-2");
    app.refresh();

    expect(held(SEATED)).toBe(0);
    expect(head(SEATED).endsWith(fraction(0, 2))).toBe(true);
  });

  it("counts every seat, whatever role it is of — a seat is a worker", () => {
    worker("eng-1");
    worker("rev-1", "reviewer");
    worker("at-1", "acceptance-tester");
    running("a", worker("eng-2"));
    app.refresh();

    expect(head(SEATED).endsWith(fraction(1, 4))).toBe(true);
  });

  it("falls back to the plain count where there is no fleet to be short of", () => {
    // Nothing is enrolled, so nothing can be running either: a fraction here would be
    // `0/0`, which reads as a workspace at capacity rather than one with no workers.
    app.refresh();

    expect(head(SEATED).endsWith(plainCount(SEATED, held(SEATED)))).toBe(true);
  });

  it("is the only head that says a fraction: every other box's rows hold no seat", () => {
    worker("eng-1");
    worker("eng-2");
    app.refresh();

    for (const view of views) {
      if (view.name === SEATED) continue;
      const line = head(view.name);
      expect(line.endsWith(plainCount(view.name, held(view.name))), `${view.title}: ${line}`).toBe(true);
    }
  });
});
