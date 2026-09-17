// Generated from packages/core/config/machines.yaml by facade-gen.ts. Do not edit:
// facade.test.ts regenerates this file and fails on any difference.
//
// One method per transition an actor may invoke. An automatic transition gets none —
// nobody invokes it, so the facade offers no way to spell it.

import type { Engine, Outcome } from "./apply.js";
import type { FacadeTransition } from "./facade-gen.js";

export type ProjectState = "planned" | "in_progress" | "on_hold" | "dropped";
export type ReleaseState = "planned" | "in_progress" | "released" | "dropped";
export type EpicState = "planned" | "in_progress" | "on_hold" | "delivered" | "dropped";
export type StoryState = "planned" | "in_progress" | "on_hold" | "delivered" | "dropped";
export type RequirementState = "planned" | "in_progress" | "on_hold" | "met" | "dropped";
export type AcceptanceCriteriaState = "planned" | "in_progress" | "accepted" | "dropped";
export type AcceptanceTestState = "planned" | "ready" | "passed" | "failed" | "dropped";
export type TaskTestState = "planned" | "ready" | "passed" | "failed" | "dropped";
export type TaskState = "planned" | "ready" | "done" | "failed" | "dropped";
export type AssignmentState = "pending" | "running" | "waiting" | "succeeded" | "failed";

/** Every verb of the record, one method each. A method exists exactly when the machine
 *  table has a transition an actor may invoke, and it can say nothing else. */
export class Verbs {
  constructor(private readonly engine: Engine) {}

  /** project: planned → in_progress */
  startProject(id: number, actor: string): Outcome {
    return this.engine.apply("project", id, "start", actor);
  }

  /** project: in_progress → on_hold */
  holdProject(id: number, actor: string): Outcome {
    return this.engine.apply("project", id, "hold", actor);
  }

  /** project: on_hold, dropped → in_progress */
  reopenProject(id: number, actor: string): Outcome {
    return this.engine.apply("project", id, "reopen", actor);
  }

  /** project: planned, in_progress, on_hold → dropped */
  dropProject(id: number, actor: string): Outcome {
    return this.engine.apply("project", id, "drop", actor);
  }

  /** release: planned → in_progress */
  startRelease(id: number, actor: string): Outcome {
    return this.engine.apply("release", id, "start", actor);
  }

  /** release: in_progress → released */
  releaseRelease(id: number, actor: string): Outcome {
    return this.engine.apply("release", id, "release", actor);
  }

  /** release: dropped → in_progress */
  reopenRelease(id: number, actor: string): Outcome {
    return this.engine.apply("release", id, "reopen", actor);
  }

  /** release: planned, in_progress → dropped */
  dropRelease(id: number, actor: string): Outcome {
    return this.engine.apply("release", id, "drop", actor);
  }

  /** epic: planned → in_progress */
  startEpic(id: number, actor: string): Outcome {
    return this.engine.apply("epic", id, "start", actor);
  }

  /** epic: in_progress → on_hold */
  holdEpic(id: number, actor: string): Outcome {
    return this.engine.apply("epic", id, "hold", actor);
  }

  /** epic: on_hold, delivered, dropped → in_progress */
  reopenEpic(id: number, actor: string): Outcome {
    return this.engine.apply("epic", id, "reopen", actor);
  }

  /** epic: planned, in_progress, on_hold → dropped */
  dropEpic(id: number, actor: string): Outcome {
    return this.engine.apply("epic", id, "drop", actor);
  }

  /** story: planned → in_progress */
  startStory(id: number, actor: string): Outcome {
    return this.engine.apply("story", id, "start", actor);
  }

  /** story: in_progress → on_hold */
  holdStory(id: number, actor: string): Outcome {
    return this.engine.apply("story", id, "hold", actor);
  }

  /** story: on_hold, delivered, dropped → in_progress */
  reopenStory(id: number, actor: string): Outcome {
    return this.engine.apply("story", id, "reopen", actor);
  }

  /** story: planned, in_progress, on_hold → dropped */
  dropStory(id: number, actor: string): Outcome {
    return this.engine.apply("story", id, "drop", actor);
  }

  /** requirement: planned → in_progress */
  startRequirement(id: number, actor: string): Outcome {
    return this.engine.apply("requirement", id, "start", actor);
  }

  /** requirement: in_progress → on_hold */
  holdRequirement(id: number, actor: string): Outcome {
    return this.engine.apply("requirement", id, "hold", actor);
  }

  /** requirement: on_hold, met, dropped → in_progress */
  reopenRequirement(id: number, actor: string): Outcome {
    return this.engine.apply("requirement", id, "reopen", actor);
  }

  /** requirement: planned, in_progress, on_hold → dropped */
  dropRequirement(id: number, actor: string): Outcome {
    return this.engine.apply("requirement", id, "drop", actor);
  }

  /** acceptance_criteria: planned → in_progress */
  startAcceptanceCriteria(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_criteria", id, "start", actor);
  }

