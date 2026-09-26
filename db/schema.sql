-- Pit Crew database schema (PostgreSQL 15+)
--
-- frontend/lib/types.ts mirrors this file. Column names are snake_case and
-- match the TS interfaces 1:1; columns that don't appear in types.ts are
-- backend-only (secrets refs, fingerprints, audit timestamps).
--
-- Tables are grouped by the three layers from the tech doc (§2, §5), and the
-- layers never write into each other:
--   TEAM-DEFINED  projects, project_members, project_briefs, milestones,
--                 plan_versions, tasks, task_dependencies, decisions
--   FACTUAL       repositories, webhook_deliveries, github_events
--   INTERPRETED   event_task_links, derived_task_states, branch_states,
--                 health_signals, collisions, replan_suggestions, timeline_items
--
-- Conventions
--   * IDs are app-generated prefixed ULIDs stored as text ("task_01JQ983A...").
--   * Enumerations are CHECK constraints, not ENUM types, so adding a value is
--     a single ALTER TABLE.
--   * Child rows carry project_id and use composite foreign keys
--     (project_id, x_id) so a row can never reference another project's data.
--   * text[] columns holding IDs (evidence_event_ids, related_task_ids, ...)
--     are not FK-checked; readers must tolerate dangling IDs.
--   * "ON DELETE SET NULL (col)" requires PostgreSQL 15.

-- Applied as migration 0000_schema by backend/src/migrations.ts, which wraps
-- it in a transaction. Once a database exists anywhere, don't edit this file:
-- add db/migrations/<YYYYMMDDHHMMSS>_<name>.sql instead.

-- ============================================================================
-- Shared helpers
-- ============================================================================

create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ============================================================================
-- TEAM-DEFINED
-- ============================================================================

create table projects (
  project_id            text primary key,
  name                  text not null,
  description           text,
  task_key_prefix       text not null check (task_key_prefix ~ '^[A-Z][A-Z0-9]{0,9}$'),
  next_task_number      integer not null default 1 check (next_task_number >= 1),
  created_by            text not null,  -- auth user id; members are created after the project
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deadline_at           timestamptz,
  timezone              text not null default 'UTC',
  status                text not null default 'active' check (status in ('active', 'archived')),
  current_plan_version  integer,  -- FK added below, once plan_versions exists
  primary_repository_id text      -- FK added below, once repositories exists
);

create trigger projects_updated_at before update on projects
  for each row execute function set_updated_at();

create table project_members (
  member_id    text primary key,
  project_id   text not null references projects on delete cascade,
  display_name text not null,
  role_label   text,  -- e.g. "Backend 2"
  github_login text,  -- maps GitHub event actors to members
  access_level text not null default 'editor' check (access_level in ('owner', 'editor', 'viewer')),
  joined_at    timestamptz not null default now(),
  unique (project_id, member_id)
);

-- GitHub logins are case-insensitive.
create unique index project_members_github_login_uq
  on project_members (project_id, lower(github_login))
  where github_login is not null;

create table project_briefs (
  project_id     text primary key references projects on delete cascade,
  content        text not null default '',
  content_format text not null default 'markdown' check (content_format in ('markdown', 'plain')),
  updated_at     timestamptz not null default now(),
  updated_by     text,
  foreign key (project_id, updated_by)
    references project_members (project_id, member_id) on delete set null (updated_by)
);

create trigger project_briefs_updated_at before update on project_briefs
  for each row execute function set_updated_at();

create table milestones (
  milestone_id text primary key,
  project_id   text not null references projects on delete cascade,
  name         text not null,
  description  text,
  target_at    timestamptz,
  sort_order   integer not null default 0,
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, milestone_id)
);

create trigger milestones_updated_at before update on milestones
  for each row execute function set_updated_at();

-- An immutable snapshot of the plan each time it is saved or a replan is
-- accepted. projects.current_plan_version points at the latest one.
create table plan_versions (
  project_id    text not null references projects on delete cascade,
  version       integer not null check (version >= 1),
  source        text not null check (source in ('initial', 'manual', 'replan_accepted')),
  suggestion_id text,  -- set when source = 'replan_accepted'; FK added below
  summary       text,
  snapshot      jsonb not null,  -- { milestones: [...], tasks: [...], dependencies: [...] }
  created_by    text,
  created_at    timestamptz not null default now(),
  primary key (project_id, version)
);

