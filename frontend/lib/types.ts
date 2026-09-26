// Pit Crew shared types — mirrors db/schema.sql on the feat/schema branch.
// Field names are kept snake_case to match the database columns exactly, so
// API responses can be used without translation. If the schema changes,
// update this file to match.
//
// IDs are app-generated prefixed ULIDs, e.g. "task_01JQ983A...".
// Timestamps are ISO strings (timestamptz, UTC).

// ============================================================================
// TEAM-DEFINED
// ============================================================================

export interface Project {
  project_id: string;
  name: string;
  description: string | null;
  task_key_prefix: string; // e.g. "PC" -> task keys PC-1, PC-2 ...
  next_task_number: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deadline_at: string | null;
  timezone: string;
  status: "active" | "archived";
  current_plan_version: number | null;
  primary_repository_id: string | null;
}

export type AccessLevel = "owner" | "editor" | "viewer";

export interface ProjectMember {
  member_id: string;
  project_id: string;
  display_name: string;
  role_label: string | null; // e.g. "Backend 2"
  github_login: string | null; // maps GitHub actors -> members
  access_level: AccessLevel;
  joined_at: string;
}

export interface ProjectBrief {
  project_id: string;
  content: string;
  content_format: "markdown" | "plain";
  updated_at: string;
  updated_by: string | null;
}

export interface Milestone {
  milestone_id: string;
  project_id: string;
  name: string;
  description: string | null;
  target_at: string | null;
  sort_order: number;
  archived: boolean;
}

export type Priority = "critical" | "high" | "medium" | "low";
export type Scope = "must_have" | "optional";
export type PlanStatus =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "complete"
  | "cancelled";

export interface Task {
  task_id: string;
  task_key: string; // e.g. "PC-12"; branches use pc-12-auth-api
  project_id: string;
  title: string;
  description: string | null;
  owner_member_id: string | null;
  priority: Priority;
  scope: Scope;
  plan_status: PlanStatus; // team-authored; never written by inference
  milestone_id: string | null;
  target_at: string | null;
  sort_order: number;
  archived: boolean;
}

export interface TaskDependency {
  project_id: string;
  task_id: string;
  depends_on_task_id: string;
  dependency_type: "requires";
}

// ============================================================================
// FACTUAL
// ============================================================================

export interface Repository {
  repository_id: string;
  project_id: string;
  provider: "github";
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  connection_status: "pending" | "connected" | "error" | "disconnected";
  connected_at: string | null;
  last_backfill_at: string | null;
  last_event_at: string | null;
}

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

export interface GithubEvent {
  event_id: string;
  project_id: string;
  repository_id: string;
  source: "webhook" | "backfill";
  external_event_id: string;
  event_type: GithubEventType;
  actor: string | null; // GitHub login
  occurred_at: string;
  ingested_at: string;
  branch: string | null;
  commit: { sha: string; message: string; author: string; url: string } | null;
  pull_request: {
    number: number;
    title: string;
    state: string;
    head_branch: string;
    base_branch: string;
    url: string;
    merged: boolean;
  } | null;
  changed_files: string[];
}

// ============================================================================
// INTERPRETED (produced by Person 2's analyzers)
// ============================================================================

export type DerivedStatus =
  | "not_started"
  | "in_progress"
  | "complete"
  | "possibly_blocked";

export interface EventTaskLink {
  link_id: string;
  project_id: string;
  event_id: string;
  task_id: string;
  method: "task_key" | "manual" | "llm";
  confidence: number;
  status: "confirmed" | "suggested" | "rejected";
  is_primary: boolean;
}

export interface DerivedTaskState {
  project_id: string;
  task_id: string;
  computed_status: DerivedStatus;
  override_status: DerivedStatus | null;
  effective_status: DerivedStatus; // override wins over computed
  confidence: number | null;
  evidence_event_ids: string[];
  last_activity_at: string | null;
  blocking_task_ids: string[];
  explanation: string | null;
  computation_method: "rules" | "llm" | "rules+llm";
  computed_at: string;
  override_by: string | null;
  override_at: string | null;
  override_reason: string | null;
  version: number; // send back on update for optimistic concurrency
}

export interface BranchState {
  repository_id: string;
  branch: string;
  project_id: string;
  status: "active" | "merged" | "deleted";
  head_sha: string | null;
  task_id: string | null;
  changed_files: string[];
  open_pr_number: number | null;
  last_activity_at: string | null;
}

export type SignalStatus = "active" | "resolved" | "dismissed";

export interface HealthSignal {
  signal_id: string;
  project_id: string;
  type:
    | "milestone_slipping"
    | "dependency_incomplete"
    | "must_have_no_activity"
    | "plan_state_disagreement"
    | "task_possibly_blocked";
  status: SignalStatus;
  severity: "info" | "warning" | "critical";
  title: string;
  explanation: string;
  related_task_ids: string[];
  related_milestone_ids: string[];
  evidence_event_ids: string[];
  detected_at: string;
  resolved_at: string | null;
}

export interface Collision {
  collision_id: string;
  project_id: string;
  repository_id: string;
  branch_a: string;
  branch_b: string;
  task_a_id: string | null;
  task_b_id: string | null;
  overlapping_files: string[];
  status: SignalStatus;
  detected_at: string;
  resolved_at: string | null;
}

export interface ReplanSuggestion {
  suggestion_id: string;
  project_id: string;
  based_on_plan_version: number;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  rationale: string;
  proposed_changes: Array<{ op: string; [key: string]: unknown }>;
  evidence_event_ids: string[];
  related_signal_ids: string[];
  generated_by: "rules" | "llm";
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export type TimelineKind =
  | "github_event"
  | "plan_change"
  | "task_override"
  | "signal_detected"
  | "signal_resolved"
  | "collision_detected"
  | "collision_resolved"
  | "replan_proposed"
  | "replan_reviewed"
  | "decision";

export interface TimelineItem {
  item_id: string;
  project_id: string;
  occurred_at: string;
  kind: TimelineKind;
  title: string;
  summary: string | null;
  actor: string | null;
  entity_type: string;
  entity_id: string;
  related_task_ids: string[];
}

// ============================================================================
// Frontend convenience: everything the workspace page needs in one object.
// Ask Person 1 whether GET /projects/:id can return this shape directly.
// ============================================================================

export interface ProjectWorkspace {
  project: Project;
  members: ProjectMember[];
  brief: ProjectBrief;
  milestones: Milestone[];
  tasks: Task[];
  dependencies: TaskDependency[];
}

// ============================================================================
// API envelopes (docs/api-contract.md §1, §4.5)
// ============================================================================

export interface Page<T> {
  items: T[];
  next_cursor: string | null; // opaque; pass back as ?cursor=
}

export interface ApiErrorBody {
  error: string; // human-readable, safe to show in the UI
  code?: string; // e.g. "23505" or "cycle"
  issues?: unknown[];
}
