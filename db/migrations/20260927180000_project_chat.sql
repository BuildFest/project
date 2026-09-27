-- Persistent project chat. The sender name is snapshotted so messages remain
-- understandable if a teammate is later renamed or removed from the project.
create table project_messages (
  message_id          text primary key,
  project_id          text not null references projects on delete cascade,
  sender_member_id    text,
  sender_display_name text not null,
  body                text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at          timestamptz not null default now(),
  foreign key (project_id, sender_member_id)
    references project_members (project_id, member_id) on delete set null (sender_member_id)
);

create index project_messages_project_time_idx
  on project_messages (project_id, created_at desc, message_id desc);