  /** acceptance_criteria: accepted, dropped → in_progress */
  reopenAcceptanceCriteria(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_criteria", id, "reopen", actor);
  }

  /** acceptance_criteria: planned, in_progress → dropped */
  dropAcceptanceCriteria(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_criteria", id, "drop", actor);
  }

  /** acceptance_test: planned → ready */
  deliverAcceptanceTest(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_test", id, "deliver", actor);
  }

  /** acceptance_test: ready, failed → passed */
  passAcceptanceTest(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_test", id, "pass", actor);
  }

  /** acceptance_test: ready, failed → failed */
  failAcceptanceTest(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_test", id, "fail", actor);
  }

  /** acceptance_test: failed → ready */
  reproveAcceptanceTest(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_test", id, "reprove", actor);
  }

  /** acceptance_test: passed → ready */
  invalidateAcceptanceTest(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_test", id, "invalidate", actor);
  }

  /** acceptance_test: planned, ready, failed → dropped */
  dropAcceptanceTest(id: number, actor: string): Outcome {
    return this.engine.apply("acceptance_test", id, "drop", actor);
  }

  /** task_test: planned → ready */
  deliverTaskTest(id: number, actor: string): Outcome {
    return this.engine.apply("task_test", id, "deliver", actor);
  }

  /** task_test: ready, failed → passed */
  passTaskTest(id: number, actor: string): Outcome {
    return this.engine.apply("task_test", id, "pass", actor);
  }

  /** task_test: ready, failed → failed */
  failTaskTest(id: number, actor: string): Outcome {
    return this.engine.apply("task_test", id, "fail", actor);
  }

  /** task_test: failed → ready */
  reproveTaskTest(id: number, actor: string): Outcome {
    return this.engine.apply("task_test", id, "reprove", actor);
  }

  /** task_test: passed → ready */
  invalidateTaskTest(id: number, actor: string): Outcome {
    return this.engine.apply("task_test", id, "invalidate", actor);
  }

  /** task_test: planned, ready, failed → dropped */
  dropTaskTest(id: number, actor: string): Outcome {
    return this.engine.apply("task_test", id, "drop", actor);
  }

  /** task: planned → ready */
  startTask(id: number, actor: string): Outcome {
    return this.engine.apply("task", id, "start", actor);
  }

  /** task: ready → failed */
  giveUpTask(id: number, actor: string): Outcome {
    return this.engine.apply("task", id, "give_up", actor);
  }

  /** task: failed → ready */
  retryTask(id: number, actor: string): Outcome {
    return this.engine.apply("task", id, "retry", actor);
  }

  /** task: planned, ready, failed → dropped */
  dropTask(id: number, actor: string): Outcome {
    return this.engine.apply("task", id, "drop", actor);
  }

  /** assignment: pending → running */
  startAssignment(id: number, actor: string): Outcome {
    return this.engine.apply("assignment", id, "start", actor);
  }

  /** assignment: pending → waiting */
  raiseAssignment(id: number, actor: string): Outcome {
    return this.engine.apply("assignment", id, "raise", actor);
  }

  /** assignment: running → waiting */
  askAssignment(id: number, actor: string): Outcome {
    return this.engine.apply("assignment", id, "ask", actor);
  }

  /** assignment: waiting → running */
  answerAssignment(id: number, actor: string): Outcome {
    return this.engine.apply("assignment", id, "answer", actor);
  }

  /** assignment: running → succeeded */
  finishAssignment(id: number, actor: string): Outcome {
    return this.engine.apply("assignment", id, "finish", actor);
  }

  /** assignment: pending, running, waiting → failed */
  failAssignment(id: number, actor: string): Outcome {
    return this.engine.apply("assignment", id, "fail", actor);
  }
}

/** The machine table as the facade read it. Held against machines.yaml by a test, so a
 *  transition added to the config and not to the facade is a red test, not a gap. */
