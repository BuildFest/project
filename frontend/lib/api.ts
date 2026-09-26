// Mock API. Every screen talks to the backend ONLY through this file.
// When Person 1's endpoints exist, replace each function body with a fetch()
// call — the rest of the app won't need to change.

import { ProjectWorkspace } from "./types";

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