alter table projects
  add foreign key (project_id, current_plan_version)
  references plan_versions (project_id, version);

create table tasks (
  task_id                 text primary key,
  task_key                text not null check (task_key ~ '^[A-Z][A-Z0-9]*-[0-9]+$'),  -- "PC-12"
  project_id              text not null references projects on delete cascade,
  title                   text not null,
  description             text,
  owner_member_id         text,
  priority                text not null default 'medium'
                            check (priority in ('critical', 'high', 'medium', 'low')),
  scope                   text not null default 'must_have'
                            check (scope in ('must_have', 'optional')),
  -- Team-authored. Analyzers must never write this column (tech doc §5 rule 3);
  -- their view of progress lives in derived_task_states.
  plan_status             text not null default 'not_started'
                            check (plan_status in ('not_started', 'in_progress', 'blocked', 'complete', 'cancelled')),
  milestone_id            text,
  target_at               timestamptz,
  sort_order              integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_in_plan_version integer,
  updated_in_plan_version integer,
  archived                boolean not null default false,
  unique (project_id, task_id),
  unique (project_id, task_key),
  foreign key (project_id, owner_member_id)
    references project_members (project_id, member_id) on delete set null (owner_member_id),
  foreign key (project_id, milestone_id)
    references milestones (project_id, milestone_id) on delete set null (milestone_id)
);

create index tasks_milestone_idx on tasks (milestone_id) where milestone_id is not null;
create index tasks_owner_idx on tasks (owner_member_id) where owner_member_id is not null;

create trigger tasks_updated_at before update on tasks
  for each row execute function set_updated_at();

-- Hands out the next task key ("PC-7") for a project. The UPDATE takes a row
-- lock, so concurrent callers are serialized and never receive the same key.
create function allocate_task_key(p_project_id text) returns text
language sql as $$
  update projects
     set next_task_number = next_task_number + 1
   where project_id = p_project_id
  returning task_key_prefix || '-' || (next_task_number - 1);
$$;

create table task_dependencies (
  project_id         text not null,
  task_id            text not null,
  depends_on_task_id text not null,
  dependency_type    text not null default 'requires' check (dependency_type = 'requires'),
  created_at         timestamptz not null default now(),
  created_by         text,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id),
  foreign key (project_id, task_id)
    references tasks (project_id, task_id) on delete cascade,
  foreign key (project_id, depends_on_task_id)
    references tasks (project_id, task_id) on delete cascade
);

create index task_dependencies_depends_on_idx on task_dependencies (depends_on_task_id);

-- Rejects a dependency that would close a cycle (A requires B requires ... A).
-- A cycle would leave every task in it permanently "possibly_blocked".
create function task_dependencies_no_cycle() returns trigger
language plpgsql as $$
begin
  -- Self-dependency is the CHECK constraint's job (400), not a cycle (409).
  -- BEFORE triggers run ahead of CHECKs, so step aside explicitly.
  if new.task_id = new.depends_on_task_id then
    return new;
  end if;

  -- Serialize dependency writes per project, otherwise two concurrent
  -- inserts (A->B, B->A) each see an acyclic graph and both commit.
  perform pg_advisory_xact_lock(hashtext('task_dependencies:' || new.project_id));

  -- Cycle iff NEW.task_id is reachable from NEW.depends_on_task_id. On UPDATE
  -- the row being replaced is still visible, so exclude it from the walk.
  if exists (
    with recursive reachable(task_id) as (
      select new.depends_on_task_id
      union
      select d.depends_on_task_id
        from task_dependencies d
        join reachable r on d.task_id = r.task_id
       where (d.task_id, d.depends_on_task_id)
             is distinct from (old.task_id, old.depends_on_task_id)
    )
    select 1 from reachable where task_id = new.task_id
  ) then
    raise exception 'dependency would create a cycle'
      using errcode = 'check_violation',
            constraint = 'task_dependencies_no_cycle';
  end if;

  return new;
end $$;

create trigger task_dependencies_no_cycle before insert or update on task_dependencies
  for each row execute function task_dependencies_no_cycle();

