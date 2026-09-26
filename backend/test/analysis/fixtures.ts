import type { GithubEvent, Task } from "../../src/analysis/types.js";

// Builders for tests. Defaults describe an unremarkable must-have task and a
// commit on an unnamed branch; tests override only what they care about.

export const T0 = new Date("2026-09-26T12:00:00Z");

export function hoursAfter(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 3_600_000);
}

export function task(overrides: Partial<Task> & Pick<Task, "task_id" | "task_key">): Task {
  return {
    title: overrides.task_key,
    description: null,
    priority: "medium",
    scope: "must_have",
    plan_status: "not_started",
    milestone_id: null,
    target_at: null,
    created_at: T0,
    archived: false,
    ...overrides,
  };
}

export function event(
  overrides: Partial<GithubEvent> & Pick<GithubEvent, "event_id" | "event_type">,
): GithubEvent {
  return {
    repository_id: "repo_1",
    actor: "dev",
    occurred_at: T0,
    branch: null,
    commit: null,
    pull_request: null,
    changed_files: [],
    ...overrides,
  };
}
