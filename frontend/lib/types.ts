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
  // Ingestion health, computed by the backend on read (contract §4.2).
  // Optional: repositories saved by older mock data don't have them.
  last_delivery_at?: string | null;
  failed_deliveries?: number;
  ingestion_health?: "waiting" | "live" | "degraded";
  // Latest history import (contract §4.3); null = never run.
  backfill_status?: "running" | "succeeded" | "partial" | "failed" | null;
  backfill_error?: string | null;
}

export interface DeliveryRetryResult {
  retried: number;
  succeeded: number;
  still_failed: number;
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
  reason?: string | null; // why the link was made (AI suggestions); contract §5.1
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

export interface RiskHistoryItem {
  risk_id: string;
  kind: "signal" | "collision";
  title: string;
  description: string;
  status: SignalStatus;
  severity: "info" | "warning" | "critical";
  related_task_ids: string[];
  detected_at: string;
  resolved_at: string | null;
  detection_event_id: string | null;
  resolution_event_id: string | null;
}

export interface ReplanSuggestion {
  suggestion_id: string;
  project_id: string;
  based_on_plan_version: number;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  rationale: string;
  proposed_changes: PlanChange[];
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

// ============================================================================
// Project intelligence (docs/api-contract.md §5)
// ============================================================================

export interface ProjectState {
  computed_at: string | null; // latest analyzer write; null if never analyzed
  tasks: DerivedTaskState[]; // one per analyzed, non-archived task
  signals: HealthSignal[]; // active only
  collisions: Collision[]; // active only
  // Suggested links awaiting review, newest event first. Ones at >= 0.8
  // confidence already count toward derived status (as AI-inferred).
  pending_links: Array<EventTaskLink & { event: GithubEvent }>;
  open_replans: number;
}

export interface PlanAgentResult {
  summary?: string;
  milestone_count?: number;
  task_count?: number;
  generated_by?: "llm";
  plan_version?: number;
  analysis?: {
    states?: number;
    signals?: number;
    collisions?: number;
    aiApplied?: boolean;
    aiError?: string | null;
    replan?: { created: boolean; suggestionId: string | null; generatedBy: "rules" | "llm" | null; reason: string } | null;
    replanError?: string | null;
  };
  workspace: ProjectWorkspace;
}

export interface TaskEvidence {
  task: Task;
  state: DerivedTaskState | null;
  blocking_tasks: Array<{ task: Task; state: DerivedTaskState | null }>;
  links: Array<EventTaskLink & { event: GithubEvent }>; // not rejected, newest first
  signals: HealthSignal[]; // active, mentioning this task
}

// Contract §5.0 — digests and Ask Pit Crew answers. Notes only; they never
// change the plan.
export interface MaintainerCitation {
  type: "task" | "event" | "signal" | "collision" | "replan";
  id: string;
}

export interface MaintainerNote {
  note_id: string;
  project_id: string;
  kind: "digest" | "answer";
  title: string;
  body: string;
  question: string | null; // set on answers
  citations: MaintainerCitation[];
  generated_by: "rules" | "llm";
  created_at: string;
  error?: string | null; // POST responses only: why the model fell back to rules
}

// Contract §5.8 — pre-merge coordination notes, one per PR opened/updated/reopened.
export interface CoordinationFact {
  id: string;
  kind: "collision_risk" | "incomplete_dependency" | "scope" | "plan_signal";
  summary: string;
  evidence_event_ids: string[];
}

export interface PrNote {
  note_id: string;
  project_id: string;
  repository_id: string;
  source_event_id: string;
  pull_request_number: number;
  branch: string;
  task_id: string | null;
  note: string;
  facts: CoordinationFact[];
  evidence_event_ids: string[];
  generated_by: "rules" | "llm";
  created_at: string;
}

// Contract §6.2
export interface Decision {
  decision_id: string;
  project_id: string;
  title: string;
  body: string | null;
  decided_by: string | null; // member_id
  decided_at: string;
  related_task_ids: string[];
  suggestion_id: string | null; // set when the decision came from a replan
}

// Contract §4.1 — returned once when a repository is connected.
export interface ConnectRepositoryResult {
  repository: Repository;
  webhook_url: string;
  webhook_secret: string; // only ever shown here; GET never returns it
}

// Contract §5.7 — the closed set of plan operations a replan can propose.
export type PlanChangeTaskFields = Partial<{
  title: string;
  description: string | null;
  owner_member_id: string | null;
  priority: Priority;
  scope: Scope;
  plan_status: PlanStatus;
  milestone_id: string | null;
  target_at: string | null;
  sort_order: number;
}>;

export type PlanChange =
  | { op: "update_task"; task_id: string; changes: PlanChangeTaskFields }
  | { op: "create_task"; task: PlanChangeTaskFields & { title: string } }
  | { op: "add_dependency"; task_id: string; depends_on_task_id: string }
  | { op: "remove_dependency"; task_id: string; depends_on_task_id: string }
  | { op: "update_milestone"; milestone_id: string; changes: { target_at?: string | null; name?: string } };
