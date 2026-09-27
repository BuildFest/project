import { describe, expect, it } from "vitest";
import { AGENT_ACTOR, applyStatusMoves, batchTimelineText, decideStatusMoves } from "../../src/analysis/planSync.js";
import type { DerivedTaskState, EventTaskLink } from "../../src/analysis/types.js";
import { event, hoursAfter, T0, task } from "./fixtures.js";

function state(overrides: Partial<DerivedTaskState> & Pick<DerivedTaskState, "task_id">): DerivedTaskState {
  const status = overrides.effective_status ?? overrides.computed_status ?? "in_progress";
  return {
    computed_status: status,
    override_status: null,
    effective_status: status,
    confidence: 0.7,
    evidence_event_ids: [],
    last_activity_at: null,
    blocking_task_ids: [],
    explanation: "Linked work exists on pc-1-auth",
    computation_method: "rules",
    ...overrides,
  };
}

function link(event_id: string, overrides: Partial<EventTaskLink> = {}): EventTaskLink {
  return { event_id, task_id: "t1", method: "task_key", confidence: 1, status: "confirmed", is_primary: true, ...overrides };
}

const commit = event({ event_id: "e_commit", event_type: "commit", branch: "pc-1-auth" });
const merged = event({
  event_id: "e_merged",
  event_type: "pull_request_merged",
  occurred_at: hoursAfter(T0, 2),
  pull_request: { number: 7, title: "Auth", state: "merged", head_branch: "pc-1-auth", base_branch: "main", merged: true },
});

describe("decideStatusMoves", () => {
  it("starts a task when strongly linked work exists", () => {
    const moves = decideStatusMoves({
      tasks: [task({ task_id: "t1", task_key: "PC-1" })],
      states: [state({ task_id: "t1" })],
      links: [link("e_commit")],
      events: [commit],
    });
    expect(moves).toEqual([{
      task_id: "t1", task_key: "PC-1", from: "not_started", to: "in_progress",
      reason: "Linked work exists on pc-1-auth", evidence_event_ids: ["e_commit"],
    }]);
  });

  it("completes a task when its strongly linked PR was merged", () => {
    const moves = decideStatusMoves({
      tasks: [task({ task_id: "t1", task_key: "PC-1" })],
      states: [state({ task_id: "t1", effective_status: "complete" })],
      links: [link("e_commit"), link("e_merged", { method: "llm", status: "suggested", confidence: 0.95 })],
      events: [commit, merged],
    });
    expect(moves).toMatchObject([{ to: "complete", reason: "PR #7 was merged", evidence_event_ids: ["e_merged"] }]);
  });

  it("only starts a task whose merge is weakly linked", () => {
    const moves = decideStatusMoves({
      tasks: [task({ task_id: "t1", task_key: "PC-1" })],
      states: [state({ task_id: "t1", effective_status: "complete" })],
      links: [link("e_commit"), link("e_merged", { method: "llm", status: "suggested", confidence: 0.85 })],
      events: [commit, merged],
    });
    expect(moves).toMatchObject([{ from: "not_started", to: "in_progress", reason: "Linked work exists" }]);
  });

  it("moves a task the agent itself started", () => {
    const moves = decideStatusMoves({
      tasks: [task({ task_id: "t1", task_key: "PC-1", plan_status: "in_progress", plan_status_set_by: AGENT_ACTOR })],
      states: [state({ task_id: "t1", effective_status: "complete" })],
      links: [link("e_merged")],
      events: [merged],
    });
    expect(moves).toMatchObject([{ from: "in_progress", to: "complete" }]);
  });

  it("never overrides a status a person set", () => {
    expect(decideStatusMoves({
      tasks: [task({ task_id: "t1", task_key: "PC-1", plan_status_set_by: "team" })],
      states: [state({ task_id: "t1", effective_status: "complete" })],
      links: [link("e_merged")],
      events: [merged],
    })).toEqual([]);
  });

  it("never moves a task backwards or out of blocked, complete or cancelled", () => {
    for (const plan_status of ["in_progress", "blocked", "complete", "cancelled"] as const) {
      expect(decideStatusMoves({
        tasks: [task({ task_id: "t1", task_key: "PC-1", plan_status })],
        states: [state({ task_id: "t1", effective_status: plan_status === "in_progress" ? "not_started" : "in_progress" })],
        links: [link("e_commit")],
        events: [commit],
      })).toEqual([]);
    }
  });

  it("ignores weak or rejected links", () => {
    expect(decideStatusMoves({
      tasks: [task({ task_id: "t1", task_key: "PC-1" })],
      states: [state({ task_id: "t1" })],
      links: [link("e_commit", { method: "llm", status: "suggested", confidence: 0.85 }), link("e_merged", { status: "rejected" })],
      events: [commit, merged],
    })).toEqual([]);
  });

  it("leaves tasks with a human state override alone", () => {
    expect(decideStatusMoves({
      tasks: [task({ task_id: "t1", task_key: "PC-1" })],
      states: [state({ task_id: "t1", override_status: "in_progress", effective_status: "in_progress" })],
      links: [link("e_commit")],
      events: [commit],
    })).toEqual([]);
  });

  it("starts a task blocked by a dependency but not one caught in a cycle", () => {
    const tasks = [task({ task_id: "t1", task_key: "PC-1" })];
    const links = [link("e_commit")];
    expect(decideStatusMoves({
      tasks, links, events: [commit],
      states: [state({ task_id: "t1", effective_status: "possibly_blocked", explanation: "Blocked by PC-2 Schema (not started)" })],
    })).toMatchObject([{ to: "in_progress" }]);
    expect(decideStatusMoves({
      tasks, links, events: [commit],
      states: [state({ task_id: "t1", effective_status: "possibly_blocked", explanation: "Dependency cycle involving PC-2" })],
    })).toEqual([]);
  });
});

describe("applyStatusMoves", () => {
  it("returns the tasks as they will be after the moves", () => {
    const tasks = [task({ task_id: "t1", task_key: "PC-1" }), task({ task_id: "t2", task_key: "PC-2" })];
    const moved = applyStatusMoves(tasks, [{
      task_id: "t1", task_key: "PC-1", from: "not_started", to: "complete", reason: "", evidence_event_ids: [],
    }]);
    expect(moved.map((t) => [t.plan_status, t.plan_status_set_by ?? null])).toEqual([["complete", AGENT_ACTOR], ["not_started", null]]);
    expect(tasks[0].plan_status).toBe("not_started");
  });
});

describe("batchTimelineText", () => {
  it("names a single move and summarizes several by status in task-key order", () => {
    expect(batchTimelineText([{ task_key: "PC-6", to: "complete" }])).toEqual({
      title: "Planning agent moved PC-6 to Complete", summary: "Complete: PC-6",
    });
    expect(batchTimelineText([
      { task_key: "PC-12", to: "in_progress" }, { task_key: "PC-6", to: "complete" }, { task_key: "PC-2", to: "in_progress" },
    ])).toEqual({ title: "Planning agent updated 3 tasks", summary: "In progress: PC-2, PC-12 · Complete: PC-6" });
  });
});
