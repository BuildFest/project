import type pg from "pg";
import { withTransaction, type Db } from "../db.js";
import type { BranchRef } from "./compare.js";
import {
  normalizePullRequest,
  normalizePush,
  type NormalizedEvent,
  type PullRequestPayload,
  type PushPayload,
} from "./normalize.js";
import { recordEvents } from "./record.js";

// Processing of one webhook delivery, shared by the live receiver and
// retries of stored failed deliveries.

export interface DeliveryInput {
  deliveryId: string;
  githubEvent: string;
  payload: any; // signed by GitHub, shape depends on githubEvent
  payloadJson: string;
  receivedAt: string;
}

type Repo = { repository_id: string; project_id: string };

export type ProcessResult =
  | { kind: "unknown_repository" }
  | { kind: "duplicate"; repos: Repo[] }
  | { kind: "processed"; repos: Repo[]; status: "normalized" | "ignored"; inserted: number; pushedBranches: BranchRef[] };

function normalize(githubEvent: string, payload: any, receivedAt: string): NormalizedEvent[] {
  if (githubEvent === "push") return normalizePush(payload as PushPayload, receivedAt);
  if (githubEvent === "pull_request") {
    const event = normalizePullRequest(payload as PullRequestPayload);
    return event ? [event] : [];
  }
  return []; // ping, issues, etc.: stored, not normalized
}

async function ingestDelivery(tx: pg.PoolClient, d: DeliveryInput, repos: Repo[]) {
  // Dedup point. A delivery that failed earlier may be retried (GitHub's
  // "Redeliver" button, or retryFailedDeliveries); anything else already
  // stored is a no-op.
  const claimed = await tx.query(
    `insert into webhook_deliveries (github_delivery_id, repository_id, github_event, action, payload, received_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (github_delivery_id) do update set status = 'received', error = null
       where webhook_deliveries.status = 'failed'
     returning 1`,
    [
      d.deliveryId,
      repos.length === 1 ? repos[0].repository_id : null,
      d.githubEvent,
      typeof d.payload?.action === "string" ? d.payload.action : null,
      d.payloadJson,
      d.receivedAt,
    ],
  );
  if (claimed.rowCount === 0) return null;

  const events = normalize(d.githubEvent, d.payload, d.receivedAt);
  let inserted = 0;
  const pushedBranches: BranchRef[] = [];

  // The same GitHub repo can be connected to more than one project; each gets
  // its own copy of the events. Sorted so concurrent deliveries take the
  // per-project event locks (inside recordEvents) in the same order.
  for (const repo of [...repos].sort((a, b) => a.project_id.localeCompare(b.project_id))) {
    const recorded = await recordEvents(tx, repo, events, "webhook", d.deliveryId);
    inserted += recorded.inserted;
    pushedBranches.push(...recorded.pushedBranches);

    // Any verified delivery proves the webhook is wired up.
    await tx.query(
      `update repositories
          set connection_status = 'connected',
              connected_at = coalesce(connected_at, now()),
              last_event_at = greatest(last_event_at, $2::timestamptz)
        where repository_id = $1`,
      [repo.repository_id, recorded.latest],
    );
  }

  const status = events.length > 0 ? ("normalized" as const) : ("ignored" as const);
  await tx.query(
    `update webhook_deliveries set status = $2, processed_at = now() where github_delivery_id = $1`,
    [d.deliveryId, status],
  );
  return { status, inserted, pushedBranches };
}

/**
 * Routes a verified delivery to its repository and ingests it in one
 * transaction. If that throws, the delivery is stored as 'failed' (with its
 * payload, so it can be retried) and the error is rethrown.
 */
export async function processDelivery(db: Db, d: DeliveryInput): Promise<ProcessResult> {
  const githubRepoId = d.payload?.repository?.id;
  const { rows: repos } =
    typeof githubRepoId === "number"
      ? await db.query<Repo>("select repository_id, project_id from repositories where github_repository_id = $1", [githubRepoId])
      : { rows: [] as Repo[] };
  if (repos.length === 0) return { kind: "unknown_repository" };

  try {
    const result = await withTransaction(db, (tx) => ingestDelivery(tx, d, repos));
    return result ? { kind: "processed", repos, ...result } : { kind: "duplicate", repos };
  } catch (err) {
    // The transaction rolled back; record the failure separately so it's
    // findable (webhook_deliveries_failed_idx) and retryable.
    await db
      .query(
        `insert into webhook_deliveries
           (github_delivery_id, repository_id, github_event, action, payload, status, error, received_at, processed_at)
         values ($1, $2, $3, $4, $5::jsonb, 'failed', $6, $7, now())
         on conflict (github_delivery_id) do update
           set status = 'failed', error = excluded.error, processed_at = now()`,
        [
          d.deliveryId,
          repos.length === 1 ? repos[0].repository_id : null,
          d.githubEvent,
          d.payload?.action ?? null,
          d.payloadJson,
          String(err),
          d.receivedAt,
        ],
      )
      .catch((recordErr) => console.error("could not record failed delivery", d.deliveryId, recordErr));
    throw err;
  }
}

export interface RetryResult {
  retried: number;
  succeeded: number;
  still_failed: number;
  results: ProcessResult[]; // succeeded ones, for the caller's follow-up hooks
}

/**
 * Re-runs stored failed deliveries for one repository, oldest first, from the
 * payload we kept. Safe to repeat: a delivery that succeeds is no longer
 * 'failed', and events dedupe by their keys anyway.
 */
export async function retryFailedDeliveries(db: Db, repositoryId: string): Promise<RetryResult> {
  const { rows } = await db.query<{ github_delivery_id: string; github_event: string; payload_json: string; received_at: string }>(
    `select d.github_delivery_id, d.github_event, d.payload::text as payload_json, d.received_at::text as received_at
       from webhook_deliveries d
      where d.status = 'failed'
        and (d.repository_id = $1
             or (d.repository_id is null
                 and (d.payload -> 'repository' ->> 'id')::bigint =
                     (select github_repository_id from repositories where repository_id = $1)))
      order by d.received_at, d.github_delivery_id`,
    [repositoryId],
  );
  const out: RetryResult = { retried: rows.length, succeeded: 0, still_failed: 0, results: [] };
  for (const row of rows) {
    try {
      const result = await processDelivery(db, {
        deliveryId: row.github_delivery_id,
        githubEvent: row.github_event,
        payload: JSON.parse(row.payload_json),
        payloadJson: row.payload_json,
        receivedAt: row.received_at,
      });
      if (result.kind === "unknown_repository") out.still_failed++;
      else {
        out.succeeded++;
        out.results.push(result);
      }
    } catch {
      out.still_failed++; // processDelivery already recorded the new error
    }
  }
  return out;
}