create table decisions (
  decision_id      text primary key,
  project_id       text not null references projects on delete cascade,
  title            text not null,
  body             text,
  decided_by       text,
  decided_at       timestamptz not null default now(),
  related_task_ids text[] not null default '{}',
  suggestion_id    text  -- FK added below
);

create index decisions_project_idx on decisions (project_id, decided_at desc);

-- ============================================================================
-- FACTUAL
-- ============================================================================

create table repositories (
  repository_id          text primary key,
  project_id             text not null references projects on delete cascade,
  provider               text not null default 'github' check (provider = 'github'),
  github_repository_id   bigint,
  owner                  text not null,
  name                   text not null,
  full_name              text not null,
  default_branch         text not null default 'main',
  github_installation_id bigint,
  connection_status      text not null default 'pending'
                           check (connection_status in ('pending', 'connected', 'error', 'disconnected')),
  connected_at           timestamptz,
  last_backfill_at       timestamptz,
  last_event_at          timestamptz,
  webhook_secret_ref     text,  -- reference to wherever the secret is stored. Never the secret itself.
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (project_id, repository_id),
  unique (project_id, github_repository_id)
);

-- Webhook ingestion routes incoming deliveries by GitHub's numeric repo id.
create index repositories_github_id_idx on repositories (github_repository_id);

create trigger repositories_updated_at before update on repositories
  for each row execute function set_updated_at();

alter table projects
  add foreign key (project_id, primary_repository_id)
  references repositories (project_id, repository_id) on delete set null (primary_repository_id);

-- One row per webhook HTTP delivery. This is the dedup point: ingestion does
-- INSERT ... ON CONFLICT (github_delivery_id) DO NOTHING and stops if no row
-- was inserted. status/error make failed deliveries findable for replay.
-- One delivery can normalize into several github_events (a push -> commits).
create table webhook_deliveries (
  github_delivery_id text primary key,  -- X-GitHub-Delivery header
  repository_id      text references repositories on delete cascade,
  github_event       text not null,     -- X-GitHub-Event header, e.g. "pull_request"
  action             text,              -- payload.action, e.g. "opened"
  payload            jsonb,             -- raw delivery body, stored inline (hackathon scale, see §2.12)
  status             text not null default 'received'
                       check (status in ('received', 'normalized', 'ignored', 'failed')),
  error              text,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz
);

create index webhook_deliveries_failed_idx on webhook_deliveries (received_at)
  where status = 'failed';

-- Normalized, immutable repository activity. No inference is stored here.
--
-- external_event_id is a stable key chosen by the normalizer so the same fact
-- seen via webhook and via backfill collapses into one row, e.g.
--   commit               <sha>
--   push                 <ref>:<after_sha>
--   branch_created       <ref>:<sha>
--   pull_request_*       pr:<number>:<action>:<head_sha>
create table github_events (
  event_id           text primary key,
  project_id         text not null,
  repository_id      text not null,
  source             text not null check (source in ('webhook', 'backfill')),
  github_delivery_id text references webhook_deliveries,  -- null for backfill
  external_event_id  text not null,
  event_type         text not null check (event_type in (
                       'push', 'commit',
                       'branch_created', 'branch_deleted',
                       'pull_request_opened', 'pull_request_updated', 'pull_request_closed',
                       'pull_request_merged', 'pull_request_reopened')),
  actor              text,  -- GitHub login
  occurred_at        timestamptz not null,
  ingested_at        timestamptz not null default now(),
  branch             text,
  commit             jsonb,  -- { sha, message, author, url }
  pull_request       jsonb,  -- { number, title, state, head_branch, base_branch, url, merged }
  changed_files      text[] not null default '{}',
  schema_version     integer not null default 1,
  unique (project_id, event_id),
  unique (repository_id, event_type, external_event_id),
  foreign key (project_id, repository_id)
    references repositories (project_id, repository_id) on delete cascade
);

create index github_events_project_time_idx on github_events (project_id, occurred_at desc);
create index github_events_branch_idx on github_events (repository_id, branch, occurred_at desc);
create index github_events_pr_idx on github_events (repository_id, ((pull_request ->> 'number')::integer))
  where pull_request is not null;

