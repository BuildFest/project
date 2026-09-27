// The ONLY file components use to talk to the backend.
//
// If NEXT_PUBLIC_API_URL is set (e.g. http://localhost:8787), every call goes to
// the real API described in docs/api-contract.md. Otherwise it falls back to the
// in-browser mock in lib/mockApi.ts so the UI still works without a backend.

import * as activity from "./mockActivity";
import * as analyzer from "./mockAnalyzer";
import * as mock from "./mockApi";
import type {
  AiRun,
  ApiErrorBody,
  BranchState,
  ReplanSuggestion,
  ConnectRepositoryResult,
  Decision,
  EventTaskLink,
  DeliveryRetryResult,
  Repository,
  RiskHistoryItem,
  DerivedStatus,
  DerivedTaskState,
  MaintainerNote,
  ProjectState,
  PrNote,
  TaskEvidence,
  GithubEvent,
  Milestone,
  PlanAgentResult,
  Page,
  ReportedFailure,
  ProjectWorkspace,
  StatusMove,
  Task,
  TaskDependency,
  TimelineItem,
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

// Active first, then merged, then deleted (contract §4.6). Not paginated.
export async function listBranches(projectId: string): Promise<BranchState[]> {
  if (usingMockApi) return activity.listBranches(projectId);
  return http<BranchState[]>("GET", `/projects/${enc(projectId)}/branches`);
}

// ---- timeline and decisions (contract §6) ------------------------------------

export async function listTimeline(
  projectId: string,
  opts: { limit?: number; cursor?: string | null; task_id?: string; branch?: string } = {}
): Promise<Page<TimelineItem>> {
  if (usingMockApi) return activity.listTimeline(projectId, opts);
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.task_id) q.set("task_id", opts.task_id);
  if (opts.branch) q.set("branch", opts.branch);
  const qs = q.toString();
  return http<Page<TimelineItem>>("GET", `/projects/${enc(projectId)}/timeline${qs ? `?${qs}` : ""}`);
}

export async function listDecisions(projectId: string): Promise<Decision[]> {
  if (usingMockApi) return activity.listDecisions(projectId);
  return http<Decision[]>("GET", `/projects/${enc(projectId)}/decisions`);
}

export async function createDecision(
  projectId: string,
  input: { title: string; body?: string; member_id: string; related_task_ids?: string[] }
): Promise<Decision> {
  if (usingMockApi) return activity.createDecision(projectId, input);
  return http<Decision>("POST", `/projects/${enc(projectId)}/decisions`, input);
}

export async function createManualLink(
  projectId: string,
  input: { event_id: string; task_id: string; member_id: string }
): Promise<EventTaskLink> {
  if (usingMockApi) {
    return {
      link_id: `link_${Date.now()}`,
      project_id: projectId,
      event_id: input.event_id,
      task_id: input.task_id,
      method: "manual",
      confidence: 1,
      status: "confirmed",
      is_primary: false,
    };
  }
  return http<EventTaskLink>("POST", `/projects/${enc(projectId)}/links`, input);
}

// ---- project intelligence (contract §5) --------------------------------------


export async function getState(projectId: string): Promise<ProjectState> {
  if (usingMockApi) return analyzer.getState(projectId);
  return http<ProjectState>("GET", `/projects/${enc(projectId)}/state`);
}

export async function bootstrapPlanFromBrief(projectId: string, memberId: string | null): Promise<PlanAgentResult> {
  if (usingMockApi) return mock.bootstrapPlanFromBrief(projectId);
  return http<PlanAgentResult>("POST", `/projects/${enc(projectId)}/plan-agent/bootstrap`, { member_id: memberId });
}

export async function listStatusMoves(projectId: string): Promise<StatusMove[]> {
  if (usingMockApi) return [];
  return http<StatusMove[]>("GET", `/projects/${enc(projectId)}/status-moves`);
}

export async function undoStatusMove(projectId: string, moveId: string, memberId: string): Promise<StatusMove> {
  if (usingMockApi) throw new Error("Undo needs the live backend.");
  return http<StatusMove>("POST", `/projects/${enc(projectId)}/status-moves/${enc(moveId)}/undo`, { member_id: memberId });
}

export async function runPlanningAgent(projectId: string, memberId: string | null): Promise<PlanAgentResult> {
  if (usingMockApi) return { workspace: await mock.getProject(projectId) as ProjectWorkspace };
  return http<PlanAgentResult>("POST", `/projects/${enc(projectId)}/plan-agent/run`, { member_id: memberId });
}

