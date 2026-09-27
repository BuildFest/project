alter table health_signals add column if not exists dismissed_by text;
alter table health_signals add column if not exists dismissed_at timestamptz;
alter table collisions add column if not exists dismissed_by text;
alter table collisions add column if not exists dismissed_at timestamptz;
alter table event_task_links add column if not exists reviewed_by text;
alter table event_task_links add column if not exists reviewed_at timestamptz;
