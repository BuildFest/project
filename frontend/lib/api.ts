// The ONLY file components use to talk to the backend.
//
// If NEXT_PUBLIC_API_URL is set (e.g. http://localhost:8787), every call goes to
// the real API described in docs/api-contract.md. Otherwise it falls back to the
// in-browser mock in lib/mockApi.ts so the UI still works without a backend.

import * as mock from "./mockApi";
import type {
  ApiErrorBody,
  GithubEvent,
  Milestone,
  Page,
  ProjectWorkspace,
  Task,
  TaskDependency,
} from "./types";

export { wouldCreateCycle } from "./mockApi";
export type { CreateProjectInput, TaskPatch } from "./mockApi";
import type { CreateProjectInput, TaskPatch } from "./mockApi";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, "") || "";
export const usingMockApi = !API_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
  }
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`Can't reach the Pit Crew API at ${API_URL}. Is the backend running?`, 0);
  }
  if (!res.ok) {
    let err: ApiErrorBody = { error: `Request failed (${res.status})` };
    try {
      err = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(err.error, res.status, err.code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;

// ---- projects ---------------------------------------------------------------

export async function listProjects(): Promise<ProjectWorkspace[]> {
  if (usingMockApi) return mock.listProjects();
  return http<ProjectWorkspace[]>("GET", "/projects");
}

export async function getProject(projectId: string): Promise<ProjectWorkspace | undefined> {
  if (usingMockApi) return mock.getProject(projectId);
  try {
    return await http<ProjectWorkspace>("GET", `/projects/${enc(projectId)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

async function reload(projectId: string): Promise<ProjectWorkspace> {
  const w = await getProject(projectId);
  if (!w) throw new ApiError("Project not found", 404);
  return w;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectWorkspace> {
  if (usingMockApi) return mock.createProject(input);
  return http<ProjectWorkspace>("POST", "/projects", input);
}

// ---- plan (mutations return the refreshed workspace) ------------------------

export async function updateBrief(projectId: string, content: string) {
  if (usingMockApi) return mock.updateBrief(projectId, content);
  await http("PUT", `/projects/${enc(projectId)}/brief`, { content });
  return reload(projectId);
}

export async function addMilestone(
  projectId: string,
  input: { name: string; target_at: string | null }
) {
  if (usingMockApi) return mock.addMilestone(projectId, input);
  await http<Milestone>("POST", `/projects/${enc(projectId)}/milestones`, input);
  return reload(projectId);
}

export async function archiveMilestone(projectId: string, milestoneId: string) {
  if (usingMockApi) return mock.archiveMilestone(projectId, milestoneId);
  await http<Milestone>("PATCH", `/projects/${enc(projectId)}/milestones/${enc(milestoneId)}`, {
    archived: true,
  });
  return reload(projectId);
}

export async function addTask(projectId: string, title: string) {
  if (usingMockApi) return mock.addTask(projectId, title);
  await http<Task>("POST", `/projects/${enc(projectId)}/tasks`, { title });
  return reload(projectId);
}

export async function updateTask(projectId: string, taskId: string, patch: TaskPatch) {
  if (usingMockApi) return mock.updateTask(projectId, taskId, patch);
  await http<Task>("PATCH", `/projects/${enc(projectId)}/tasks/${enc(taskId)}`, patch);
  return reload(projectId);
}

export async function addDependency(projectId: string, taskId: string, dependsOnId: string) {
  if (usingMockApi) return mock.addDependency(projectId, taskId, dependsOnId);
  await http<TaskDependency>("POST", `/projects/${enc(projectId)}/dependencies`, {
    task_id: taskId,
    depends_on_task_id: dependsOnId,
  });
  return reload(projectId);
}

export async function removeDependency(projectId: string, taskId: string, dependsOnId: string) {
  if (usingMockApi) return mock.removeDependency(projectId, taskId, dependsOnId);
  await http<void>(
    "DELETE",
    `/projects/${enc(projectId)}/dependencies/${enc(taskId)}/${enc(dependsOnId)}`
  );
  return reload(projectId);
}

// ---- repository activity (contract §4.5) -------------------------------------

export async function listEvents(
  projectId: string,
  opts: { branch?: string; limit?: number; cursor?: string | null } = {}
): Promise<Page<GithubEvent>> {
  if (usingMockApi) return mock.listEvents(projectId, opts);
  const q = new URLSearchParams();
  if (opts.branch) q.set("branch", opts.branch);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.cursor) q.set("cursor", opts.cursor);
  const qs = q.toString();
  return http<Page<GithubEvent>>("GET", `/projects/${enc(projectId)}/events${qs ? `?${qs}` : ""}`);
}
