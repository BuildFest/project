// Pure translation from GitHub webhook payloads to github_events rows. No I/O,
// so every rule here is unit-testable with a JSON fixture.
//
// external_event_id formats are documented next to github_events in
// db/schema.sql. They use only facts a later backfill can also see (ref, SHA,
// PR number), never the delivery ID, so webhook and backfill rows collapse.

export type EventType =
  | "push"
  | "commit"
  | "branch_created"
  | "branch_deleted"
  | "pull_request_opened"
  | "pull_request_updated"
  | "pull_request_closed"
  | "pull_request_merged"
  | "pull_request_reopened";

export interface CommitInfo {
  sha: string;
  message: string | null;
  author: string | null;
  url: string | null;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  head_branch: string;
  base_branch: string;
  url: string;
  merged: boolean;
}

export interface NormalizedEvent {
  event_type: EventType;
  external_event_id: string;
  actor: string | null;
  occurred_at: string;
  branch: string | null;
  commit: CommitInfo | null;
  pull_request: PullRequestInfo | null;
  changed_files: string[];
}

// Only the payload fields we read. GitHub sends far more.
interface PushCommit {
  id: string;
  message: string;
  timestamp: string;
  url: string;
  author: { name?: string; username?: string };
  added?: string[];
  removed?: string[];
  modified?: string[];
}

export interface PushPayload {
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  commits: PushCommit[];
  head_commit: PushCommit | null;
  sender?: { login: string };
  repository: { id: number; pushed_at?: number | string };
}

export interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    state: string;
    merged: boolean;
    html_url: string;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    merged_at: string | null;
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  sender?: { login: string };
  repository: { id: number };
}

const BRANCH_REF = "refs/heads/";

function filesOf(commit: PushCommit): string[] {
  return [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])];
}

function commitInfo(commit: PushCommit): CommitInfo {
  return {
    sha: commit.id,
    message: commit.message,
    author: commit.author.username ?? commit.author.name ?? null,
    url: commit.url,
  };
}

/**
 * A push fans out into up to three kinds of events:
 *   deleted          -> branch_deleted only
 *   created          -> branch_created, then push + commits
 *   ordinary push    -> push + one commit event per commit
 * Tag pushes (refs/tags/...) produce nothing.
 *
 * `receivedAt` is the fallback time for facts GitHub doesn't timestamp
 * (branch creation/deletion).
 */
export function normalizePush(payload: PushPayload, receivedAt: string): NormalizedEvent[] {
  if (!payload.ref.startsWith(BRANCH_REF)) return [];
  const branch = payload.ref.slice(BRANCH_REF.length);
  const actor = payload.sender?.login ?? null;
  const pushedAt =
    typeof payload.repository.pushed_at === "number"
      ? new Date(payload.repository.pushed_at * 1000).toISOString()
      : receivedAt;
  const base = { actor, branch, pull_request: null };

  if (payload.deleted) {
    return [{
      ...base,
      event_type: "branch_deleted",
      external_event_id: `${payload.ref}:${payload.before}`,
      occurred_at: pushedAt,
      commit: null,
      changed_files: [],
    }];
  }

  const events: NormalizedEvent[] = [];
  if (payload.created) {
    events.push({
      ...base,
      event_type: "branch_created",
      external_event_id: `${payload.ref}:${payload.after}`,
      occurred_at: pushedAt,
      commit: null,
      changed_files: [],
    });
  }

  const head = payload.head_commit;
  events.push({
    ...base,
    event_type: "push",
    external_event_id: `${payload.ref}:${payload.after}`,
    occurred_at: pushedAt,
    commit: head ? commitInfo(head) : { sha: payload.after, message: null, author: null, url: null },
    changed_files: [...new Set(payload.commits.flatMap(filesOf))].sort(),
  });

  for (const commit of payload.commits) {
    events.push({
      ...base,
      event_type: "commit",
      external_event_id: commit.id,
      occurred_at: commit.timestamp,
      commit: commitInfo(commit),
      changed_files: [...new Set(filesOf(commit))].sort(),
    });
  }
  return events;
}

/**
 * opened / reopened / synchronize (new commits) / closed (split into merged
 * vs. closed-unmerged). Every other action (labeled, edited, assigned, ...)
 * returns null and the delivery is stored as "ignored".
 */
export function normalizePullRequest(payload: PullRequestPayload): NormalizedEvent | null {
  const pr = payload.pull_request;
  let eventType: EventType;
  let occurredAt: string;
  switch (payload.action) {
    case "opened":
      eventType = "pull_request_opened";
      occurredAt = pr.created_at;
      break;
    case "reopened":
      eventType = "pull_request_reopened";
      occurredAt = pr.updated_at;
      break;
    case "synchronize":
      eventType = "pull_request_updated";
      occurredAt = pr.updated_at;
      break;
    case "closed":
      eventType = pr.merged ? "pull_request_merged" : "pull_request_closed";
      occurredAt = (pr.merged ? pr.merged_at : pr.closed_at) ?? pr.updated_at;
      break;
    default:
      return null;
  }

  const action = eventType.slice("pull_request_".length);
  return {
    event_type: eventType,
    external_event_id: `pr:${pr.number}:${action}:${pr.head.sha}`,
    actor: payload.sender?.login ?? null,
    occurred_at: occurredAt,
    branch: pr.head.ref,
    commit: null,
    pull_request: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      head_branch: pr.head.ref,
      base_branch: pr.base.ref,
      url: pr.html_url,
      merged: pr.merged,
    },
    changed_files: [],
  };
}
