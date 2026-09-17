/** Answering an approval from the needs-you panel, by key.
 *
 *  What each test here can only pass when the work is done: the letters offered are the
 *  approval's own options rather than the machine's verbs, the answer reaches the record
 *  with a name on it, and a letter that names two options is refused rather than guessed.
 *  A test that only asserted the status line changed would pass against a typo. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine, loadMachines, Maker, open, raiseApproval, approvalById, Verbs } from "@wecode/core";
import { App } from "../src/app.js";
import { loadViews } from "../src/views.js";
import { seed } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

/** A person to answer and an agent to ask. */
const cast = (d: DatabaseSync) => {
  const make = new Maker(d);
  make.role("operator", { write: [], tools: [] }, "human");
  make.role("engineer", { write: ["src/**"], tools: ["bash"] }, "agent");
  return {
    // The default name the cockpit answers as, and one other person, so a test can tell
    // the two apart rather than pass on whichever happens to be there.
    operator: make.worker("operator", "operator", "human"),
    dana: make.worker("dana", "operator", "human"),
    claude: make.worker("claude", "engineer", "agent"),
  };
};

const ask = (worker: number, options?: readonly string[]) =>
  raiseApproval(db, {
    objective_type: "task",
    objective_id: tree.task,
    worker_id: worker,
    question: "ship the reset mail to production?",
    ...(options === undefined ? {} : { options }),
  });

/** Put the cursor on the dashboard row for this assignment. */
const onRow = (id: number): void => {
  const at = app.lines().findIndex((r) => r.id === id && r.detail.includes("ship the reset"));
  expect(at, `no needs-you row for #${id}`).toBeGreaterThanOrEqual(0);
  app.cursor = at;
};

const ledgerOf = (id: number) =>
  db
    .prepare(
      "SELECT verb, to_state, actor FROM ledger WHERE entity = 'assignment' AND entity_id = ? ORDER BY id",
    )
    .all(id) as { verb: string; to_state: string; actor: string }[];

const was = process.env["WECODE_ACTOR"];

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  delete process.env["WECODE_ACTOR"];
});

afterEach(() => {
  if (was === undefined) delete process.env["WECODE_ACTOR"];
  else process.env["WECODE_ACTOR"] = was;
});

describe("a waiting approval offers its answers, not the machine's verbs", () => {
  it("arms the options by their initial", () => {
    const { dana } = cast(db);
    const approval = ask(dana, ["ship", "hold"]);
    app = new App(db, views, machines);
    onRow(approval.id);

    app.key("a");

    expect(app.status).toBe("answer? s ship  h hold");
  });

  it("leaves an assignment that is not an approval on the verb route", () => {
    const { claude } = cast(db);
    const make = new Maker(db);
    const id = make.assignment({
      objective_type: "task",
      objective_id: tree.task,
      worker_id: claude,
      scope: { write: ["src/**"], tools: ["bash"] },
      budget: { tokens: 1, seconds: 1 },
      worktree: "",
    });
    const verbs = new Verbs(new Engine(db, machines));
    expect(verbs.startAssignment(id, "wecode").ok).toBe(true);
    expect(verbs.askAssignment(id, "claude").ok).toBe(true);
    app = new App(db, views, machines);
    const at = app.lines().findIndex((r) => r.id === id && r.what === `task #${tree.task}`);
    expect(at).toBeGreaterThanOrEqual(0);
    app.cursor = at;

    app.key("a");

    expect(app.status.startsWith("verb? ")).toBe(true);
  });

  it("refuses an open question, because a key cannot type one", () => {
    const { dana } = cast(db);
    const approval = ask(dana);
    app = new App(db, views, machines);
    onRow(approval.id);

    app.key("a");

    expect(app.status).toBe(
      `assignment #${approval.id} asks an open question, and a key is not an answer to one`,
    );

    // Nothing was armed, so the next letter is just a letter.
    app.key("s");
    expect(app.status).toBe("s does nothing here");
    expect(approvalById(db, approval.id)?.answer).toBeNull();
  });
});

describe("the key answers, and the record keeps who pressed it", () => {
  it("writes the answer, the answerer and the ledger line, and closes the question", () => {
    const { dana } = cast(db);
    const approval = ask(dana, ["ship", "hold"]);
    app = new App(db, views, machines);
    onRow(approval.id);

    app.key("a");
    app.key("h");

    expect(approvalById(db, approval.id)).toMatchObject({
      answer: "hold",
      answered_by: "operator",
      phase: "succeeded",
    });
    expect(ledgerOf(approval.id).map((l) => [l.verb, l.actor])).toContainEqual([
      "answer",
      "operator",
    ]);
    expect(app.status).toBe(`assignment #${approval.id} answered hold by operator`);
  });

  it("takes the row out of the needs-you panel it was answered from", () => {
    const { dana } = cast(db);
    const approval = ask(dana, ["ship", "hold"]);
    app = new App(db, views, machines);
    onRow(approval.id);
    expect(app.boardNow().needs_human.map((r) => r.id)).toContain(approval.id);

    app.key("a");
    app.key("s");

    expect(app.boardNow().needs_human.map((r) => r.id)).not.toContain(approval.id);
  });

  it("answers in the name the environment gives, not the default one", () => {
    const make = new Maker(db);
    make.role("operator", { write: [], tools: [] }, "human");
    const dana = make.worker("dana", "operator", "human");
    process.env["WECODE_ACTOR"] = "dana";
    const approval = ask(dana, ["ship", "hold"]);
    app = new App(db, views, machines);
    onRow(approval.id);

    app.key("a");
    app.key("s");

    expect(approvalById(db, approval.id)?.answered_by).toBe("dana");
    expect(ledgerOf(approval.id).map((l) => l.actor)).toContain("dana");
  });

  it("says why nothing happened when the answerer is nobody the record knows", () => {
    const { dana } = cast(db);
    process.env["WECODE_ACTOR"] = "nobody";
    const approval = ask(dana, ["ship", "hold"]);
    app = new App(db, views, machines);
    onRow(approval.id);

    app.key("a");
    app.key("s");

    expect(app.status).toContain("not a human worker");
    expect(approvalById(db, approval.id)?.answer).toBeNull();
  });
});

describe("a letter that names two answers is refused", () => {
  it("names both rather than picking one", () => {
    const { dana } = cast(db);
    const approval = ask(dana, ["ship", "shelve"]);
    app = new App(db, views, machines);
    onRow(approval.id);

    app.key("a");
    app.key("s");

    expect(app.status).toBe("s is ambiguous: ship, shelve");
    expect(approvalById(db, approval.id)?.answer).toBeNull();
  });

  it("refuses a letter no option starts with", () => {
    const { dana } = cast(db);
    const approval = ask(dana, ["ship", "hold"]);
    app = new App(db, views, machines);
    onRow(approval.id);

    app.key("a");
    app.key("z");

    expect(app.status).toBe("no answer on z");
    expect(approvalById(db, approval.id)?.answer).toBeNull();
  });
});
