-- Why a link was made, e.g. the model's one-line reason or "same branch as
-- work already linked to PC-3". Null for plain task-key matches.
alter table event_task_links add column reason text;
