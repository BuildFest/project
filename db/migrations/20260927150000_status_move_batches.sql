-- One timeline entry per plan sync instead of one per moved task. The moves a
-- sync makes share a batch_id; the timeline item points at the batch.
alter table plan_status_moves add column if not exists batch_id text;

-- Existing moves: each sync saved its moves in one transaction, so they share
-- created_at. Name each batch after its first move.
update plan_status_moves m set batch_id = 'mb_' || b.first_move
  from (select project_id, created_at, min(move_id) as first_move
          from plan_status_moves group by project_id, created_at) b
 where m.batch_id is null and m.project_id = b.project_id and m.created_at = b.created_at;

insert into timeline_items (item_id, project_id, occurred_at, kind, title, summary, entity_type, entity_id, related_task_ids)
select 'tl_' || m.batch_id, m.project_id, min(m.created_at), 'plan_change',
       case when count(*) = 1
            then 'Planning agent moved ' || min(t.task_key) || ' to '
                 || case min(m.to_status) when 'complete' then 'Complete' else 'In progress' end
            else 'Planning agent updated ' || count(*) || ' tasks' end,
       concat_ws(' · ',
         'In progress: ' || string_agg(t.task_key, ', ' order by length(t.task_key), t.task_key) filter (where m.to_status = 'in_progress'),
         'Complete: ' || string_agg(t.task_key, ', ' order by length(t.task_key), t.task_key) filter (where m.to_status = 'complete')),
       'plan_status_batches', m.batch_id, array_agg(m.task_id order by m.task_id)
  from plan_status_moves m join tasks t on t.project_id = m.project_id and t.task_id = m.task_id
 group by m.project_id, m.batch_id
on conflict (item_id) do nothing;

delete from timeline_items where entity_type = 'plan_status_moves';

alter table plan_status_moves alter column batch_id set not null;
create index if not exists plan_status_moves_batch_idx on plan_status_moves (batch_id);
