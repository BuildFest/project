// Mock-mode stand-ins for timeline, decisions, branches and the maintainer
// (contract §4.6, §5.0, §6). Everything is derived from the sample events in
// mockApi.ts so the views agree with each other. Only lib/api.ts imports this.

import { getState } from "./mockAnalyzer";
import { mockEventsFor, mockWorkspace } from "./mockApi";
import type { BranchState, Decision, GithubEvent, MaintainerNote, Page, TimelineItem } from "./types";

const DECISIONS_KEY = "pitcrew.mock.decisions.v1";
const NOTES_KEY = "pitcrew.mock.maintainer.v1";

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()}`;
}

function read<T>(key: string, pid: string): T[] {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, T[]>)[pid] ?? [];
  } catch {
    return [];
  }
}

function prepend<T>(key: string, pid: string, row: T) {
  try {
    const all = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, T[]>;
    all[pid] = [row, ...(all[pid] ?? [])];
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* ignore — mock only */
  }
}

// ---- timeline --------------------------------------------------------------

// Same wording as backend/src/ingestion/timeline.ts. Commits nested in a push
// get no row, matching the webhook path.
function eventItem(e: GithubEvent): TimelineItem | null {
  const who = e.actor ?? "Someone";
  const pr = e.pull_request;
  const title =
    e.event_type === "push" ? `${who} pushed to ${e.branch}`
    : e.event_type === "branch_created" ? `${who} created branch ${e.branch}`
    : e.event_type === "branch_deleted" ? `${who} deleted branch ${e.branch}`
    : pr && e.event_type !== "pull_request_updated"
      ? `${who} ${e.event_type.replace("pull_request_", "")} PR #${pr.number}: ${pr.title}`
      : null;
  if (!title) return null;
  return {
    item_id: `tl_${e.event_id.slice("event_".length)}`,
    project_id: e.project_id,
    occurred_at: e.occurred_at,
    kind: "github_event",
    title,
    summary: null,
    actor: e.actor,
    entity_type: "github_events",
    entity_id: e.event_id,
    related_task_ids: [],
  };
}

export async function listTimeline(
  projectId: string,
  opts: { limit?: number; cursor?: string | null; task_id?: string } = {}
): Promise<Page<TimelineItem>> {
  const w = mockWorkspace(projectId);
  const decisions: TimelineItem[] = read<Decision>(DECISIONS_KEY, projectId).map((d) => ({
    item_id: `tl_${d.decision_id}`,
    project_id: projectId,
    occurred_at: d.decided_at,
    kind: "decision",
    title: `Decision: ${d.title}`,
    summary: d.body,
    actor: d.decided_by,
    entity_type: "decisions",
    entity_id: d.decision_id,
    related_task_ids: d.related_task_ids,
  }));
  const all = [...mockEventsFor(w).map(eventItem).filter((x): x is TimelineItem => !!x), ...decisions]
    .filter((i) => !opts.task_id || i.related_task_ids.includes(opts.task_id))
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

  const limit = Math.min(opts.limit ?? 50, 200);
  const start = opts.cursor ? Number(opts.cursor) : 0;
  return {
    items: all.slice(start, start + limit),
    next_cursor: start + limit < all.length ? String(start + limit) : null,
  };
}

export async function createDecision(
  projectId: string,
  input: { title: string; body?: string; member_id: string; related_task_ids?: string[] }
): Promise<Decision> {
  const d: Decision = {
    decision_id: newId("dec"),
    project_id: projectId,
    title: input.title.trim(),
    body: input.body?.trim() || null,
    decided_by: input.member_id,
    decided_at: new Date().toISOString(),
    related_task_ids: [...new Set(input.related_task_ids ?? [])],
    suggestion_id: null,
  };
  prepend(DECISIONS_KEY, projectId, d);
  return d;
}

export async function listDecisions(projectId: string): Promise<Decision[]> {
  return read<Decision>(DECISIONS_KEY, projectId).sort(
    (a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at),
  );
}

// ---- branches --------------------------------------------------------------

export async function listBranches(projectId: string): Promise<BranchState[]> {
  const w = mockWorkspace(projectId);
  const events = [...mockEventsFor(w)].reverse(); // oldest first
  const keyRe = new RegExp(`\\b(${w.project.task_key_prefix}-\\d+)\\b`, "i");
  const byName = new Map<string, BranchState>();

  for (const e of events) {
    const name = e.pull_request?.head_branch ?? e.branch;
    if (!name) continue;
    const key = name.match(keyRe)?.[1]?.toUpperCase();
    const b = byName.get(name) ?? {
      repository_id: e.repository_id,
      branch: name,
      project_id: projectId,
      status: "active",
      head_sha: null,
      task_id: w.tasks.find((t) => t.task_key.toUpperCase() === key)?.task_id ?? null,
      changed_files: [],
      open_pr_number: null,
      last_activity_at: null,
    };
    b.last_activity_at = e.occurred_at;
    if (e.commit) b.head_sha = e.commit.sha;
    if (name !== "main") b.changed_files = [...new Set([...b.changed_files, ...e.changed_files])];
    if (e.event_type === "branch_deleted") b.status = "deleted";
    if (e.event_type === "pull_request_opened" || e.event_type === "pull_request_reopened") b.open_pr_number = e.pull_request!.number;
    if (e.event_type === "pull_request_closed" || e.event_type === "pull_request_merged") b.open_pr_number = null;
    if (e.event_type === "pull_request_merged") b.status = "merged";
    byName.set(name, b);
  }

  const rank = { active: 0, merged: 1, deleted: 2 };
  return [...byName.values()].sort(
    (a, b) => rank[a.status] - rank[b.status] || (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "")
  );
}

// ---- maintainer ------------------------------------------------------------

export async function listMaintainerNotes(projectId: string): Promise<MaintainerNote[]> {
  return read<MaintainerNote>(NOTES_KEY, projectId);
}

async function note(projectId: string, kind: MaintainerNote["kind"], question: string | null) {
  const state = await getState(projectId);
  const inProgress = state.tasks.filter((t) => t.effective_status === "in_progress").length;
  const body =
    `${inProgress} task${inProgress === 1 ? "" : "s"} in progress, ` +
    `${state.signals.length} active risk${state.signals.length === 1 ? "" : "s"}, ` +
    `${state.collisions.length} possible collision${state.collisions.length === 1 ? "" : "s"}.` +
    (question ? " (Sample data: connect the backend for real answers.)" : "");
  const n: MaintainerNote = {
    note_id: newId("note"),
    project_id: projectId,
    kind,
    title: kind === "digest" ? "Project digest" : "Answer",
    body,
    question,
    citations: state.signals.slice(0, 3).map((s) => ({ type: "signal", id: s.signal_id })),
    generated_by: "rules",
    created_at: new Date().toISOString(),
    error: null,
  };
  prepend(NOTES_KEY, projectId, n);
  return n;
}

export const generateDigest = (projectId: string) => note(projectId, "digest", null);
export const askPitCrew = (projectId: string, question: string) => note(projectId, "answer", question.trim());
