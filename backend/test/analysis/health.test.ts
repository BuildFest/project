import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLIP_WARN_HOURS,
  DEFAULT_STALE_HOURS,
  deriveHealthSignals,
  healthThresholdsFromEnv,
} from "../../src/analysis/health.js";
import type {
  DerivedTaskState,
  EventTaskLink,
  Milestone,
  Project,
  Task,
  TaskDependency,
} from "../../src/analysis/types.js";
import { event, hoursAfter, task, T0 } from "./fixtures.js";

const project: Project = {
  project_id: "project_1",
  task_key_prefix: "PC",
  created_at: hoursAfter(T0, -24),
  deadline_at: null,
};

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return { milestone_id: "m1", name: "Demo", target_at: null, archived: false, ...overrides };
}

function state(task_id: string, overrides: Partial<DerivedTaskState> = {}): DerivedTaskState {
  return {
    task_id,
    computed_status: "not_started",
    override_status: null,
    effective_status: "not_started",
    confidence: 0.9,
    evidence_event_ids: [],
    last_activity_at: null,
    blocking_task_ids: [],
    explanation: "No linked repository activity",
    computation_method: "rules",
    ...overrides,
  };
}

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

interface DeriveOverrides {
  project?: Project;
  milestones?: Milestone[];
  tasks?: Task[];
  dependencies?: TaskDependency[];
  states?: DerivedTaskState[];
  events?: ReturnType<typeof event>[];
  links?: EventTaskLink[];
  now?: Date;
  thresholds?: { slipWarnHours?: number; staleHours?: number };
}

function derive(overrides: DeriveOverrides = {}) {
  const tasks = overrides.tasks ?? [task({ task_id: "a", task_key: "PC-1" })];
  return deriveHealthSignals({
    project: overrides.project ?? project,
    milestones: overrides.milestones ?? [],
    tasks,
    dependencies: overrides.dependencies ?? [],
    states: overrides.states ?? tasks.map((item) => state(item.task_id)),
    events: overrides.events ?? [],
    links: overrides.links ?? [],
    now: overrides.now ?? T0,
    thresholds: overrides.thresholds,
  });
}

describe("healthThresholdsFromEnv", () => {
  it("reads valid overrides and falls back for invalid values", () => {
    expect(healthThresholdsFromEnv({ SLIP_WARN_HOURS: "6", STALE_HOURS: "1.5" })).toEqual({
      slipWarnHours: 6,
      staleHours: 1.5,
    });
    expect(healthThresholdsFromEnv({ SLIP_WARN_HOURS: "bad", STALE_HOURS: "-1" })).toEqual({
      slipWarnHours: DEFAULT_SLIP_WARN_HOURS,
      staleHours: DEFAULT_STALE_HOURS,
    });
  });
});