-- Enforces tech doc §5 rule 1: events are never modified. Direct DELETEs are
-- rejected too; deletes cascading from a project/repository delete run at
-- trigger depth > 1 and are allowed through.
create function github_events_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' or pg_trigger_depth() = 1 then
    raise exception 'github_events is append-only (% on event %)', tg_op, old.event_id;
  end if;
  return old;
end $$;

create trigger github_events_immutable before update or delete on github_events
  for each row execute function github_events_immutable();

-- ============================================================================
-- INTERPRETED
-- ============================================================================

create table event_task_links (
  link_id      text primary key,
  project_id   text not null,
  event_id     text not null,
  task_id      text not null,
  method       text not null check (method in ('task_key', 'manual', 'llm')),
  confidence   real not null check (confidence between 0 and 1),
  status       text not null check (status in ('confirmed', 'suggested', 'rejected')),
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  created_by   text,  -- member_id, or 'system' for analyzers
  confirmed_by text,
  confirmed_at timestamptz,
  unique (event_id, task_id),
  foreign key (project_id, event_id)
    references github_events (project_id, event_id) on delete cascade,
  foreign key (project_id, task_id)
    references tasks (project_id, task_id) on delete cascade,
  -- An LLM may only suggest; a human has to confirm (tech doc §16).
  check (method <> 'llm' or status <> 'confirmed' or confirmed_by is not null)
);

create unique index event_task_links_one_primary_uq on event_task_links (event_id)
  where is_primary and status <> 'rejected';
create index event_task_links_task_idx on event_task_links (task_id)
  where status <> 'rejected';

create table derived_task_states (
  task_id            text primary key,
  project_id         text not null,
  computed_status    text not null
                       check (computed_status in ('not_started', 'in_progress', 'complete', 'possibly_blocked')),
  override_status    text
                       check (override_status in ('not_started', 'in_progress', 'complete', 'possibly_blocked')),
  -- A human override always wins over inference (tech doc §5 rule 5).
  effective_status   text generated always as (coalesce(override_status, computed_status)) stored,
  confidence         real check (confidence between 0 and 1),
  evidence_event_ids text[] not null default '{}',
  last_activity_at   timestamptz,
  blocking_task_ids  text[] not null default '{}',
  explanation        text,
  computation_method text not null default 'rules'
                       check (computation_method in ('rules', 'llm', 'rules+llm')),
  computed_at        timestamptz not null default now(),
  override_by        text,
  override_at        timestamptz,
  override_reason    text,
  -- Optimistic concurrency: writers UPDATE ... WHERE version = <what they read>;
  -- the trigger below bumps it.
  version            integer not null default 1,
  foreign key (project_id, task_id)
    references tasks (project_id, task_id) on delete cascade,
  check ((override_status is null) = (override_by is null))
);

create index derived_task_states_project_idx on derived_task_states (project_id);

create function bump_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end $$;

create trigger derived_task_states_version before update on derived_task_states
  for each row execute function bump_version();

-- Current view of each branch, maintained from github_events.
-- changed_files is the diff against the default branch.
create table branch_states (
  repository_id    text not null,
  branch           text not null,
  project_id       text not null,
  status           text not null default 'active' check (status in ('active', 'merged', 'deleted')),
  head_sha         text,
  task_id          text,
  changed_files    text[] not null default '{}',
  open_pr_number   integer,
  last_activity_at timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (repository_id, branch),
  foreign key (project_id, repository_id)
    references repositories (project_id, repository_id) on delete cascade,
  foreign key (project_id, task_id)
    references tasks (project_id, task_id) on delete set null (task_id)
);

-- GIN makes the collision query (a.changed_files && b.changed_files) indexable.
create index branch_states_active_files_idx on branch_states using gin (changed_files)
  where status = 'active';

create trigger branch_states_updated_at before update on branch_states
  for each row execute function set_updated_at();

create table health_signals (
  signal_id             text primary key,
  project_id            text not null references projects on delete cascade,
  type                  text not null check (type in (
                          'milestone_slipping', 'dependency_incomplete', 'must_have_no_activity',
                          'plan_state_disagreement', 'task_possibly_blocked')),
  status                text not null default 'active' check (status in ('active', 'resolved', 'dismissed')),
  severity              text not null check (severity in ('info', 'warning', 'critical')),
  title                 text not null,
  explanation           text not null,
  related_task_ids      text[] not null default '{}',
  related_milestone_ids text[] not null default '{}',
  evidence_event_ids    text[] not null default '{}',
  detected_at           timestamptz not null default now(),
  resolved_at           timestamptz,
  -- Stable hash of the underlying condition, e.g. "dependency_incomplete:task_A:task_B".
  fingerprint           text not null,
  check (status <> 'active' or resolved_at is null)
);

