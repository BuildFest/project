import { countsTowardState } from "./linkPlan.js";
import type {
  DerivedTaskState,
  DesiredHealthSignal,
  EventTaskLink,
  GithubEvent,
  Milestone,
  Project,
  Task,
  TaskDependency,
} from "./types.js";

export const DEFAULT_SLIP_WARN_HOURS = 3;
export const DEFAULT_STALE_HOURS = 2;

export interface HealthThresholds {
  slipWarnHours: number;
  staleHours: number;
}

export interface DeriveHealthSignalsInput {
  project: Project;
  milestones: Milestone[];
  tasks: Task[];
  dependencies: TaskDependency[];
  states: DerivedTaskState[];
  events: GithubEvent[];
  links: EventTaskLink[];
  now: Date;
  thresholds?: Partial<HealthThresholds>;
}

function nonnegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function healthThresholdsFromEnv(
  env: Partial<Pick<NodeJS.ProcessEnv, "SLIP_WARN_HOURS" | "STALE_HOURS">> = process.env,
): HealthThresholds {
  return {
    slipWarnHours: nonnegativeNumber(env.SLIP_WARN_HOURS, DEFAULT_SLIP_WARN_HOURS),
    staleHours: nonnegativeNumber(env.STALE_HOURS, DEFAULT_STALE_HOURS),
  };
}

const newestFirst = (a: GithubEvent, b: GithubEvent) =>
  b.occurred_at.getTime() - a.occurred_at.getTime() || a.event_id.localeCompare(b.event_id);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function linkedEventsByTask(input: DeriveHealthSignalsInput, activeTaskIds: Set<string>) {
  const eventById = new Map(input.events.map((event) => [event.event_id, event]));
  const byTask = new Map<string, GithubEvent[]>();
  for (const link of input.links) {
    if (!activeTaskIds.has(link.task_id) || !countsTowardState(link)) continue;
    const event = eventById.get(link.event_id);
    if (!event) continue;
    const events = byTask.get(link.task_id) ?? [];
    if (!events.some((candidate) => candidate.event_id === event.event_id)) events.push(event);
    byTask.set(link.task_id, events);
  }
  for (const events of byTask.values()) events.sort(newestFirst);
  return byTask;
}

function currentPrEvidence(events: GithubEvent[]): GithubEvent[] {
  const latest = new Map<string, GithubEvent>();
  for (const event of events) {
    if (!event.pull_request) continue;
    const key = `${event.repository_id}:${event.pull_request.number}`;
    const previous = latest.get(key);
    if (!previous || newestFirst(previous, event) > 0) latest.set(key, event);
  }
  return [...latest.values()]
    .filter((event) =>
      ["pull_request_opened", "pull_request_updated", "pull_request_reopened", "pull_request_merged"].includes(
        event.event_type,
      ),
    )
    .sort(newestFirst);
}

function deadlineIsNear(deadline: Date | null, now: Date, warningMs: number): boolean {
  return deadline !== null && deadline.getTime() <= now.getTime() + warningMs;
}

