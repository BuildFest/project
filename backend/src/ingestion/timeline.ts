import type { Queryable } from "../db.js";

// Projects github_events into timeline_items (kind 'github_event'): one
// human-readable row per push, branch created/deleted and PR lifecycle step.
// Webhook commits stay nested under their push and get no row of their own;
// backfilled commits have no push, so they stand alone.
//
// Idempotent: the item id is derived from the event id, so projecting an event
// twice is a no-op. That lets the same statement serve new events (inside the
// ingest transaction) and catch-up over everything already stored.

const TITLE = `
  case e.event_type
    when 'push'                  then coalesce(e.actor, 'Someone') || ' pushed to ' || e.branch
    when 'branch_created'        then coalesce(e.actor, 'Someone') || ' created branch ' || e.branch
    when 'branch_deleted'        then coalesce(e.actor, 'Someone') || ' deleted branch ' || e.branch
    when 'pull_request_opened'   then coalesce(e.actor, 'Someone') || ' opened PR #'   || (e.pull_request ->> 'number') || ': ' || (e.pull_request ->> 'title')
    when 'pull_request_merged'   then coalesce(e.actor, 'Someone') || ' merged PR #'   || (e.pull_request ->> 'number') || ': ' || (e.pull_request ->> 'title')
    when 'pull_request_closed'   then coalesce(e.actor, 'Someone') || ' closed PR #'   || (e.pull_request ->> 'number') || ': ' || (e.pull_request ->> 'title')
    when 'pull_request_reopened' then coalesce(e.actor, 'Someone') || ' reopened PR #' || (e.pull_request ->> 'number') || ': ' || (e.pull_request ->> 'title')
    when 'commit'                then coalesce(e.actor, e.commit ->> 'author', 'Someone') || ' committed to ' || e.branch
  end`;

export async function projectEventsToTimeline(
  db: Queryable,
  filter: { projectId?: string; eventIds?: string[] } = {},
): Promise<number> {
  const { rowCount } = await db.query(
    `insert into timeline_items
       (item_id, project_id, occurred_at, kind, title, summary, actor, entity_type, entity_id)
     select 'tl_' || substr(e.event_id, length('event_') + 1), e.project_id, e.occurred_at, 'github_event',
            ${TITLE},
            nullif(split_part(e.commit ->> 'message', E'\\n', 1), ''),
            e.actor, 'github_events', e.event_id
       from github_events e
      where (e.event_type in ('push', 'branch_created', 'branch_deleted', 'pull_request_opened',
                              'pull_request_merged', 'pull_request_closed', 'pull_request_reopened')
             or (e.event_type = 'commit' and e.source = 'backfill'))
        and ($1::text is null or e.project_id = $1)
        and ($2::text[] is null or e.event_id = any($2))
     on conflict (item_id) do nothing`,
    [filter.projectId ?? null, filter.eventIds ?? null],
  );
  return rowCount ?? 0;
}
