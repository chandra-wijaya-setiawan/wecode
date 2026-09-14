import { describe, expect, it } from "vitest";
import { LessonError, Maker, addLesson, dropLesson, lessons } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const attempt = (db: ReturnType<typeof freshDb>, task: number): number => {
  const make = new Maker(db);
  return make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: make.worker("claude-1", "engineer", "agent"),
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 1, seconds: 1 },
    worktree: "/tmp/wt",
  });
};

describe("a lesson", () => {
  it("is kept against the project, with the assignment that learned it", () => {
    const db = freshDb();
    const tree = seed(db);
    const a = attempt(db, tree.task);

    const id = addLesson(db, tree.project, "a fresh worktree needs pnpm -r build first", a);

    expect(lessons(db, tree.project)).toEqual([
      {
        id,
        project_id: tree.project,
        text: "a fresh worktree needs pnpm -r build first",
        assignment_id: a,
        created_at: expect.any(String),
      },
    ]);
  });

  it("has no assignment when nobody attempted anything", () => {
    const db = freshDb();
    const tree = seed(db);
    addLesson(db, tree.project, "the mail host rejects TLS 1.1");

    expect(lessons(db, tree.project)[0]?.assignment_id).toBe(null);
  });

  it("is one line however it arrived", () => {
    const db = freshDb();
    const tree = seed(db);
    addLesson(db, tree.project, "  pnpm install\n  needs   --no-frozen-lockfile here\n");

    expect(lessons(db, tree.project)[0]?.text).toBe("pnpm install needs --no-frozen-lockfile here");
  });

  it("is refused when it says nothing", () => {
    const db = freshDb();
    const tree = seed(db);
    expect(() => addLesson(db, tree.project, "   \n ")).toThrow(LessonError);
  });

  it("cannot be attributed to an attempt that never happened", () => {
    const db = freshDb();
    const tree = seed(db);
    expect(() => addLesson(db, tree.project, "learned by nobody", 404)).toThrow(/FOREIGN KEY/);
  });

  it("is refused against a project that does not exist", () => {
    const db = freshDb();
    seed(db);
    expect(() => addLesson(db, 99, "something")).toThrow(/no project #99/);
  });
});

describe("listing lessons", () => {
  it("is newest first, because that is the order a brief reads them in", () => {
    const db = freshDb();
    const tree = seed(db);
    addLesson(db, tree.project, "oldest");
    addLesson(db, tree.project, "middle");
    addLesson(db, tree.project, "newest");

    expect(lessons(db, tree.project).map((l) => l.text)).toEqual(["newest", "middle", "oldest"]);
  });

  it("takes the newest when a cap is asked for, not the first ones written", () => {
    const db = freshDb();
    const tree = seed(db);
    for (const n of [1, 2, 3, 4, 5]) addLesson(db, tree.project, `lesson ${n}`);

    expect(lessons(db, tree.project, 2).map((l) => l.text)).toEqual(["lesson 5", "lesson 4"]);
  });

  it("shows one project nothing of another's", () => {
    const db = freshDb();
    const tree = seed(db);
    const other = new Maker(db).project(tree.ws, "other", "/other");
    addLesson(db, tree.project, "mine");
    addLesson(db, other, "theirs");

    expect(lessons(db, tree.project).map((l) => l.text)).toEqual(["mine"]);
    expect(lessons(db, other).map((l) => l.text)).toEqual(["theirs"]);
  });

  it("is empty for a project that has learned nothing", () => {
    const db = freshDb();
    expect(lessons(db, seed(db).project)).toEqual([]);
  });
});

describe("dropping a lesson", () => {
  it("takes that one and leaves the rest", () => {
    const db = freshDb();
    const tree = seed(db);
    addLesson(db, tree.project, "keep this");
    const wrong = addLesson(db, tree.project, "this one is wrong");

    expect(dropLesson(db, wrong)).toBe(true);
    expect(lessons(db, tree.project).map((l) => l.text)).toEqual(["keep this"]);
  });

  it("says so when there was no such lesson, rather than pretending", () => {
    const db = freshDb();
    expect(dropLesson(db, 404)).toBe(false);
  });
});
