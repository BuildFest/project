-- Keep this definition compatible with the maintainer-agent branch. Its
-- migration sorts before this one on a fresh database; IF NOT EXISTS also
-- lets this feature run on its own.
create table if not exists ai_runs (
  run_id        text primary key,
  project_id    text references projects on delete set null,
  job           text not null,
  tier          text not null check (tier in ('fast', 'smart')),
  provider      text not null,
  model         text not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  duration_ms   integer not null default 0,
  cached        boolean not null default false,
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists ai_runs_project_time_idx on ai_runs (project_id, created_at desc);

alter table ai_runs add column if not exists source_event_id text;
alter table ai_runs add constraint ai_runs_source_event_fk
  foreign key (project_id, source_event_id)
  references github_events (project_id, event_id) on delete set null (source_event_id);

create table pr_notes (
  note_id             text primary key,
  project_id          text not null references projects on delete cascade,
  repository_id       text not null,
  source_event_id     text not null,
  pull_request_number integer not null,
  branch               text not null,
  task_id              text,
  note                 text not null,
  facts                jsonb not null default '[]' check (jsonb_typeof(facts) = 'array'),
  evidence_event_ids   text[] not null default '{}',
  generated_by         text not null check (generated_by in ('rules', 'llm')),
  created_at           timestamptz not null default now(),
  unique (project_id, source_event_id),
  foreign key (project_id, repository_id)
    references repositories (project_id, repository_id) on delete cascade,
  foreign key (project_id, source_event_id)
    references github_events (project_id, event_id) on delete cascade,
  foreign key (project_id, task_id)
    references tasks (project_id, task_id) on delete set null (task_id)
);

create index pr_notes_project_created_idx on pr_notes (project_id, created_at desc);