/** Produces the desired signal set. Persistence owns active/dismissed/resolved lifecycle. */
export function deriveHealthSignals(input: DeriveHealthSignalsInput): DesiredHealthSignal[] {
  const thresholds = {
    slipWarnHours: input.thresholds?.slipWarnHours ?? DEFAULT_SLIP_WARN_HOURS,
    staleHours: input.thresholds?.staleHours ?? DEFAULT_STALE_HOURS,
  };
  const warningMs = thresholds.slipWarnHours * 3_600_000;
  const staleMs = thresholds.staleHours * 3_600_000;
  const tasks = input.tasks
    .filter((task) => !task.archived && task.plan_status !== "cancelled")
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const stateByTask = new Map(input.states.map((state) => [state.task_id, state]));
  const milestoneById = new Map(input.milestones.filter((item) => !item.archived).map((item) => [item.milestone_id, item]));
  const linkedEvents = linkedEventsByTask(input, new Set(taskById.keys()));
  const currentPrByTask = new Map(
    tasks.map((task) => [task.task_id, currentPrEvidence(linkedEvents.get(task.task_id) ?? [])]),
  );
  const signals: DesiredHealthSignal[] = [];

  for (const milestone of [...milestoneById.values()].sort((a, b) => a.milestone_id.localeCompare(b.milestone_id))) {
    if (!deadlineIsNear(milestone.target_at, input.now, warningMs)) continue;
    const incomplete = tasks.filter(
      (task) =>
        task.milestone_id === milestone.milestone_id &&
        task.scope === "must_have" &&
        stateByTask.get(task.task_id)?.effective_status !== "complete",
    );
    if (incomplete.length === 0) continue;
    const overdue = milestone.target_at!.getTime() < input.now.getTime();
    const keys = incomplete.map((task) => task.task_key);
    signals.push({
      type: "milestone_slipping",
      severity: overdue ? "critical" : "warning",
      title: `${milestone.name} ${overdue ? "is overdue" : "may slip"}`,
      explanation: `${milestone.name} has ${incomplete.length} incomplete must-have task${incomplete.length === 1 ? "" : "s"}: ${keys.join(", ")}`,
      related_task_ids: incomplete.map((task) => task.task_id),
      related_milestone_ids: [milestone.milestone_id],
      evidence_event_ids: unique(incomplete.flatMap((task) => stateByTask.get(task.task_id)?.evidence_event_ids ?? [])),
      fingerprint: `milestone_slipping:${milestone.milestone_id}`,
    });
  }

  for (const dependency of [...input.dependencies].sort(
    (a, b) => a.task_id.localeCompare(b.task_id) || a.depends_on_task_id.localeCompare(b.depends_on_task_id),
  )) {
    const task = taskById.get(dependency.task_id);
    const prerequisite = taskById.get(dependency.depends_on_task_id);
    const prerequisiteState = stateByTask.get(dependency.depends_on_task_id);
    const prEvidence = currentPrByTask.get(dependency.task_id) ?? [];
    if (!task || !prerequisite || prerequisiteState?.effective_status === "complete" || prEvidence.length === 0) continue;
    const pr = prEvidence[0].pull_request;
    signals.push({
      type: "dependency_incomplete",
      severity: "warning",
      title: `${task.task_key} is waiting on ${prerequisite.task_key}`,
      explanation: `PR #${pr?.number ?? "?"} for ${task.task_key} is ${prEvidence[0].event_type === "pull_request_merged" ? "merged" : "open"}, but dependency ${prerequisite.task_key} ${prerequisite.title} is ${prerequisiteState?.effective_status ?? "not started"}`,
      related_task_ids: [task.task_id, prerequisite.task_id],
      related_milestone_ids: [],
      evidence_event_ids: unique([prEvidence[0].event_id, ...(prerequisiteState?.evidence_event_ids ?? [])]),
      fingerprint: `dependency_incomplete:${task.task_id}:${prerequisite.task_id}`,
    });
  }

  for (const task of tasks) {
    const state = stateByTask.get(task.task_id);
    if (!state) continue;
    const milestone = task.milestone_id ? milestoneById.get(task.milestone_id) : undefined;
    const nearDeadline = deadlineIsNear(milestone?.target_at ?? input.project.deadline_at, input.now, warningMs);
    const stalePlan =
      task.plan_status === "in_progress" && input.now.getTime() - task.created_at.getTime() >= staleMs;
    if (task.scope === "must_have" && state.effective_status === "not_started" && (stalePlan || nearDeadline)) {
      signals.push({
        type: "must_have_no_activity",
        severity: "warning",
        title: `${task.task_key} has no linked activity`,
        explanation: nearDeadline
          ? `${task.task_key} ${task.title} is a not-started must-have near its deadline`
          : `${task.task_key} ${task.title} is planned in progress but has no linked activity`,
        related_task_ids: [task.task_id],
        related_milestone_ids: milestone ? [milestone.milestone_id] : [],
        evidence_event_ids: state.evidence_event_ids,
        fingerprint: `must_have_no_activity:${task.task_id}`,
      });
    }

    const plan = task.plan_status;
    const effective = state.effective_status;
    const disagrees =
      (plan === "complete" && effective !== "complete") ||
      (plan === "not_started" && (effective === "in_progress" || effective === "complete")) ||
      ((plan === "in_progress" || plan === "blocked") && effective === "complete");
    if (disagrees) {
      signals.push({
        type: "plan_state_disagreement",
        severity: plan === "complete" ? "warning" : "info",
        title: `${task.task_key} plan and repository state differ`,
        explanation: `${task.task_key} ${task.title} is ${plan} in the plan but ${effective} from linked repository evidence`,
        related_task_ids: [task.task_id],
        related_milestone_ids: task.milestone_id ? [task.milestone_id] : [],
        evidence_event_ids: state.evidence_event_ids,
        fingerprint: `plan_state_disagreement:${task.task_id}:${plan}:${effective}`,
      });
    }

    const hasAnyPr = (linkedEvents.get(task.task_id) ?? []).some((event) => event.pull_request !== null);
    if (effective === "possibly_blocked" && !hasAnyPr) {
      signals.push({
        type: "task_possibly_blocked",
        severity: "info",
        title: `${task.task_key} may be blocked`,
        explanation: state.explanation,
        related_task_ids: unique([task.task_id, ...state.blocking_task_ids]),
        related_milestone_ids: task.milestone_id ? [task.milestone_id] : [],
        evidence_event_ids: state.evidence_event_ids,
        fingerprint: `task_possibly_blocked:${task.task_id}`,
      });
    }
  }

  const byFingerprint = new Map(signals.map((signal) => [signal.fingerprint, signal]));
  return [...byFingerprint.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}
