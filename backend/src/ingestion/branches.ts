import type pg from "pg";
import type { EventType, NormalizedEvent } from "./normalize.js";

export type BranchStatus = "active" | "merged" | "deleted";

/**
 * The branch lifecycle: given the branch's current status (null if we've
 * never seen it) and a new event on it, what status does it end up in?
 *
 * Events that reach here: branch_created, branch_deleted, push, and every
 * pull_request_* type. (commit events never do; the push that carried them
 * already updated the branch.)
 */
export function nextBranchStatus(current: BranchStatus | null, eventType: EventType): BranchStatus {
  switch (eventType) {
    // Merge-then-delete is GitHub's normal flow; "merged" is the more useful
    // fact to keep. Both are excluded from collision detection anyway.
    case "branch_deleted":
      return current === "merged" ? "merged" : "deleted";
    case "pull_request_merged":
      return "merged";
    // New work (or a re-created branch) makes it active again, even after a merge.
    case "branch_created":
    case "push":
    case "pull_request_opened":
    case "pull_request_reopened":
    case "pull_request_updated":
      return "active";
    // Closing a PR unmerged doesn't change the branch; the work is still there.
    case "pull_request_closed":
    case "commit":
      return current ?? "active";
  }
}

interface BranchRow {
  status: BranchStatus;
  head_sha: string | null;
  open_pr_number: number | null;
  last_activity_at: Date | null;
}

/**
 * Folds one newly inserted github_event into branch_states. Called only for
 * events that were actually inserted (not deduped), so each fact is applied
 * once.
 */
export async function applyToBranchState(
  tx: pg.PoolClient,
  projectId: string,
  repositoryId: string,
  event: NormalizedEvent,
): Promise<void> {
  if (!event.branch || event.event_type === "commit") return;

  const { rows } = await tx.query<BranchRow>(
    `select status, head_sha, open_pr_number, last_activity_at
       from branch_states where repository_id = $1 and branch = $2 for update`,
    [repositoryId, event.branch],
  );
  const current = rows[0] ?? null;

  let headSha = current?.head_sha ?? null;
  if (event.event_type === "push") headSha = event.commit?.sha ?? headSha;

  let openPr = current?.open_pr_number ?? null;
  const prNumber = event.pull_request?.number;
  if (prNumber !== undefined) {
    const closes = event.event_type === "pull_request_closed" || event.event_type === "pull_request_merged";
    if (!closes) openPr = prNumber;
    else if (openPr === prNumber) openPr = null;
  }

  // Deliveries can arrive out of order; never move activity time backwards.
  const occurred = new Date(event.occurred_at);
  const lastActivity =
    current?.last_activity_at && current.last_activity_at > occurred ? current.last_activity_at : occurred;

  await tx.query(
    `insert into branch_states (repository_id, branch, project_id, status, head_sha, open_pr_number, last_activity_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (repository_id, branch) do update
       set status = excluded.status,
           head_sha = excluded.head_sha,
           open_pr_number = excluded.open_pr_number,
           last_activity_at = excluded.last_activity_at`,
    [repositoryId, event.branch, projectId, nextBranchStatus(current?.status ?? null, event.event_type), headSha, openPr, lastActivity],
  );
}