export async function listRisks(
  projectId: string,
  opts: { status?: "all" | "active" | "resolved" | "dismissed"; limit?: number } = {}
): Promise<RiskHistoryItem[]> {
  if (usingMockApi) {
    const state = await analyzer.getState(projectId);
    return [
      ...state.signals.map((signal) => ({
        risk_id: signal.signal_id, kind: "signal" as const, title: signal.title,
        description: signal.explanation, status: signal.status, severity: signal.severity,
        related_task_ids: signal.related_task_ids, detected_at: signal.detected_at,
        resolved_at: signal.resolved_at, detection_event_id: null, resolution_event_id: null,
      })),
      ...state.collisions.map((collision) => ({
        risk_id: collision.collision_id, kind: "collision" as const,
        title: `Overlapping work on ${collision.branch_a} and ${collision.branch_b}`,
        description: `${collision.overlapping_files.length} shared file${collision.overlapping_files.length === 1 ? "" : "s"}`,
        status: collision.status, severity: "warning" as const,
        related_task_ids: [collision.task_a_id, collision.task_b_id].filter((id): id is string => id !== null),
        detected_at: collision.detected_at, resolved_at: collision.resolved_at,
        detection_event_id: null, resolution_event_id: null,
      })),
    ].filter((risk) => !opts.status || opts.status === "all" || risk.status === opts.status).slice(0, opts.limit ?? 20);
  }
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return http<RiskHistoryItem[]>("GET", `/projects/${enc(projectId)}/risks${qs ? `?${qs}` : ""}`);
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

// Confirms or rejects a suggested event–task link (§5.5). 404 if someone
// else already reviewed it.
export async function reviewLink(
  projectId: string,
  linkId: string,
  status: "confirmed" | "rejected",
  memberId: string
): Promise<void> {
  if (usingMockApi) return analyzer.reviewLink(projectId, linkId, status);
  await http("PATCH", `/projects/${enc(projectId)}/links/${enc(linkId)}`, { status, member_id: memberId });
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

// ---- maintainer and Ask Pit Crew (contract §5.0, §5.8) -----------------------
// Notes only: none of these ever change the plan.

export async function listMaintainerNotes(projectId: string): Promise<MaintainerNote[]> {
  if (usingMockApi) return activity.listMaintainerNotes(projectId);
  return http<MaintainerNote[]>("GET", `/projects/${enc(projectId)}/maintainer/notes`);
}

export async function generateDigest(projectId: string): Promise<MaintainerNote> {
  if (usingMockApi) return activity.generateDigest(projectId);
  return http<MaintainerNote>("POST", `/projects/${enc(projectId)}/maintainer/digest`);
}

// 429 when the per-project rate limit is hit; the error message says so.
export async function askPitCrew(projectId: string, question: string): Promise<MaintainerNote> {
  if (usingMockApi) return activity.askPitCrew(projectId, question);
  return http<MaintainerNote>("POST", `/projects/${enc(projectId)}/ask`, { question: question.trim() });
}

export async function listPrNotes(projectId: string, limit = 50): Promise<PrNote[]> {
  if (usingMockApi) return [];
  return http<PrNote[]>("GET", `/projects/${enc(projectId)}/pr-notes?limit=${limit}`);
}

// Every AI call the router makes, success or failure (contract §5.9) — the
// "Fails" filter uses status=failed. No mock: there's nothing to demo without
// a real model behind it.
export async function listAiRuns(
  projectId: string,
  opts: { status?: "success" | "failed"; limit?: number; cursor?: string | null } = {}
): Promise<Page<AiRun>> {
  if (usingMockApi) return { items: [], next_cursor: null };
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.cursor) q.set("cursor", opts.cursor);
  const qs = q.toString();
  return http<Page<AiRun>>("GET", `/projects/${enc(projectId)}/ai-runs${qs ? `?${qs}` : ""}`);
}

// Failures that aren't an AI call (contract §6.3): unhandled 500s the API
// actually hit, or incidents a human logs — a merge conflict, a build or
// deploy failure. No mock: nothing runs server-side to fail in mock mode.
export async function listFailures(
  projectId: string,
  opts: { category?: ReportedFailure["category"]; limit?: number; cursor?: string | null } = {}
): Promise<Page<ReportedFailure>> {
  if (usingMockApi) return { items: [], next_cursor: null };
  const q = new URLSearchParams();
  if (opts.category) q.set("category", opts.category);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.cursor) q.set("cursor", opts.cursor);
  const qs = q.toString();
  return http<Page<ReportedFailure>>("GET", `/projects/${enc(projectId)}/failures${qs ? `?${qs}` : ""}`);
}

export async function reportFailure(
  projectId: string,
  input: { category: ReportedFailure["category"]; title: string; detail?: string; member_id: string }
): Promise<ReportedFailure> {
  if (usingMockApi) throw new ApiError("Can't log a failure in demo mode — nothing runs server-side to fail.", 0);
  return http<ReportedFailure>("POST", `/projects/${enc(projectId)}/failures`, input);
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

// Re-runs deliveries GitHub sent that failed processing (contract §4.7).
export async function retryFailedDeliveries(projectId: string, repositoryId: string): Promise<DeliveryRetryResult> {
  if (usingMockApi) return mock.retryFailedDeliveries(projectId, repositoryId);
  return http("POST", `/projects/${enc(projectId)}/repositories/${enc(repositoryId)}/deliveries/retry`);
}

// ---- plan versions (contract §3.7) -------------------------------------------

// "Save plan": snapshots the current plan as the next version. Replan
// suggestions are always relative to a saved version, so none appear until
// the first save.
export async function savePlanVersion(projectId: string, input: { summary?: string; member_id?: string | null }) {
  if (usingMockApi) return mock.savePlanVersion(projectId);
  await http("POST", `/projects/${enc(projectId)}/plan-versions`, {
    summary: input.summary?.trim() || null,
    member_id: input.member_id ?? null,
  });
  return reload(projectId);
}

// ---- team members (contract §2.6–2.8) ------------------------------------------

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
  await http("DELETE", `/projects/${enc(projectId)}/members/${enc(memberId)}`);
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