describe("deriveHealthSignals", () => {
  it("warns for a near milestone and becomes critical when overdue", () => {
    const tasks = [
      task({ task_id: "a", task_key: "PC-1", milestone_id: "m1" }),
      task({ task_id: "done", task_key: "PC-2", milestone_id: "m1" }),
      task({ task_id: "optional", task_key: "PC-3", milestone_id: "m1", scope: "optional" }),
    ];
    const states = [state("a", { evidence_event_ids: ["e2", "e1"] }), state("done", { effective_status: "complete" }), state("optional")];
    const warning = derive({ tasks, states, milestones: [milestone({ target_at: hoursAfter(T0, 2) })] });
    expect(warning.find((signal) => signal.type === "milestone_slipping")).toMatchObject({
      severity: "warning",
      fingerprint: "milestone_slipping:m1",
      related_task_ids: ["a"],
      related_milestone_ids: ["m1"],
      evidence_event_ids: ["e2", "e1"],
    });
    expect(
      derive({ tasks, states, milestones: [milestone({ target_at: hoursAfter(T0, -1) })] }).find(
        (signal) => signal.type === "milestone_slipping",
      )?.severity,
    ).toBe("critical");
  });

  it("does not flag distant, archived, complete, or optional-only milestones", () => {
    const optional = task({ task_id: "a", task_key: "PC-1", milestone_id: "m1", scope: "optional" });
    expect(derive({ tasks: [optional], milestones: [milestone({ target_at: hoursAfter(T0, 10) })] })).toEqual([]);
    expect(derive({ tasks: [optional], milestones: [milestone({ target_at: T0, archived: true })] })).toEqual([]);
  });

  it("flags PR work waiting on an incomplete dependency with concrete evidence", () => {
    const tasks = [
      task({ task_id: "dep", task_key: "PC-1", title: "API" }),
      task({ task_id: "work", task_key: "PC-2", title: "UI" }),
    ];
    const opened = event({
      event_id: "pr-open",
      event_type: "pull_request_opened",
      pull_request: { number: 7, title: "UI" },
    });
    const signals = derive({
      tasks,
      states: [state("dep", { evidence_event_ids: ["dep-event"] }), state("work", { effective_status: "possibly_blocked" })],
      dependencies: [
        { task_id: "work", depends_on_task_id: "dep" },
        { task_id: "work", depends_on_task_id: "dep" },
      ],
      events: [opened],
      links: [link("pr-open", "work")],
    });
    expect(signals.find((signal) => signal.type === "dependency_incomplete")).toMatchObject({
      severity: "warning",
      fingerprint: "dependency_incomplete:work:dep",
      related_task_ids: ["work", "dep"],
      evidence_event_ids: ["pr-open", "dep-event"],
    });
    expect(signals.filter((signal) => signal.fingerprint === "dependency_incomplete:work:dep")).toHaveLength(1);
    expect(signals.some((signal) => signal.type === "task_possibly_blocked")).toBe(false);
  });

  it("uses latest PR state and ignores low-confidence AI links", () => {
    const tasks = [task({ task_id: "dep", task_key: "PC-1" }), task({ task_id: "work", task_key: "PC-2" })];
    const opened = event({ event_id: "open", event_type: "pull_request_opened", pull_request: { number: 2, title: "x" } });
    const closed = event({ event_id: "closed", event_type: "pull_request_closed", occurred_at: hoursAfter(T0, 1), pull_request: { number: 2, title: "x" } });
    const base = { tasks, dependencies: [{ task_id: "work", depends_on_task_id: "dep" }], events: [opened, closed] };
    expect(derive({ ...base, links: [link("open", "work"), link("closed", "work")] })).toEqual([]);
    expect(derive({ ...base, events: [opened], links: [link("open", "work", { method: "llm", status: "suggested", confidence: 0.79 })] })).toEqual([]);
  });

  it("does not flag a dependency once its effective state is complete", () => {
    const tasks = [task({ task_id: "dep", task_key: "PC-1" }), task({ task_id: "work", task_key: "PC-2" })];
    const merged = event({ event_id: "merged", event_type: "pull_request_merged", pull_request: { number: 3, title: "x", merged: true } });
    const signals = derive({
      tasks,
      states: [state("dep", { effective_status: "complete" }), state("work")],
      dependencies: [{ task_id: "work", depends_on_task_id: "dep" }],
      events: [merged],
      links: [link("merged", "work")],
    });
    expect(signals.some((signal) => signal.type === "dependency_incomplete")).toBe(false);
  });

  it("flags a possibly-blocked task without PR evidence", () => {
    const blocked = task({ task_id: "a", task_key: "PC-1" });
    const [signal] = derive({
      tasks: [blocked],
      states: [state("a", { effective_status: "possibly_blocked", blocking_task_ids: ["dep"], explanation: "Blocked by PC-2 API", evidence_event_ids: ["commit"] })],
    });
    expect(signal).toMatchObject({
      type: "task_possibly_blocked",
      severity: "info",
      related_task_ids: ["a", "dep"],
      evidence_event_ids: ["commit"],
      fingerprint: "task_possibly_blocked:a",
    });
  });

  it("flags stale planned work and not-started must-haves near a project deadline", () => {
    const stale = task({ task_id: "stale", task_key: "PC-1", plan_status: "in_progress", created_at: hoursAfter(T0, -3) });
    const deadline = task({ task_id: "deadline", task_key: "PC-2" });
    const signals = derive({
      project: { ...project, deadline_at: hoursAfter(T0, 2) },
      tasks: [stale, deadline],
    }).filter((signal) => signal.type === "must_have_no_activity");
    expect(signals.map((signal) => signal.fingerprint)).toEqual([
      "must_have_no_activity:deadline",
      "must_have_no_activity:stale",
    ]);
  });

  it("does not treat optional, active, fresh, archived, or cancelled tasks as inactive must-haves", () => {
    const tasks = [
      task({ task_id: "optional", task_key: "PC-1", scope: "optional", plan_status: "in_progress", created_at: hoursAfter(T0, -5) }),
      task({ task_id: "active", task_key: "PC-2", plan_status: "in_progress", created_at: hoursAfter(T0, -5) }),
      task({ task_id: "fresh", task_key: "PC-3", plan_status: "in_progress", created_at: hoursAfter(T0, -1) }),
      task({ task_id: "old", task_key: "PC-4", plan_status: "in_progress", archived: true }),
      task({ task_id: "cancelled", task_key: "PC-5", plan_status: "cancelled" }),
    ];
    const states = tasks.map((item) => state(item.task_id, item.task_id === "active" ? { effective_status: "in_progress" } : {}));
    expect(derive({ tasks, states }).filter((signal) => signal.type === "must_have_no_activity")).toEqual([]);
  });

  it.each([
    ["complete", "not_started", "warning"],
    ["not_started", "in_progress", "info"],
    ["not_started", "complete", "info"],
    ["in_progress", "complete", "info"],
    ["blocked", "complete", "info"],
  ] as const)("flags plan %s versus effective %s", (plan_status, effective_status, severity) => {
    const planned = task({ task_id: "a", task_key: "PC-1", plan_status });
    const signal = derive({ tasks: [planned], states: [state("a", { effective_status, evidence_event_ids: ["proof"] })] })
      .find((item) => item.type === "plan_state_disagreement");
    expect(signal).toMatchObject({
      severity,
      fingerprint: `plan_state_disagreement:a:${plan_status}:${effective_status}`,
      evidence_event_ids: ["proof"],
    });
  });

  it("returns stable fingerprint order without duplicate evidence IDs", () => {
    const tasks = [
      task({ task_id: "z", task_key: "PC-2", plan_status: "not_started", milestone_id: "m1" }),
      task({ task_id: "a", task_key: "PC-1", plan_status: "not_started", milestone_id: "m1" }),
    ];
    const states = [
      state("z", { effective_status: "in_progress", evidence_event_ids: ["shared"] }),
      state("a", { evidence_event_ids: ["shared"] }),
    ];
    const signals = derive({ tasks, states, milestones: [milestone({ target_at: T0 })] });
    expect(signals.map((signal) => signal.fingerprint)).toEqual([...signals.map((signal) => signal.fingerprint)].sort());
    expect(signals.find((signal) => signal.type === "milestone_slipping")?.evidence_event_ids).toEqual(["shared"]);
    expect(new Set(signals.map((signal) => signal.fingerprint)).size).toBe(signals.length);
  });
});
