// Shared data shapes for Pit Crew.
// Agree on these with Person 1 (events/projects) and Person 2 (derived state)
// so frontend and backend speak the same language.

export type TaskStatus = "not_started" | "in_progress" | "complete" | "blocked";
export type Priority = "high" | "medium" | "low";

export interface Task {
  id: string; // short ID, e.g. "pc-12" — used in branch names / PR titles
  title: string;
  owner: string;
  status: TaskStatus;
  priority: Priority;
  dependsOn: string[]; // other task IDs
  mustHave: boolean;
  milestone?: string;
  targetTime?: string; // ISO date
}

export interface Project {
  id: string;
  name: string;
  team: string[];
  deadline: string; // ISO date
  brief: string; // markdown for now; rich-text JSON later
  tasks: Task[];
  createdAt: string;
}

export type EventType =
  | "push"
  | "commit"
  | "branch_created"
  | "pr_opened"
  | "pr_merged"
  | "pr_review";

export interface PitEvent {
  id: string;
  projectId: string;
  source: "github";
  externalEventId: string;
  eventType: EventType;
  actor: string;
  timestamp: string; // ISO date
  payload: Record<string, unknown>;
}
