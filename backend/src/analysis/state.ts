import { countsTowardState } from "./linkPlan.js";
import type {
  BranchState,
  DerivedStatus,
  DerivedTaskState,
  EventTaskLink,
  GithubEvent,
  Task,
  TaskDependency,
  TaskOverride,
} from "./types.js";

export const MAX_EVIDENCE_EVENTS = 20;

export interface DeriveTaskStatesInput {
  tasks: Task[];
  dependencies: TaskDependency[];
  events: GithubEvent[];
  links: EventTaskLink[];
  branches?: BranchState[];
  overrides?: TaskOverride[];
}

interface BaseState {
  status: Exclude<DerivedStatus, "possibly_blocked">;
  confidence: number;
  evidence: GithubEvent[];
  lastActivity: Date | null;
  explanation: string;
}

const descending = (a: GithubEvent, b: GithubEvent) =>
  b.occurred_at.getTime() - a.occurred_at.getTime() || a.event_id.localeCompare(b.event_id);

function currentPullRequests(events: GithubEvent[]): GithubEvent[] {
  const latest = new Map<string, GithubEvent>();
  for (const event of events) {
    if (!event.pull_request) continue;
    const key = `${event.repository_id}:${event.pull_request.number}`;
    const previous = latest.get(key);
    if (!previous || descending(previous, event) > 0) latest.set(key, event);
  }
  return [...latest.values()];
}

function branchLabel(branch: BranchState): string {
  return branch.open_pr_number === null
    ? `active branch ${branch.branch}`
    : `PR #${branch.open_pr_number} on ${branch.branch}`;
}

function deriveBase(events: GithubEvent[], branches: BranchState[]): BaseState {
  const evidence = [...events].sort(descending).slice(0, MAX_EVIDENCE_EVENTS);
  const activities = [
    ...events.map((event) => event.occurred_at),
    ...branches.flatMap((branch) => (branch.last_activity_at ? [branch.last_activity_at] : [])),
  ];
  const lastActivity = activities.length
    ? new Date(Math.max(...activities.map((date) => date.getTime())))
    : null;
  const merged = events
    .filter((event) => event.event_type === "pull_request_merged")
    .sort(descending)[0];
  const openPrEvents = currentPullRequests(events).filter((event) =>
    ["pull_request_opened", "pull_request_updated", "pull_request_reopened"].includes(event.event_type),
  );
  const activeBranches = branches.filter((branch) => branch.status === "active");
  const newerWork = merged
    ? events.find(
        (event) =>
          event.occurred_at > merged.occurred_at &&
          (event.event_type === "commit" || event.event_type === "push"),
      )
    : undefined;
  const newerOpenPr = merged
    ? openPrEvents.find((event) => event.occurred_at > merged.occurred_at)
    : openPrEvents[0];
  const newerBranch = merged
    ? activeBranches.find(
        (branch) => branch.last_activity_at !== null && branch.last_activity_at > merged.occurred_at,
      )
    : activeBranches[0];

  if (merged && !newerOpenPr && !newerBranch && !newerWork) {
    const number = merged.pull_request?.number;
    return {
      status: "complete",
      confidence: 0.8,
      evidence,
      lastActivity,
      explanation: number === undefined ? "Linked work was merged" : `PR #${number} was merged`,
    };
  }

  const openPr = newerOpenPr ?? openPrEvents.sort(descending)[0];
  if (openPr) {
    const number = openPr.pull_request?.number;
    const branch = openPr.pull_request?.head_branch ?? openPr.branch;
    return {
      status: "in_progress",
      confidence: 0.7,
      evidence,
      lastActivity,
      explanation: `PR #${number ?? "?"} is open${branch ? ` on ${branch}` : ""}`,
    };
  }
  const activeBranch = newerBranch ?? activeBranches[0];
  if (activeBranch) {
    return {
      status: "in_progress",
      confidence: 0.7,
      evidence,
      lastActivity,
      explanation: `${branchLabel(activeBranch)} has activity`,
    };
  }
  const work = events.find((event) => event.event_type === "commit" || event.event_type === "push");
  if (work) {
    const hasBranch = work.branch !== null;
    return {
      status: "in_progress",
      confidence: hasBranch ? 0.7 : 0.5,
      evidence,
      lastActivity,
      explanation: hasBranch ? `Linked work exists on ${work.branch}` : "Linked commit activity exists",
    };
  }
  return {
    status: "not_started",
    confidence: 0.9,
    evidence,
    lastActivity,
    explanation: "No linked repository activity",
  };
}

