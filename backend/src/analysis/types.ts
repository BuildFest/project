// Analyzer inputs and outputs. Field names match db/schema.sql columns so rows
// can be passed in and results written back without renaming.

export type PlanStatus = "not_started" | "in_progress" | "blocked" | "complete" | "cancelled";
export type DerivedStatus = "not_started" | "in_progress" | "complete" | "possibly_blocked";
export type Scope = "must_have" | "optional";
export type Priority = "critical" | "high" | "medium" | "low";

export type GithubEventType =
  | "push"
  | "commit"
  | "branch_created"
  | "branch_deleted"
  | "pull_request_opened"
  | "pull_request_updated"
  | "pull_request_closed"
  | "pull_request_merged"
  | "pull_request_reopened";

export interface Project {
  project_id: string;
  task_key_prefix: string;
  created_at: Date;
  deadline_at: Date | null;
}

export interface Repository {
  repository_id: string;
  default_branch: string;
}

export interface Milestone {
  milestone_id: string;
  name: string;
  target_at: Date | null;
  archived: boolean;
}

export interface Task {
  task_id: string;
  task_key: string;
  title: string;
  description: string | null;
  priority: Priority;
  scope: Scope;
  plan_status: PlanStatus;
  // Who last wrote plan_status (see AGENT_ACTOR in planSync.ts); null = never changed.
  plan_status_set_by?: string | null;
  milestone_id: string | null;
  target_at: Date | null;
  created_at: Date;
  archived: boolean;
}

export interface TaskDependency {
  task_id: string;
  depends_on_task_id: string;
}

export interface CommitInfo {
  sha: string;
  message: string | null;
  author?: string | null;
  url?: string | null;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state?: string;
  head_branch?: string;
  base_branch?: string;
  url?: string;
  merged?: boolean;
}

export interface GithubEvent {
  event_id: string;
  repository_id: string;
  event_type: GithubEventType;
  actor: string | null;
  occurred_at: Date;
  branch: string | null;
  commit: CommitInfo | null;
  pull_request: PullRequestInfo | null;
  changed_files: string[];
}

export type LinkMethod = "task_key" | "manual" | "llm";
export type LinkStatus = "confirmed" | "suggested" | "rejected";

export interface EventTaskLink {
  event_id: string;
  task_id: string;
  method: LinkMethod;
  confidence: number;
  status: LinkStatus;
  is_primary: boolean;
}

export interface TaskOverride {
  task_id: string;
  override_status: DerivedStatus;
}

export interface BranchState {
  repository_id: string;
  branch: string;
  status: "active" | "merged" | "deleted";
  task_id: string | null;
  changed_files: string[];
  open_pr_number: number | null;
  last_activity_at: Date | null;
}

export interface StoredHealthSignal extends DesiredHealthSignal {
  signal_id: string;
  status: "active" | "dismissed";
}

export interface StoredCollision {
  collision_id: string;
  repository_id: string;
  branch_a: string;
  branch_b: string;
  task_a_id: string | null;
  task_b_id: string | null;
  overlapping_files: string[];
  status: "active" | "dismissed";
}

export interface DerivedTaskState {
  task_id: string;
  computed_status: DerivedStatus;
  override_status: DerivedStatus | null;
  effective_status: DerivedStatus;
  confidence: number;
  evidence_event_ids: string[];
  last_activity_at: Date | null;
  blocking_task_ids: string[];
  explanation: string;
  computation_method: "rules" | "llm" | "rules+llm";
}

export type HealthSignalType =
  | "milestone_slipping"
  | "dependency_incomplete"
  | "must_have_no_activity"
  | "plan_state_disagreement"
  | "task_possibly_blocked";

export interface DesiredHealthSignal {
  type: HealthSignalType;
  severity: "info" | "warning" | "critical";
  title: string;
  explanation: string;
  related_task_ids: string[];
  related_milestone_ids: string[];
  evidence_event_ids: string[];
  fingerprint: string;
}
