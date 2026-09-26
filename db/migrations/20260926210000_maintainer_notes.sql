create table ai_runs (
  run_id           text primary key,
  project_id       text not null references projects on delete cascade,
  job              text not null,
  provider         text,
  model            text,
  input_tokens     integer not null default 0 check (input_tokens >= 0),
  output_tokens    integer not null default 0 check (output_tokens >= 0),
  duration_ms      integer not null default 0 check (duration_ms >= 0),
  status           text not null check (status in ('success', 'failed')),
  error            text,
  source_event_id  text,
  created_at       timestamptz not null default now(),
  foreign key (project_id, source_event_id)
    references github_events (project_id, event_id) on delete set null
);

create index ai_runs_project_created_idx on ai_runs (project_id, created_at desc);

create table maintainer_notes (
  note_id            text primary key,
  project_id         text not null references projects on delete cascade,
  repository_id      text not null,
  source_event_id    text not null,
  pull_request_number integer not null,
  branch              text not null,
  task_id             text,
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
    references tasks (project_id, task_id) on delete set null
);

create index maintainer_notes_project_created_idx
  on maintainer_notes (project_id, created_at desc);
