import type { Queryable } from "../db.js";
import type {
  BranchState, DerivedTaskState, EventTaskLink, GithubEvent, Milestone, Project,
  Repository, StoredCollision, StoredHealthSignal, Task, TaskDependency, TaskOverride,
} from "./types.js";

export interface ProjectSnapshot {
  project: Project;
  repositories: Repository[];
  milestones: Milestone[];
  tasks: Task[];
  dependencies: TaskDependency[];
  events: GithubEvent[];
  links: EventTaskLink[];
  branches: BranchState[];
  overrides: TaskOverride[];
  storedStates: DerivedTaskState[];
  openSignals: StoredHealthSignal[];
  openCollisions: StoredCollision[];
  // When the planning agent last moved task statuses; null = never.
  planSyncedAt?: Date | null;
}

export async function loadProjectSnapshot(db: Queryable, projectId: string): Promise<ProjectSnapshot> {
  const project = await db.query<Project>(
    "select project_id, task_key_prefix, created_at, deadline_at from projects where project_id = $1",
    [projectId],
  );
  if (!project.rows[0]) throw new Error(`project ${projectId} not found`);
  const [repositories, milestones, tasks, dependencies, events, links, branches, states, signals, collisions, sync] = await Promise.all([
    db.query<Repository>("select repository_id, default_branch from repositories where project_id = $1", [projectId]),
    db.query<Milestone>("select milestone_id, name, target_at, archived from milestones where project_id = $1", [projectId]),
    db.query<Task>(`select task_id, task_key, title, description, priority, scope, plan_status, plan_status_set_by,
                           milestone_id, target_at, created_at, archived from tasks where project_id = $1`, [projectId]),
    db.query<TaskDependency>("select task_id, depends_on_task_id from task_dependencies where project_id = $1", [projectId]),
    db.query<GithubEvent>(`select event_id, repository_id, event_type, actor, occurred_at, branch,
                                  commit, pull_request, changed_files from github_events
                             where project_id = $1 order by occurred_at, event_id`, [projectId]),
    db.query<EventTaskLink>(`select event_id, task_id, method, confidence, status, is_primary
                               from event_task_links where project_id = $1`, [projectId]),
    db.query<BranchState>(`select repository_id, branch, status, task_id, changed_files,
                                  open_pr_number, last_activity_at from branch_states where project_id = $1`, [projectId]),
    db.query<DerivedTaskState>(`select task_id, computed_status, override_status, effective_status, confidence,
                                      evidence_event_ids, last_activity_at, blocking_task_ids, explanation, computation_method
                                 from derived_task_states where project_id = $1`, [projectId]),
    db.query<StoredHealthSignal>(`select signal_id, type, status, severity, title, explanation, related_task_ids,
                                         related_milestone_ids, evidence_event_ids, fingerprint
                                    from health_signals where project_id = $1 and status <> 'resolved'`, [projectId]),
    db.query<StoredCollision>(`select collision_id, repository_id, branch_a, branch_b, task_a_id, task_b_id,
                                      overlapping_files, status from collisions
                                 where project_id = $1 and status <> 'resolved'`, [projectId]),
    db.query<{ synced_at: Date }>("select synced_at from plan_sync_state where project_id = $1", [projectId]),
  ]);
  return {
    project: project.rows[0], repositories: repositories.rows, milestones: milestones.rows,
    tasks: tasks.rows, dependencies: dependencies.rows, events: events.rows, links: links.rows,
    branches: branches.rows,
    overrides: states.rows.filter((row) => row.override_status !== null).map((row) => ({ task_id: row.task_id, override_status: row.override_status! })),
    storedStates: states.rows, openSignals: signals.rows, openCollisions: collisions.rows,
    planSyncedAt: sync.rows[0]?.synced_at ?? null,
  };
}