export const TRANSITIONS: readonly FacadeTransition[] = [
  { entity: "project", verb: "start", from: ["planned"], to: "in_progress", method: "startProject" },
  { entity: "project", verb: "hold", from: ["in_progress"], to: "on_hold", method: "holdProject" },
  { entity: "project", verb: "reopen", from: ["on_hold", "dropped"], to: "in_progress", method: "reopenProject" },
  { entity: "project", verb: "drop", from: ["planned", "in_progress", "on_hold"], to: "dropped", method: "dropProject" },
  { entity: "release", verb: "start", from: ["planned"], to: "in_progress", method: "startRelease" },
  { entity: "release", verb: "release", from: ["in_progress"], to: "released", method: "releaseRelease" },
  { entity: "release", verb: "reopen", from: ["dropped"], to: "in_progress", method: "reopenRelease" },
  { entity: "release", verb: "drop", from: ["planned", "in_progress"], to: "dropped", method: "dropRelease" },
  { entity: "epic", verb: "start", from: ["planned"], to: "in_progress", method: "startEpic" },
  { entity: "epic", verb: "hold", from: ["in_progress"], to: "on_hold", method: "holdEpic" },
  { entity: "epic", verb: "reopen", from: ["on_hold", "delivered", "dropped"], to: "in_progress", method: "reopenEpic" },
  { entity: "epic", verb: "deliver", from: ["in_progress"], to: "delivered", method: null },
  { entity: "epic", verb: "drop", from: ["planned", "in_progress", "on_hold"], to: "dropped", method: "dropEpic" },
  { entity: "story", verb: "start", from: ["planned"], to: "in_progress", method: "startStory" },
  { entity: "story", verb: "hold", from: ["in_progress"], to: "on_hold", method: "holdStory" },
  { entity: "story", verb: "reopen", from: ["on_hold", "delivered", "dropped"], to: "in_progress", method: "reopenStory" },
  { entity: "story", verb: "deliver", from: ["in_progress"], to: "delivered", method: null },
  { entity: "story", verb: "drop", from: ["planned", "in_progress", "on_hold"], to: "dropped", method: "dropStory" },
  { entity: "requirement", verb: "start", from: ["planned"], to: "in_progress", method: "startRequirement" },
  { entity: "requirement", verb: "hold", from: ["in_progress"], to: "on_hold", method: "holdRequirement" },
  { entity: "requirement", verb: "reopen", from: ["on_hold", "met", "dropped"], to: "in_progress", method: "reopenRequirement" },
  { entity: "requirement", verb: "meet", from: ["in_progress"], to: "met", method: null },
  { entity: "requirement", verb: "drop", from: ["planned", "in_progress", "on_hold"], to: "dropped", method: "dropRequirement" },
  { entity: "acceptance_criteria", verb: "start", from: ["planned"], to: "in_progress", method: "startAcceptanceCriteria" },
  { entity: "acceptance_criteria", verb: "accept", from: ["in_progress"], to: "accepted", method: null },
  { entity: "acceptance_criteria", verb: "reopen", from: ["accepted", "dropped"], to: "in_progress", method: "reopenAcceptanceCriteria" },
  { entity: "acceptance_criteria", verb: "drop", from: ["planned", "in_progress"], to: "dropped", method: "dropAcceptanceCriteria" },
  { entity: "acceptance_test", verb: "deliver", from: ["planned"], to: "ready", method: "deliverAcceptanceTest" },
  { entity: "acceptance_test", verb: "pass", from: ["ready", "failed"], to: "passed", method: "passAcceptanceTest" },
  { entity: "acceptance_test", verb: "fail", from: ["ready", "failed"], to: "failed", method: "failAcceptanceTest" },
  { entity: "acceptance_test", verb: "reprove", from: ["failed"], to: "ready", method: "reproveAcceptanceTest" },
  { entity: "acceptance_test", verb: "invalidate", from: ["passed"], to: "ready", method: "invalidateAcceptanceTest" },
  { entity: "acceptance_test", verb: "drop", from: ["planned", "ready", "failed"], to: "dropped", method: "dropAcceptanceTest" },
  { entity: "task_test", verb: "deliver", from: ["planned"], to: "ready", method: "deliverTaskTest" },
  { entity: "task_test", verb: "pass", from: ["ready", "failed"], to: "passed", method: "passTaskTest" },
  { entity: "task_test", verb: "fail", from: ["ready", "failed"], to: "failed", method: "failTaskTest" },
  { entity: "task_test", verb: "reprove", from: ["failed"], to: "ready", method: "reproveTaskTest" },
  { entity: "task_test", verb: "invalidate", from: ["passed"], to: "ready", method: "invalidateTaskTest" },
  { entity: "task_test", verb: "drop", from: ["planned", "ready", "failed"], to: "dropped", method: "dropTaskTest" },
  { entity: "task", verb: "start", from: ["planned"], to: "ready", method: "startTask" },
  { entity: "task", verb: "finish", from: ["ready"], to: "done", method: null },
  { entity: "task", verb: "give_up", from: ["ready"], to: "failed", method: "giveUpTask" },
  { entity: "task", verb: "retry", from: ["failed"], to: "ready", method: "retryTask" },
  { entity: "task", verb: "drop", from: ["planned", "ready", "failed"], to: "dropped", method: "dropTask" },
  { entity: "assignment", verb: "start", from: ["pending"], to: "running", method: "startAssignment" },
  { entity: "assignment", verb: "raise", from: ["pending"], to: "waiting", method: "raiseAssignment" },
  { entity: "assignment", verb: "ask", from: ["running"], to: "waiting", method: "askAssignment" },
  { entity: "assignment", verb: "answer", from: ["waiting"], to: "running", method: "answerAssignment" },
  { entity: "assignment", verb: "finish", from: ["running"], to: "succeeded", method: "finishAssignment" },
  { entity: "assignment", verb: "fail", from: ["pending", "running", "waiting"], to: "failed", method: "failAssignment" },
];
