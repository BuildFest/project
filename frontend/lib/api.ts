// Mock API. Every screen talks to the backend ONLY through this file.
// When Person 1's endpoints exist, replace each function body with a fetch()
// call — the rest of the app won't need to change.

import type { Milestone, ProjectWorkspace, Task, TaskDependency } from "./types";

const STORAGE_KEY = "pitcrew.mock.workspaces.v2";

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()}`;
}

function load(): ProjectWorkspace[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(all: ProjectWorkspace[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore — mock only */
  }
}

export async function listProjects(): Promise<ProjectWorkspace[]> {
  return load();
}

export async function getProject(projectId: string): Promise<ProjectWorkspace | undefined> {
  return load().find((w) => w.project.project_id === projectId);
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  task_key_prefix: string;
  deadline_at: string | null;
  members: { display_name: string; github_login: string | null }[];
  brief: string;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectWorkspace> {
  const now = new Date().toISOString();
  const project_id = newId("proj");
  const members = input.members.map((m, i) => ({
    member_id: newId("mem"),
    project_id,
    display_name: m.display_name,
    role_label: null,
    github_login: m.github_login,
    access_level: i === 0 ? ("owner" as const) : ("editor" as const),
    joined_at: now,
  }));

  const workspace: ProjectWorkspace = {
    project: {
      project_id,
      name: input.name,
      description: input.description ?? null,
      task_key_prefix: input.task_key_prefix,
      next_task_number: 1,
      created_by: members[0]?.member_id ?? "system",
      created_at: now,
      updated_at: now,
      deadline_at: input.deadline_at,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      status: "active",
      current_plan_version: null,
      primary_repository_id: null,
    },
    members,
    brief: {
      project_id,
      content: input.brief,
      content_format: "markdown",
      updated_at: now,
      updated_by: members[0]?.member_id ?? null,
    },
    milestones: [],
    tasks: [],
    dependencies: [],
  };

  save([...load(), workspace]);
  return workspace;
}

// ============================================================================
// Plan editing
// ============================================================================


// Load, change one workspace, save, and return a fresh copy for React state.
async function mutate(
  projectId: string,
  fn: (w: ProjectWorkspace) => void
): Promise<ProjectWorkspace> {
  const all = load();
  const w = all.find((x) => x.project.project_id === projectId);
  if (!w) throw new Error("Project not found");
  fn(w);
  w.project.updated_at = new Date().toISOString();
  save(all);
  return structuredClone(w);
}

export async function updateBrief(projectId: string, content: string) {
  return mutate(projectId, (w) => {
    w.brief.content = content;
    w.brief.updated_at = new Date().toISOString();
  });
}

export async function addMilestone(
  projectId: string,
  input: { name: string; target_at: string | null }
) {
  return mutate(projectId, (w) => {
    const m: Milestone = {
      milestone_id: newId("ms"),
      project_id: projectId,
      name: input.name,
      description: null,
      target_at: input.target_at,
      sort_order: w.milestones.length,
      archived: false,
    };
    w.milestones.push(m);
  });
}

export async function archiveMilestone(projectId: string, milestoneId: string) {
  return mutate(projectId, (w) => {
    const m = w.milestones.find((x) => x.milestone_id === milestoneId);
    if (m) m.archived = true;
    for (const t of w.tasks) if (t.milestone_id === milestoneId) t.milestone_id = null;
  });
}

export async function addTask(projectId: string, title: string) {
  return mutate(projectId, (w) => {
    const n = w.project.next_task_number;
    w.project.next_task_number = n + 1;
    const t: Task = {
      task_id: newId("task"),
      task_key: `${w.project.task_key_prefix}-${n}`,
      project_id: projectId,
      title,
      description: null,
      owner_member_id: null,
      priority: "medium",
      scope: "must_have",
      plan_status: "not_started",
      milestone_id: null,
      target_at: null,
      sort_order: w.tasks.length,
      archived: false,
    };
    w.tasks.push(t);
  });
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "description"
    | "owner_member_id"
    | "priority"
    | "scope"
    | "plan_status"
    | "milestone_id"
    | "target_at"
    | "archived"
  >
>;

export async function updateTask(projectId: string, taskId: string, patch: TaskPatch) {
  return mutate(projectId, (w) => {
    const t = w.tasks.find((x) => x.task_id === taskId);
    if (!t) throw new Error("Task not found");
    Object.assign(t, patch);
  });
}

// True if "taskId depends on dependsOnId" would create a loop
// (i.e. dependsOnId already depends, directly or indirectly, on taskId).
export function wouldCreateCycle(
  deps: TaskDependency[],
  taskId: string,
  dependsOnId: string
): boolean {
  if (taskId === dependsOnId) return true;
  const stack = [dependsOnId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of deps) if (d.task_id === cur) stack.push(d.depends_on_task_id);
  }
  return false;
}

export async function addDependency(projectId: string, taskId: string, dependsOnId: string) {
  return mutate(projectId, (w) => {
    const exists = w.dependencies.some(
      (d) => d.task_id === taskId && d.depends_on_task_id === dependsOnId
    );
    if (exists) return;
    if (wouldCreateCycle(w.dependencies, taskId, dependsOnId)) {
      throw new Error("That dependency would create a loop");
    }
    w.dependencies.push({
      project_id: projectId,
      task_id: taskId,
      depends_on_task_id: dependsOnId,
      dependency_type: "requires",
    });
  });
}

export async function removeDependency(projectId: string, taskId: string, dependsOnId: string) {
  return mutate(projectId, (w) => {
    w.dependencies = w.dependencies.filter(
      (d) => !(d.task_id === taskId && d.depends_on_task_id === dependsOnId)
    );
  });
}
