-- One durable heartbeat per project. Derived task timestamps only change when
-- their values change, so they cannot tell the UI whether a no-op analysis ran.
create table planning_agent_status (
  project_id        text primary key references projects on delete cascade,
  status            text not null default 'waiting'
                      check (status in ('waiting', 'running', 'healthy', 'degraded', 'failed')),
  last_trigger      text,
  last_mode         text check (last_mode in ('full', 'rules')),
  ai_available      boolean not null default false,
  last_started_at   timestamptz,
  last_completed_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at    timestamptz,
  last_error        text,
  last_result       jsonb,
  runs_count        integer not null default 0 check (runs_count >= 0)
);
