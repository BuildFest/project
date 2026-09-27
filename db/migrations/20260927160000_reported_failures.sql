-- Failures that aren't an AI call (ai_runs already covers those): unhandled
-- 500s the API actually hit, logged automatically from app.onError's
-- fallback, plus incidents only a human can see (a merge conflict, a local
-- build or deploy failure) logged manually. Feeds the "Fails" view alongside
-- ai_runs — the team's record for the Agentic Stress Test track.
create table if not exists reported_failures (
  failure_id  text primary key,
  project_id  text references projects on delete set null,
  source      text not null check (source in ('system', 'manual')),
  category    text not null check (category in ('internal_error', 'build', 'deploy', 'merge_conflict', 'other')),
  title       text not null,
  detail      text,
  reported_by text,
  created_at  timestamptz not null default now()
);
create index if not exists reported_failures_project_time_idx on reported_failures (project_id, created_at desc);
