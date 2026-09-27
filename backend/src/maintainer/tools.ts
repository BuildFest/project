import type { Queryable } from "../db.js";

export type MaintainerToolName = "get_state" | "get_task" | "get_events" | "get_signals" | "get_collisions" | "get_replans";
export interface ToolCall { tool: MaintainerToolName; ids?: string[] }

export interface MaintainerFacts {
  project: Record<string, unknown>;
  tasks: Record<string, unknown>[];
  states: Record<string, unknown>[];
  events: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  collisions: Record<string, unknown>[];
  replans: Record<string, unknown>[];
}

export async function loadMaintainerFacts(db: Queryable, projectId: string): Promise<MaintainerFacts | null> {
  const project = await db.query("select project_id,name,description,deadline_at,timezone from projects where project_id=$1", [projectId]);
  if (!project.rows[0]) return null;
  const [tasks, states, events, signals, collisions, replans] = await Promise.all([
    db.query("select task_id,task_key,title,description,priority,scope,plan_status,target_at from tasks where project_id=$1 and not archived", [projectId]),
    db.query("select task_id,effective_status,confidence,evidence_event_ids,blocking_task_ids,explanation,last_activity_at from derived_task_states where project_id=$1", [projectId]),
    db.query("select event_id,event_type,occurred_at,branch,commit,pull_request,changed_files from github_events where project_id=$1 order by occurred_at desc limit 200", [projectId]),
    db.query("select signal_id,type,severity,title,explanation,related_task_ids,evidence_event_ids from health_signals where project_id=$1 and status='active'", [projectId]),
    db.query("select collision_id,branch_a,branch_b,task_a_id,task_b_id,overlapping_files from collisions where project_id=$1 and status='active'", [projectId]),
    db.query("select suggestion_id,rationale,proposed_changes,evidence_event_ids,related_signal_ids from replan_suggestions where project_id=$1 and status='proposed'", [projectId]),
  ]);
  return { project: project.rows[0], tasks: tasks.rows, states: states.rows, events: events.rows, signals: signals.rows, collisions: collisions.rows, replans: replans.rows };
}

const idOf = (row: Record<string, unknown>) => String(row.task_id ?? row.event_id ?? row.signal_id ?? row.collision_id ?? row.suggestion_id ?? "");
const selected = (rows: Record<string, unknown>[], ids?: string[]) => ids?.length ? rows.filter((row) => ids.includes(idOf(row))) : rows;

export function executeMaintainerTools(facts: MaintainerFacts, calls: ToolCall[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const call of calls.slice(0, 8)) {
    switch (call.tool) {
      case "get_state": output.get_state = { project: facts.project, states: facts.states }; break;
      case "get_task": output.get_task = selected(facts.tasks, call.ids); break;
      case "get_events": output.get_events = selected(facts.events, call.ids).slice(0, 50); break;
      case "get_signals": output.get_signals = selected(facts.signals, call.ids); break;
      case "get_collisions": output.get_collisions = selected(facts.collisions, call.ids); break;
      case "get_replans": output.get_replans = selected(facts.replans, call.ids); break;
    }
  }
  return output;
}
