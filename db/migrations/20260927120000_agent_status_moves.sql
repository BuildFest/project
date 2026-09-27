-- The planning agent may now move a task's plan_status forward on its own
-- (not started -> in progress -> complete) when linked evidence is strong,
-- but never a status a person set. plan_status_set_by records who wrote it.
alter table tasks add column if not exists plan_status_set_by text;

-- Each change the agent made, so the team can see why and undo it.
create table if not exists plan_status_moves (
  move_id            text primary key,
  project_id         text not null,
  task_id            text not null,
  from_status        text not null check (from_status in ('not_started', 'in_progress')),
  to_status          text not null check (to_status in ('in_progress', 'complete')),
  reason             text not null,
  evidence_event_ids text[] not null default '{}',
  created_at         timestamptz not null default now(),
  undone_by          text,
  undone_at          timestamptz,
  foreign key (project_id, task_id)
    references tasks (project_id, task_id) on delete cascade,
  check ((undone_by is null) = (undone_at is null))
);

create index if not exists plan_status_moves_project_idx on plan_status_moves (project_id, created_at desc);

-- When the planning agent last synced each project's plan (it moves task
-- statuses in batches every PLAN_SYNC_INTERVAL_HOURS, not on every event).
create table if not exists plan_sync_state (
  project_id text primary key references projects on delete cascade,
  synced_at  timestamptz not null
);
