-- owner: person-1
--
-- Makes backfill outcomes visible through GET /projects/:id/repositories
-- instead of only in server logs. 'partial' means some stages failed (e.g. the
-- token can't list pull requests) while the rest was imported.

alter table repositories
  add column backfill_status text check (backfill_status in ('running', 'succeeded', 'partial', 'failed')),
  add column backfill_error  text;
