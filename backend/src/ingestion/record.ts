import type pg from "pg";
import { newId } from "../ids.js";
import { applyToBranchState } from "./branches.js";
import type { BranchRef } from "./compare.js";
import type { NormalizedEvent } from "./normalize.js";

export interface RecordResult {
  inserted: number;
  latest: string | null; // newest occurred_at among inserted events
  pushedBranches: BranchRef[]; // branches whose head may have moved
}

/**
 * The one write path for github_events, shared by webhooks and backfill:
 * insert (deduped by external_event_id), then fold each *new* event into
 * branch_states. Must run inside the caller's transaction.
 */
export async function recordEvents(
  tx: pg.PoolClient,
  repo: { repository_id: string; project_id: string },
  events: NormalizedEvent[],
  source: "webhook" | "backfill",
  deliveryId: string | null,
): Promise<RecordResult> {
  const result: RecordResult = { inserted: 0, latest: null, pushedBranches: [] };
  if (events.length === 0) return result;

  // Serializes event writers per project so seq order == commit order and
  // ?after_seq readers never skip a late-committing row (see the seq migration).
  await tx.query("select pg_advisory_xact_lock(hashtext('events:' || $1))", [repo.project_id]);

  for (const event of events) {
    const { rowCount } = await tx.query(
      `insert into github_events (event_id, project_id, repository_id, source, github_delivery_id, external_event_id,
                                  event_type, actor, occurred_at, branch, commit, pull_request, changed_files)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (repository_id, event_type, external_event_id) do nothing`,
      [
        newId("event"), repo.project_id, repo.repository_id, source, deliveryId, event.external_event_id,
        event.event_type, event.actor, event.occurred_at, event.branch, event.commit, event.pull_request,
        event.changed_files,
      ],
    );
    if (!rowCount) continue; // already known (redelivery, or seen by the other path)
    result.inserted++;
    if (!result.latest || event.occurred_at > result.latest) result.latest = event.occurred_at;
    await applyToBranchState(tx, repo.project_id, repo.repository_id, event);
    // A new head means the branch's changed files need recomputing.
    if (event.branch && (event.event_type === "push" || event.event_type === "branch_created")) {
      result.pushedBranches.push({ repositoryId: repo.repository_id, branch: event.branch });
    }
  }
  return result;
}
