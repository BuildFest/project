create table ai_runs (
  run_id        text primary key,
  project_id    text references projects on delete set null,
  job           text not null,
  tier          text not null check (tier in ('fast', 'smart')),
  provider       text not null,
  model          text not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  duration_ms    integer not null default 0,
  cached         boolean not null default false,
  error          text,
  created_at     timestamptz not null default now()
);

create index ai_runs_project_time_idx on ai_runs (project_id, created_at desc);

create table maintainer_notes (
  note_id        text primary key,
  project_id     text not null references projects on delete cascade,
  kind           text not null check (kind in ('digest', 'answer')),
  title          text not null,
  body           text not null,
  question       text,
  citations      jsonb not null default '[]' check (jsonb_typeof(citations) = 'array'),
  generated_by   text not null check (generated_by in ('rules', 'llm')),
  created_at     timestamptz not null default now()
);

create index maintainer_notes_project_time_idx on maintainer_notes (project_id, created_at desc);
