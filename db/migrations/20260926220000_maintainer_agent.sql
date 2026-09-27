-- Common superset shared with the pre-merge notifier migration. This file is
-- intentionally additive so either feature branch may be integrated first.
create table if not exists ai_runs (
  run_id text primary key, project_id text references projects on delete set null,
  job text not null, tier text, provider text, model text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  cached boolean not null default false,
  status text check (status in ('success', 'failed')), error text,
  source_event_id text, created_at timestamptz not null default now()
);
alter table ai_runs add column if not exists tier text;
alter table ai_runs add column if not exists cached boolean not null default false;
alter table ai_runs add column if not exists status text;
alter table ai_runs add column if not exists source_event_id text;
alter table ai_runs alter column project_id drop not null;
create index if not exists ai_runs_project_time_idx on ai_runs (project_id, created_at desc);

create table if not exists maintainer_notes (
  note_id text primary key, project_id text not null references projects on delete cascade,
  kind text, title text, body text, question text,
  citations jsonb not null default '[]' check (jsonb_typeof(citations) = 'array'),
  repository_id text, source_event_id text, pull_request_number integer,
  branch text, task_id text, note text,
  facts jsonb not null default '[]' check (jsonb_typeof(facts) = 'array'),
  evidence_event_ids text[] not null default '{}',
  generated_by text not null check (generated_by in ('rules', 'llm')),
  created_at timestamptz not null default now()
);
alter table maintainer_notes add column if not exists kind text;
alter table maintainer_notes add column if not exists title text;
alter table maintainer_notes add column if not exists body text;
alter table maintainer_notes add column if not exists question text;
alter table maintainer_notes add column if not exists citations jsonb not null default '[]';
alter table maintainer_notes add column if not exists note text;
alter table maintainer_notes add column if not exists facts jsonb not null default '[]';
alter table maintainer_notes add column if not exists evidence_event_ids text[] not null default '{}';
alter table maintainer_notes alter column repository_id drop not null;
alter table maintainer_notes alter column source_event_id drop not null;
alter table maintainer_notes alter column pull_request_number drop not null;
alter table maintainer_notes alter column branch drop not null;
create index if not exists maintainer_notes_project_time_idx on maintainer_notes (project_id, created_at desc);