/**
 * Computes task state without mutating the team-authored plan. Dependencies
 * read the final effective state (including human overrides) of prerequisites.
 */
export function deriveTaskStates(input: DeriveTaskStatesInput): DerivedTaskState[] {
  const tasks = input.tasks.filter((task) => !task.archived && task.plan_status !== "cancelled");
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const overrideByTask = new Map((input.overrides ?? []).map((item) => [item.task_id, item.override_status]));
  const eventsById = new Map(input.events.map((event) => [event.event_id, event]));
  const linkedByTask = new Map<string, GithubEvent[]>();
  for (const link of input.links) {
    if (!taskById.has(link.task_id) || !countsTowardState(link)) continue;
    const event = eventsById.get(link.event_id);
    if (!event) continue;
    const current = linkedByTask.get(link.task_id) ?? [];
    if (!current.some((item) => item.event_id === event.event_id)) current.push(event);
    linkedByTask.set(link.task_id, current);
  }
  const branchesByTask = new Map<string, BranchState[]>();
  for (const branch of input.branches ?? []) {
    if (!branch.task_id || !taskById.has(branch.task_id)) continue;
    branchesByTask.set(branch.task_id, [...(branchesByTask.get(branch.task_id) ?? []), branch]);
  }
  const depsByTask = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const indegree = new Map(tasks.map((task) => [task.task_id, 0]));
  for (const dependency of input.dependencies) {
    if (!taskById.has(dependency.task_id) || !taskById.has(dependency.depends_on_task_id)) continue;
    const deps = depsByTask.get(dependency.task_id) ?? [];
    if (deps.includes(dependency.depends_on_task_id)) continue;
    deps.push(dependency.depends_on_task_id);
    depsByTask.set(dependency.task_id, deps);
    dependents.set(dependency.depends_on_task_id, [
      ...(dependents.get(dependency.depends_on_task_id) ?? []),
      dependency.task_id,
    ]);
    indegree.set(dependency.task_id, (indegree.get(dependency.task_id) ?? 0) + 1);
  }

  const queue = tasks.filter((task) => indegree.get(task.task_id) === 0).map((task) => task.task_id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  // Kahn's unresolved set also contains tasks downstream of a cycle. Identify
  // actual cycle members by checking whether each task can reach itself.
  const inCycle = (start: string, current: string, seen = new Set<string>()): boolean => {
    for (const dependency of depsByTask.get(current) ?? []) {
      if (dependency === start) return true;
      if (!seen.has(dependency)) {
        seen.add(dependency);
        if (inCycle(start, dependency, seen)) return true;
      }
    }
    return false;
  };
  const cyclic = new Set(tasks.map((task) => task.task_id).filter((id) => inCycle(id, id)));
  order.push(...tasks.map((task) => task.task_id).filter((id) => !order.includes(id)));

  const result = new Map<string, DerivedTaskState>();
  for (const taskId of order) {
    const task = taskById.get(taskId)!;
    const base = deriveBase(linkedByTask.get(taskId) ?? [], branchesByTask.get(taskId) ?? []);
    const dependencyIds = depsByTask.get(taskId) ?? [];
    const blocking = dependencyIds.filter((id) => cyclic.has(id) || result.get(id)?.effective_status !== "complete");
    let computed: DerivedStatus = base.status;
    let confidence = base.confidence;
    let explanation = base.explanation;
    if (cyclic.has(taskId)) {
      computed = "possibly_blocked";
      confidence = 0.5;
      const names = blocking.map((id) => taskById.get(id)?.task_key ?? id);
      explanation = `Dependency cycle involving ${names.join(", ") || task.task_key}`;
    } else if (
      blocking.length > 0 &&
      (base.status === "in_progress" || (base.status === "not_started" && task.plan_status === "in_progress"))
    ) {
      computed = "possibly_blocked";
      confidence = 0.7;
      explanation = `Blocked by ${blocking
        .map((id) => {
          const dependency = taskById.get(id)!;
          return `${dependency.task_key} ${dependency.title} (${result.get(id)?.effective_status ?? "not started"})`;
        })
        .join(", ")}`;
    }
    const override = overrideByTask.get(taskId) ?? null;
    result.set(taskId, {
      task_id: taskId,
      computed_status: computed,
      override_status: override,
      effective_status: override ?? computed,
      confidence,
      evidence_event_ids: base.evidence.map((event) => event.event_id),
      last_activity_at: base.lastActivity,
      blocking_task_ids: computed === "possibly_blocked" ? blocking : [],
      explanation,
      computation_method: "rules",
    });
  }
  return tasks.map((task) => result.get(task.task_id)!);
}
