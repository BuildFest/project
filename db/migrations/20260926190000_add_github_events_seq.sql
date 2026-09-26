-- owner: person-1
--
-- Monotonic event sequence: the consumer cursor for Person 2's analyzers
-- (GET /projects/:id/events?after_seq=N). Timestamps can't be a cursor:
-- occurred_at isn't monotonic (backfilled facts land in the past).
--
-- Writers take pg_advisory_xact_lock(hashtext('events:' || project_id))
-- before inserting, so within a project seq order equals commit order and a
-- reader polling "seq > N" never skips a row that commits late.

alter table github_events add column seq bigint generated always as identity;

create index github_events_project_seq_idx on github_events (project_id, seq);
