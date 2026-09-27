import type { DerivedTaskState, EventTaskLink, GithubEvent, PlanStatus, Task } from "./types.js";

// Who last wrote a task's plan_status: null means it still has the value it was
// created with; AGENT_ACTOR means the planning agent moved it; anything else is
// a person (a member id, or "team" when the request didn't say who).
export const AGENT_ACTOR = "agent";

// An AI link only counts as strong evidence for a plan change at or above this
// confidence. Lower AI links still feed derived state, but never the plan.
export const STRONG_AI_CONFIDENCE = 0.9;

export type MovableStatus = Extract<PlanStatus, "not_started" | "in_progress">;
export type MoveTarget = Extract<PlanStatus, "in_progress" | "complete">;

export interface StatusMove {
  task_id: string;
  task_key: string;
  from: MovableStatus;
  to: MoveTarget;
  reason: string;
  evidence_event_ids: string[];
}

const RANK: Record<MovableStatus | MoveTarget, number> = { not_started: 0, in_progress: 1, complete: 2 };

export function isStrongLink(link: EventTaskLink): boolean {
  if (link.status === "rejected") return false;
  if (link.status === "confirmed") return true;
  return link.method === "llm" && link.confidence >= STRONG_AI_CONFIDENCE;
}

export const STATUS_LABEL: Record<PlanStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  complete: "Complete",
  cancelled: "Cancelled",
};

/**
 * The plan changes the agent may make on its own: forward-only moves
 * (not started -> in progress -> complete) on tasks nobody has set by hand,
 * backed by strongly linked repository evidence. Everything else is left to
 * the team, where the plan/state disagreement signal surfaces it.
 */
export function decideStatusMoves(input: {
  tasks: Task[];
  states: DerivedTaskState[];
  links: EventTaskLink[];
  events: GithubEvent[];
}): StatusMove[] {
  const stateByTask = new Map(input.states.map((state) => [state.task_id, state]));
  const eventsById = new Map(input.events.map((event) => [event.event_id, event]));
  const strongByTask = new Map<string, GithubEvent[]>();
  for (const link of input.links) {
    const event = eventsById.get(link.event_id);
    if (!event || !isStrongLink(link)) continue;
    strongByTask.set(link.task_id, [...(strongByTask.get(link.task_id) ?? []), event]);
  }

  const moves: StatusMove[] = [];
  for (const task of input.tasks) {
    if (task.archived) continue;
    if (task.plan_status !== "not_started" && task.plan_status !== "in_progress") continue;
    // A status a person chose is theirs; the agent never overrides it.
    if (task.plan_status_set_by && task.plan_status_set_by !== AGENT_ACTOR) continue;
    const state = stateByTask.get(task.task_id);
    // A human override means someone is managing this task's state by hand.
    if (!state || state.override_status !== null) continue;

    const strong = strongByTask.get(task.task_id) ?? [];
    if (strong.length === 0) continue;
    const from = task.plan_status;
    const merged = strong
      .filter((event) => event.event_type === "pull_request_merged")
      .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())[0];

    let to: MoveTarget | null = null;
    let reason = "";
    let evidence: GithubEvent[] = [];
    if (state.effective_status === "complete" && merged) {
      to = "complete";
      const number = merged.pull_request?.number;
      reason = number === undefined ? "Linked work was merged" : `PR #${number} was merged`;
      evidence = [merged];
    } else if (state.effective_status !== "not_started" && !isCycle(state)) {
      // In progress, possibly blocked by an unfinished dependency, or complete
      // without a strongly linked merge: work has started either way.
      to = "in_progress";
      reason = state.effective_status === "complete" ? "Linked work exists" : state.explanation || "Linked work exists";
      evidence = [...strong].sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime()).slice(0, 5);
    }
    if (!to || RANK[to] <= RANK[from]) continue;
    moves.push({
      task_id: task.task_id,
      task_key: task.task_key,
      from,
      to,
      reason,
      evidence_event_ids: evidence.map((event) => event.event_id),
    });
  }
  return moves;
}

// deriveTaskStates marks dependency-cycle members possibly_blocked with
// confidence 0.5; that is a plan problem, not evidence of work.
function isCycle(state: DerivedTaskState): boolean {
  return state.computed_status === "possibly_blocked" && (state.explanation ?? "").startsWith("Dependency cycle");
}

// One timeline entry per sync: "Planning agent moved PC-6 to Complete" for a
// single move, otherwise "Planning agent updated 3 tasks" with the keys by status.
export function batchTimelineText(moves: Pick<StatusMove, "task_key" | "to">[]): { title: string; summary: string } {
  const byKey = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
  const keys = (to: MoveTarget) => moves.filter((move) => move.to === to).map((move) => move.task_key).sort(byKey);
  const summary = (["in_progress", "complete"] as const)
    .filter((to) => keys(to).length > 0)
    .map((to) => `${STATUS_LABEL[to]}: ${keys(to).join(", ")}`)
    .join(" · ");
  const title = moves.length === 1
    ? `Planning agent moved ${moves[0].task_key} to ${STATUS_LABEL[moves[0].to]}`
    : `Planning agent updated ${moves.length} tasks`;
  return { title, summary };
}

// Tasks as they will be once the moves are saved, for signals derived in the same run.
export function applyStatusMoves(tasks: Task[], moves: StatusMove[]): Task[] {
  if (moves.length === 0) return tasks;
  const byTask = new Map(moves.map((move) => [move.task_id, move]));
  return tasks.map((task) => {
    const move = byTask.get(task.task_id);
    return move ? { ...task, plan_status: move.to, plan_status_set_by: AGENT_ACTOR } : task;
  });
}
