// The ONLY file components use to talk to the backend.
//
// If NEXT_PUBLIC_API_URL is set (e.g. http://localhost:8787), every call goes to
// the real API described in docs/api-contract.md. Otherwise it falls back to the
// in-browser mock in lib/mockApi.ts so the UI still works without a backend.

import * as analyzer from "./mockAnalyzer";
import * as mock from "./mockApi";
import type {
  ApiErrorBody,
  ReplanSuggestion,
  ConnectRepositoryResult,
  Repository,
  DerivedStatus,
  DerivedTaskState,
  ProjectState,
  TaskEvidence,
  GithubEvent,
  Milestone,
  Page,
  ProjectWorkspace,
  Task,
  TaskDependency,
} from "./types";

export { wouldCreateCycle } from "./mockApi";
export type { CreateProjectInput, MemberInput, TaskPatch } from "./mockApi";
import type { CreateProjectInput, MemberInput, TaskPatch } from "./mockApi";

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

// ---- project intelligence (contract §5) --------------------------------------


export async function getState(projectId: string): Promise<ProjectState> {
  if (usingMockApi) return analyzer.getState(projectId);
  return http<ProjectState>("GET", `/projects/${enc(projectId)}/state`);
}

export async function getTaskEvidence(projectId: string, taskId: string): Promise<TaskEvidence> {
  if (usingMockApi) return analyzer.getTaskEvidence(projectId, taskId);
  return http<TaskEvidence>("GET", `/projects/${enc(projectId)}/tasks/${enc(taskId)}/evidence`);
}

// A human corrects Pit Crew's derived status (§5.3). `version` is the
// DerivedTaskState.version the user saw; a 409 means the analyzer re-ran.
export async function overrideTaskStatus(
  projectId: string,
  taskId: string,
  input: { override_status: DerivedStatus; reason?: string; member_id: string; version: number }
): Promise<void> {
  if (usingMockApi) return analyzer.setOverride(projectId, taskId, input);
  await http<DerivedTaskState>("PUT", `/projects/${enc(projectId)}/tasks/${enc(taskId)}/override`, input);
}

export async function clearTaskOverride(projectId: string, taskId: string): Promise<void> {
  if (usingMockApi) return analyzer.clearOverride(projectId, taskId);
  await http<DerivedTaskState>("DELETE", `/projects/${enc(projectId)}/tasks/${enc(taskId)}/override`);
}

export async function dismissSignal(projectId: string, signalId: string, memberId: string) {
  if (usingMockApi) return analyzer.dismiss(projectId, signalId);
  await http("PATCH", `/projects/${enc(projectId)}/signals/${enc(signalId)}`, {
    status: "dismissed",
    member_id: memberId,
  });
}

export async function dismissCollision(projectId: string, collisionId: string, memberId: string) {
  if (usingMockApi) return analyzer.dismiss(projectId, collisionId);
  await http("PATCH", `/projects/${enc(projectId)}/collisions/${enc(collisionId)}`, {
    status: "dismissed",
    member_id: memberId,
  });
}

// ---- repositories (contract §4.1–4.3) ----------------------------------------

export async function listRepositories(projectId: string): Promise<Repository[]> {
  if (usingMockApi) return mock.listRepositories(projectId);
  return http<Repository[]>("GET", `/projects/${enc(projectId)}/repositories`);
}

export async function connectRepository(projectId: string, fullName: string): Promise<ConnectRepositoryResult> {
  if (usingMockApi) return mock.connectRepository(projectId, fullName);
  return http<ConnectRepositoryResult>("POST", `/projects/${enc(projectId)}/repositories`, {
    full_name: fullName.trim(),
    make_primary: true,
  });
}

export async function startBackfill(projectId: string, repositoryId: string): Promise<{ started_at: string }> {
  if (usingMockApi) return mock.startBackfill(projectId, repositoryId);
  return http("POST", `/projects/${enc(projectId)}/repositories/${enc(repositoryId)}/backfill`);
}

// ---- team members (contract §2.6–2.7; remove is not in the contract yet) ------

export async function addMember(projectId: string, input: MemberInput) {
  if (usingMockApi) return mock.addMember(projectId, input);
  await http("POST", `/projects/${enc(projectId)}/members`, input);
  return reload(projectId);
}

export async function updateMember(projectId: string, memberId: string, patch: Partial<MemberInput>) {
  if (usingMockApi) return mock.updateMember(projectId, memberId, patch);
  await http("PATCH", `/projects/${enc(projectId)}/members/${enc(memberId)}`, patch);
  return reload(projectId);
}

export async function removeMember(projectId: string, memberId: string) {
  if (usingMockApi) return mock.removeMember(projectId, memberId);
  try {
    await http("DELETE", `/projects/${enc(projectId)}/members/${enc(memberId)}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
      throw new ApiError("Removing members isn't supported by the backend yet.", e.status);
    }
    throw e;
  }
  return reload(projectId);
}

// ---- replan suggestions (contract §5.7) ----------------------------------------

export async function listReplans(projectId: string): Promise<ReplanSuggestion[]> {
  if (usingMockApi) return analyzer.listReplans(projectId);
  return http<ReplanSuggestion[]>("GET", `/projects/${enc(projectId)}/replans?status=proposed`);
}

// Applies the changes to the plan (server-side, in one transaction) and
// returns the refreshed workspace plus the new plan version.
export async function acceptReplan(projectId: string, suggestionId: string, memberId: string) {
  let version: number;
  if (usingMockApi) {
    version = (await analyzer.acceptReplan(projectId, suggestionId)).plan_version;
  } else {
    const r = await http<{ suggestion: ReplanSuggestion; plan_version: number }>(
      "POST",
      `/projects/${enc(projectId)}/replans/${enc(suggestionId)}/accept`,
      { member_id: memberId }
    );
    version = r.plan_version;
  }
  return { workspace: await reload(projectId), plan_version: version };
}

export async function rejectReplan(projectId: string, suggestionId: string, memberId: string) {
  if (usingMockApi) return analyzer.rejectReplan(projectId, suggestionId);
  await http("POST", `/projects/${enc(projectId)}/replans/${enc(suggestionId)}/reject`, { member_id: memberId });
}