-- At most one open signal per condition. Dismissed signals count as open, so
-- the analyzer does not re-raise something a human already dismissed; once a
-- condition resolves, a recurrence creates a new row.
create unique index health_signals_open_fingerprint_uq on health_signals (project_id, fingerprint)
  where status <> 'resolved';
create index health_signals_active_idx on health_signals (project_id, detected_at desc)
  where status = 'active';

-- Two active branches touching the same files. This is a risk warning, not a
-- claim that a merge conflict will happen (tech doc §15).
create table collisions (
  collision_id      text primary key,
  project_id        text not null,
  repository_id     text not null,
  branch_a          text not null,
  branch_b          text not null,
  task_a_id         text,
  task_b_id         text,
  overlapping_files text[] not null check (cardinality(overlapping_files) > 0),
  status            text not null default 'active' check (status in ('active', 'resolved', 'dismissed')),
  detected_at       timestamptz not null default now(),
  resolved_at       timestamptz,
  -- Store each pair in one canonical order so (a,b) and (b,a) can't both exist.
  check (branch_a < branch_b),
  check (status <> 'active' or resolved_at is null),
  foreign key (project_id, repository_id)
    references repositories (project_id, repository_id) on delete cascade,
  foreign key (project_id, task_a_id)
    references tasks (project_id, task_id) on delete set null (task_a_id),
  foreign key (project_id, task_b_id)
    references tasks (project_id, task_id) on delete set null (task_b_id)
);

create unique index collisions_open_pair_uq on collisions (repository_id, branch_a, branch_b)
  where status <> 'resolved';
create index collisions_active_idx on collisions (project_id) where status = 'active';

-- A proposed plan change. Never applied until a human accepts it (§5 rule 4);
-- accepting writes a new plan_versions row with source = 'replan_accepted'.
create table replan_suggestions (
  suggestion_id         text primary key,
  project_id            text not null references projects on delete cascade,
  based_on_plan_version integer not null,
  status                text not null default 'proposed'
                          check (status in ('proposed', 'accepted', 'rejected', 'superseded')),
  rationale             text not null,
  proposed_changes      jsonb not null default '[]' check (jsonb_typeof(proposed_changes) = 'array'),
  evidence_event_ids    text[] not null default '{}',
  related_signal_ids    text[] not null default '{}',
  generated_by          text not null check (generated_by in ('rules', 'llm')),
  created_at            timestamptz not null default now(),
  reviewed_by           text,
  reviewed_at           timestamptz,
  unique (project_id, suggestion_id),
  foreign key (project_id, based_on_plan_version)
    references plan_versions (project_id, version),
  check ((status in ('accepted', 'rejected')) = (reviewed_by is not null))
);

create index replan_suggestions_open_idx on replan_suggestions (project_id)
  where status = 'proposed';

alter table plan_versions
  add foreign key (project_id, suggestion_id)
  references replan_suggestions (project_id, suggestion_id);

alter table decisions
  add foreign key (project_id, suggestion_id)
  references replan_suggestions (project_id, suggestion_id);

-- Denormalized feed for the dashboard timeline. Every row points back at its
-- source entity (entity_type, entity_id), so the timeline can be rebuilt.
create table timeline_items (
  item_id          text primary key,
  project_id       text not null references projects on delete cascade,
  occurred_at      timestamptz not null,
  kind             text not null check (kind in (
                     'github_event', 'plan_change', 'task_override',
                     'signal_detected', 'signal_resolved',
                     'collision_detected', 'collision_resolved',
                     'replan_proposed', 'replan_reviewed', 'decision')),
  title            text not null,
  summary          text,
  actor            text,
  entity_type      text not null,
  entity_id        text not null,
  related_task_ids text[] not null default '{}'
);

create index timeline_items_project_time_idx on timeline_items (project_id, occurred_at desc);
