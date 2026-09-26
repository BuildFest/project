import { describe, expect, it } from "vitest";
import { deriveTaskStates, MAX_EVIDENCE_EVENTS } from "../../src/analysis/state.js";
import type { BranchState, EventTaskLink, GithubEvent, TaskDependency } from "../../src/analysis/types.js";
import { event, hoursAfter, task, T0 } from "./fixtures.js";

function link(event_id: string, task_id: string, overrides: Partial<EventTaskLink> = {}): EventTaskLink {
  return {
    event_id,
    task_id,
    method: "task_key",
    confidence: 1,
    status: "confirmed",
    is_primary: true,
    ...overrides,
  };
}

function branch(task_id: string, overrides: Partial<BranchState> = {}): BranchState {
  return {
    repository_id: "repo_1",
    branch: "feature",
    status: "active",
    task_id,
    open_pr_number: null,
    last_activity_at: T0,
    ...overrides,
  };
}

function derive(
  tasks = [task({ task_id: "a", task_key: "PC-1" })],
  events: GithubEvent[] = [],
  links: EventTaskLink[] = [],
  dependencies: TaskDependency[] = [],
  branches: BranchState[] = [],
) {
  return deriveTaskStates({ tasks, events, links, dependencies, branches });
}

describe("deriveTaskStates", () => {
  it("returns not started with no evidence and excludes archived or cancelled tasks", () => {
    const states = derive([
      task({ task_id: "a", task_key: "PC-1" }),
      task({ task_id: "old", task_key: "PC-2", archived: true }),
      task({ task_id: "cancelled", task_key: "PC-3", plan_status: "cancelled" }),
    ]);
    expect(states).toEqual([
      expect.objectContaining({
        task_id: "a",
        computed_status: "not_started",
        effective_status: "not_started",
        confidence: 0.9,
        evidence_event_ids: [],
      }),
    ]);
  });

  it("uses linked commits as in-progress evidence and caps evidence newest first", () => {
    const events = Array.from({ length: MAX_EVIDENCE_EVENTS + 2 }, (_, index) =>
      event({
        event_id: `e${index}`,
        event_type: "commit",
        occurred_at: hoursAfter(T0, index),
        branch: "feature",
      }),
    );
    const [state] = derive(undefined, events, events.map((item) => link(item.event_id, "a")));
    expect(state).toMatchObject({ computed_status: "in_progress", confidence: 0.7 });
    expect(state.evidence_event_ids).toHaveLength(MAX_EVIDENCE_EVENTS);
    expect(state.evidence_event_ids.slice(0, 2)).toEqual([`e${MAX_EVIDENCE_EVENTS + 1}`, `e${MAX_EVIDENCE_EVENTS}`]);
    expect(state.last_activity_at).toEqual(hoursAfter(T0, MAX_EVIDENCE_EVENTS + 1));
  });

  it("uses lower confidence for branchless commit-only evidence", () => {
    const commit = event({ event_id: "commit", event_type: "commit", branch: null });
    expect(derive(undefined, [commit], [link("commit", "a")])[0]).toMatchObject({
      computed_status: "in_progress",
      confidence: 0.5,
    });
  });

  it("counts confirmed links and high-confidence AI suggestions only", () => {
    const events = ["confirmed", "high", "low", "rejected"].map((id, index) =>
      event({ event_id: id, event_type: "commit", occurred_at: hoursAfter(T0, index) }),
    );
    const links = [
      link("confirmed", "a", { method: "manual", confidence: 0.1 }),
      link("high", "a", { method: "llm", status: "suggested", confidence: 0.8 }),
      link("low", "a", { method: "llm", status: "suggested", confidence: 0.79 }),
      link("rejected", "a", { status: "rejected" }),
    ];
    expect(derive(undefined, events, links)[0].evidence_event_ids).toEqual(["high", "confirmed"]);
  });

  it("marks merged work complete until newer active work appears", () => {
    const merged = event({
      event_id: "merged",
      event_type: "pull_request_merged",
      pull_request: { number: 7, title: "done", merged: true },
    });
    expect(derive(undefined, [merged], [link("merged", "a")])[0]).toMatchObject({
      computed_status: "complete",
      confidence: 0.8,
      explanation: "PR #7 was merged",
    });
    expect(
      derive(undefined, [merged], [link("merged", "a")], [], [
        branch("a", { last_activity_at: hoursAfter(T0, 1) }),
      ])[0].computed_status,
    ).toBe("in_progress");
    const laterCommit = event({
      event_id: "later",
      event_type: "commit",
      occurred_at: hoursAfter(T0, 2),
      branch: "follow-up",
    });
    expect(
      derive(undefined, [merged, laterCommit], [link("merged", "a"), link("later", "a")])[0].computed_status,
    ).toBe("in_progress");
  });

  it("uses the latest event to decide whether a pull request is open", () => {
    const opened = event({
      event_id: "open",
      event_type: "pull_request_opened",
      pull_request: { number: 3, title: "work" },
    });
    const closed = event({
      event_id: "closed",
      event_type: "pull_request_closed",
      occurred_at: hoursAfter(T0, 1),
      pull_request: { number: 3, title: "work" },
    });
    expect(derive(undefined, [opened, closed], [link("open", "a"), link("closed", "a")])[0].computed_status).toBe(
      "not_started",
    );
  });

  it("blocks active work on incomplete dependencies in topological order", () => {
    const prerequisite = task({ task_id: "dep", task_key: "PC-1", title: "API" });
    const dependent = task({ task_id: "work", task_key: "PC-2", title: "UI" });
    const commit = event({ event_id: "work-event", event_type: "commit", branch: "ui" });
    const states = derive(
      [dependent, prerequisite],
      [commit],
      [link("work-event", "work")],
      [{ task_id: "work", depends_on_task_id: "dep" }],
    );
    expect(states.map((state) => state.task_id)).toEqual(["work", "dep"]);
    expect(states[0]).toMatchObject({
      computed_status: "possibly_blocked",
      effective_status: "possibly_blocked",
      blocking_task_ids: ["dep"],
    });
    expect(states[0].explanation).toContain("PC-1 API (not_started)");
  });

  it("uses a prerequisite override when evaluating a dependent", () => {
    const tasks = [task({ task_id: "dep", task_key: "PC-1" }), task({ task_id: "work", task_key: "PC-2" })];
    const commit = event({ event_id: "work-event", event_type: "commit" });
    const states = deriveTaskStates({
      tasks,
      events: [commit],
      links: [link("work-event", "work")],
      dependencies: [{ task_id: "work", depends_on_task_id: "dep" }],
      overrides: [{ task_id: "dep", override_status: "complete" }],
    });
    expect(states[0]).toMatchObject({
      computed_status: "not_started",
      override_status: "complete",
      effective_status: "complete",
    });
    expect(states[1].computed_status).toBe("in_progress");
  });

  it("blocks plan-in-progress tasks even before repository activity", () => {
    const tasks = [
      task({ task_id: "dep", task_key: "PC-1" }),
      task({ task_id: "work", task_key: "PC-2", plan_status: "in_progress" }),
    ];
    expect(derive(tasks, [], [], [{ task_id: "work", depends_on_task_id: "dep" }])[1]).toMatchObject({
      computed_status: "possibly_blocked",
      blocking_task_ids: ["dep"],
    });
  });

  it("does not downgrade completed work because a dependency is incomplete", () => {
    const tasks = [task({ task_id: "dep", task_key: "PC-1" }), task({ task_id: "work", task_key: "PC-2" })];
    const merged = event({ event_id: "merged", event_type: "pull_request_merged" });
    expect(
      derive(tasks, [merged], [link("merged", "work")], [{ task_id: "work", depends_on_task_id: "dep" }])[1]
        .computed_status,
    ).toBe("complete");
  });

  it("handles cycles deterministically instead of hanging", () => {
    const tasks = [task({ task_id: "a", task_key: "PC-1" }), task({ task_id: "b", task_key: "PC-2" })];
    const states = derive(tasks, [], [], [
      { task_id: "a", depends_on_task_id: "b" },
      { task_id: "b", depends_on_task_id: "a" },
    ]);
    expect(states.map((state) => state.computed_status)).toEqual(["possibly_blocked", "possibly_blocked"]);
    expect(states.map((state) => state.blocking_task_ids)).toEqual([["b"], ["a"]]);
  });

  it("does not label a task downstream of a cycle as a cycle member", () => {
    const tasks = [
      task({ task_id: "a", task_key: "PC-1" }),
      task({ task_id: "b", task_key: "PC-2" }),
      task({ task_id: "c", task_key: "PC-3", plan_status: "in_progress" }),
    ];
    const states = derive(tasks, [], [], [
      { task_id: "a", depends_on_task_id: "b" },
      { task_id: "b", depends_on_task_id: "a" },
      { task_id: "c", depends_on_task_id: "a" },
    ]);
    expect(states[2].computed_status).toBe("possibly_blocked");
    expect(states[2].explanation).toContain("Blocked by");
    expect(states[2].explanation).not.toContain("Dependency cycle involving");
  });

  it("ignores dependencies to tasks outside the analyzed set", () => {
    expect(derive(undefined, [], [], [{ task_id: "a", depends_on_task_id: "missing" }])[0].computed_status).toBe(
      "not_started",
    );
  });
});
