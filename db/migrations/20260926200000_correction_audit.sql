alter table health_signals add column if not exists dismissed_by text;
alter table health_signals add column if not exists dismissed_at timestamptz;
alter table collisions add column if not exists dismissed_by text;
alter table collisions add column if not exists dismissed_at timestamptz;
