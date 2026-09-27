# Pit Crew API Contract

The HTTP API between the dashboard (`frontend/`) and the backend (`backend/`).
Change it through a PR, like code: if an endpoint's shape changes, update this
file in the same PR.

- Schema: [`db/schema.sql`](../db/schema.sql)
- Shared types: `frontend/lib/types.ts` (every entity type named below lives there)
- Implementation: [`backend/src/api/app.ts`](../backend/src/api/app.ts)

| Status | Meaning |
|---|---|
| ✅ | Implemented and tested |
| 📝 | Agreed shape, not built yet. Build against it and flag changes in the PR |

Owners follow tech doc §4: **A** = event infrastructure and plan CRUD,
**B** = project intelligence (interpretation), **FE** = frontend.

---

## 1. Conventions

**Base URL.** Local: `http://localhost:8787` (`npm run dev` in `backend/`).
Deployed: Railway service URL, same paths.

**JSON.** Requests and responses are `application/json`. Field names are
`snake_case` and match the database columns, so responses use the
`types.ts` interfaces directly, with no mapping layer.

**IDs.** Server-generated prefixed ULIDs (`proj_…`, `mem_…`, `ms_…`,
`task_…`, `repo_…`, `event_…`). Clients never create IDs.

**Timestamps.** Responses: ISO 8601 strings in UTC
(`"2026-10-04T17:00:00.000Z"`). Requests: anything Postgres `timestamptz`
parses. `"2026-10-04"` and full ISO strings both work.

**Responses are supersets of `types.ts`.** Rows may include extra columns
(`created_at`, `updated_at`, …). Ignore fields you don't use. Never rely on a
field being absent.

**PATCH semantics.** Omitted fields are unchanged. `null` clears a nullable
field. An empty body (or one with only unknown fields) is `400`. Unknown fields
are ignored.

**No DELETE for plan entities.** Tasks and milestones are archived with
`PATCH { "archived": true }` so evidence and history keep pointing at them.
Workspaces include archived rows, so filter on `archived` in the UI.

**Auth.** None yet. Until it exists, endpoints that record *who* did
something take a `member_id` in the body. When auth lands, that field is
replaced by the session user and this section will say so.

**Freshness.** No push/websocket for the MVP. The dashboard polls
`GET /projects/:id/state` (§5.1) about every 10 s.

### Errors

Every non-2xx response has the same body:

```ts
interface ApiError {
  error: string;          // human-readable, safe to show in the UI
  code?: string;          // machine-readable reason, e.g. "23505" or "cycle"
  issues?: unknown[];     // present on validation errors: zod issue list
}
```

| Status | When |
|---|---|
| `400` | Body isn't JSON, fails validation, references something that doesn't exist or belongs to another project, breaks a CHECK rule (e.g. a task depending on itself), or has an unparseable timestamp |
| `404` | The resource in the URL doesn't exist |
| `409` | Conflicts with existing state: duplicate dependency, duplicate task key, dependency cycle (`code: "cycle"`) |
| `500` | Bug. Body is `{ "error": "internal error" }`; details are only in server logs |

Error bodies never contain table names, constraint names, or SQL.

Database-rule violations are mapped in `backend/src/api/errors.ts`
(`pgErrorToHttp()`); `code` carries the Postgres SQLSTATE (`23505` duplicate,
`23503` bad reference, `23514` rule violation, `22007` bad timestamp), except
a dependency that would close a loop (A → B → … → A), which returns `409` with
`code: "cycle"`.

---

## 2. Projects — owner A

### 2.1 ✅ `GET /projects`
All **active** projects as full workspaces.

→ `200 ProjectWorkspace[]`

### 2.2 ✅ `GET /projects/:projectId`
→ `200 ProjectWorkspace` · `404`

```ts
interface ProjectWorkspace {
  project: Project;
  members: ProjectMember[];      // creation order; members[0] is the owner
  brief: ProjectBrief;
  milestones: Milestone[];       // by sort_order, then creation
  tasks: Task[];                 // by sort_order, then creation; includes archived
  dependencies: TaskDependency[];
}
```

### 2.3 ✅ `POST /projects`
Creates the project, its members and its brief in one transaction.

```ts
interface CreateProjectInput {
  name: string;                  // non-empty
  description?: string | null;
  task_key_prefix: string;       // 1–10 chars, letter first; uppercased by the server ("pc" -> "PC")
  deadline_at?: string | null;
  timezone?: string;             // default "UTC"
  members?: {                    // first member becomes owner, the rest editors
    display_name: string;
    github_login?: string | null;  // unique per project, case-insensitive
    role_label?: string | null;    // e.g. "Backend 2"
  }[];
  brief?: string;                // markdown, default ""
}
```

→ `201 ProjectWorkspace` · `400`

This matches `CreateProjectInput` in `frontend/lib/api.ts`. To switch the mock
over, replace the function body with a `fetch`.

### 2.4 ✅ `PATCH /projects/:projectId`
Body: any of `name`, `description`, `deadline_at`, `timezone`,
`status` (`"active" | "archived"`).

→ `200 Project` · `400` · `404`

### 2.5 ✅ `PUT /projects/:projectId/brief`
```ts
{ content: string; content_format?: "markdown" | "plain"; updated_by?: string | null /* member_id */ }
```
→ `200 ProjectBrief` · `404`

### 2.6 ✅ `POST /projects/:projectId/members`
```ts
{ display_name: string; github_login?: string | null; role_label?: string | null;
  access_level?: "owner" | "editor" | "viewer" }  // default "editor"
```
→ `201 ProjectMember` · `409` github_login already used in this project
(case-insensitive) · `404` unknown project

### 2.7 ✅ `PATCH /projects/:projectId/members/:memberId`
Any of `display_name`, `github_login`, `role_label`, `access_level`.
`github_login` is how GitHub actors are attributed to members, so the plan
editor should make it easy to fill in. `""` or `null` clears it.

→ `200 ProjectMember` · `404` unknown member · `409` login taken

---

## 3. Plan — owner A

### 3.1 ✅ `POST /projects/:projectId/milestones`
```ts
{ name: string; description?: string | null; target_at?: string | null; sort_order?: number }
```
→ `201 Milestone`

### 3.2 ✅ `PATCH /projects/:projectId/milestones/:milestoneId`
Any of the create fields, plus `archived: boolean`.
→ `200 Milestone` · `404`

### 3.3 ✅ `POST /projects/:projectId/tasks`
The server assigns `task_key` (`PC-1`, `PC-2`, …). Clients never send it.

```ts
interface CreateTaskInput {
  title: string;
  description?: string | null;
  owner_member_id?: string | null;   // must be a member of this project
  priority?: Priority;               // default "medium"
  scope?: Scope;                     // default "must_have"
  plan_status?: PlanStatus;          // default "not_started"
  milestone_id?: string | null;      // must belong to this project
  target_at?: string | null;
  sort_order?: number;               // default 0
}
```
→ `201 Task` · `400` · `404` project

### 3.4 ✅ `PATCH /projects/:projectId/tasks/:taskId`
Any `CreateTaskInput` field, plus `archived: boolean`. `task_key` is immutable.

`plan_status` is **team-authored**. Only this endpoint (a human editing the
plan) or an accepted replan (§5.7) may change it. Analyzers never do
(tech doc §5 rule 3).

→ `200 Task` · `400` · `404`

### 3.5 ✅ `POST /projects/:projectId/dependencies`
"`task_id` requires `depends_on_task_id`".
```ts
{ task_id: string; depends_on_task_id: string }
```
→ `201 TaskDependency` · `400` self-dependency / other project's task ·
`409` duplicate (or cycle, see §1 Errors)

### 3.6 ✅ `DELETE /projects/:projectId/dependencies/:taskId/:dependsOnTaskId`
→ `204` · `404`

### 3.7 ✅ `POST /projects/:projectId/plan-versions`
Snapshots the current plan ("Save plan"). The server builds the snapshot from
the live tables and bumps `project.current_plan_version`. Replan suggestions
are always relative to a version, so the plan editor should call this after
the initial plan is set up.

```ts
{ summary?: string; member_id?: string }
```
→ `201 { project_id, version, source: "initial" | "manual", summary, created_at }`
· `400` `member_id` isn't in this project · `404` unknown project

The first save is `initial`, later ones `manual`. Each save also adds a
`plan_change` timeline item ("Plan v2 saved").

---

## 4. Repository and events — owner A

### 4.1 ✅ `POST /projects/:projectId/repositories`
Connects a GitHub repo. The server looks it up on GitHub (id, default branch),
stores it as `connection_status: "pending"`, and returns what to paste into
the repo's **Settings → Webhooks** page (content type `application/json`,
events: pushes and pull requests).

```ts
{ full_name: string /* "BuildFest/project" or a github.com URL */; make_primary?: boolean /* default true */ }
```
→ `201 { repository: Repository; webhook_url: string; webhook_secret: string }`

`webhook_secret` is only ever in this response; `GET` never returns it.
`connection_status` becomes `"connected"` on the first verified delivery
(GitHub sends a `ping` as soon as the webhook is saved).

| Status | When |
|---|---|
| `400` | GitHub doesn't know the repo, or `GITHUB_TOKEN` can't see it |
| `404` | Project doesn't exist |
| `409` | Repo already connected to this project |
| `502` | GitHub unreachable or erroring |

### 4.2 ✅ `GET /projects/:projectId/repositories`
→ `200 Repository[]`, oldest first. Each repository also carries ingestion
health, computed on read:

| Field | Meaning |
|---|---|
| `last_delivery_at` | Last webhook delivery received (any event, incl. `ping`); `null` if none yet |
| `failed_deliveries` | Stored deliveries that failed processing (retry them, §4.7) |
| `ingestion_health` | `waiting` (no delivery yet: webhook not set up?), `degraded` (failed deliveries, or backfill `failed`/`partial`), `live` |

### 4.7 ✅ `POST /projects/:projectId/repositories/:repositoryId/deliveries/retry`
Re-runs this repository's failed deliveries, oldest first, from the payloads
we stored (e.g. after a fix is deployed). Retried events go through the same
path as live ones, including task linking and changed-files refresh.
→ `200 { retried: number; succeeded: number; still_failed: number }` · `404`
if the repository isn't in this project. Safe to repeat.

### 4.3 ✅ `POST /projects/:projectId/repositories/:repositoryId/backfill`
Imports what happened before the webhook existed, or while deliveries were
failing: every PR (opened, merged/closed), every branch (with its head, its
branch-unique commits and its `changed_files`), and branches deleted since.
Asynchronous.
→ `202 { started_at: string }`. Progress and outcome show on the repository
(`GET /repositories`):

| Field | Meaning |
|---|---|
| `backfill_status` | `null` (never run), `running`, `succeeded`, `partial` (some stages failed, the rest imported), `failed` (repo unreadable, nothing imported) |
| `backfill_error` | Why it was `partial`/`failed`, e.g. the token lacks "Pull requests: Read". `null` otherwise |
| `last_backfill_at` | Set when a run finishes (`succeeded` or `partial`) |

A request while a run is in progress returns that run's `started_at`. `404` if the repository isn't in this project.

Safe to run any number of times: backfilled facts use the same dedupe keys as
webhooks (`github_events.source = "backfill"`), so a second run adds nothing.
Call it once after connecting a repo, and again after any webhook outage.

Not imported yet: the default branch's commit history and exact branch creation
times (a backfilled `branch_created` uses the branch's oldest unique commit time).

### 4.4 ✅ `POST /webhooks/github`
Called by GitHub, not by the frontend. It takes the raw payload plus the
`X-GitHub-Event`, `X-GitHub-Delivery` and `X-Hub-Signature-256` headers.

| Response | When |
|---|---|
| `202` | Stored. Body `{ status: "normalized" \| "ignored", events: number }` (new `github_events` rows) |
| `200` | Duplicate delivery ID, already processed (no-op) |
| `400` | Missing headers or non-JSON payload |
| `401` | Signature doesn't verify |
| `404` | Unknown repository |

`push` and `pull_request` (opened, reopened, synchronize, closed) become
`github_events` and update `branch_states`; other events are stored as
`ignored`. Normalization runs inline in one transaction (cheap, no GitHub API
calls). Analysis still happens after the response, never inline (tech doc §3).
A debounced per-project runner performs task linking, branch derivation,
rules and guarded AI review after commit. A 60-second sweep covers
time-dependent health signals; `npm run analyze -- <projectId>` runs the same
pipeline manually. AI credentials are optional and deterministic rules remain
the fallback.
A delivery that fails is stored as `failed` and GitHub's **Redeliver** retries it.

### 4.5 ✅ `GET /projects/:projectId/events`
Normalized GitHub activity. Every event carries `seq`: a number that only
increases, in the order events were stored.

Filters (both modes): `branch?`, `task_id?` (events linked to that task via
`event_task_links` that aren't rejected).

**Browse mode** (dashboard, default): newest first by `occurred_at`.
Query: `limit?` (default 50, max 200), `cursor?`.

→ `200 Page<GithubEvent>`

```ts
interface Page<T> {
  items: T[];
  next_cursor: string | null;  // opaque; pass back as ?cursor=
}
```

**Consumer mode** (Person 2's analyzers): `?after_seq=N` returns events with
`seq > N`, ascending. Query: `limit?` (default 200, max 500). Store
`next_after_seq` and pass it back next time; no event is ever skipped, even
backfilled ones with old `occurred_at`.

→ `200 { items: GithubEvent[]; next_after_seq: number; has_more: boolean }`

Start from `after_seq=0`. `cursor` and `after_seq` can't be combined (`400`).

### 4.6 ✅ `GET /projects/:projectId/branches`
→ `200 BranchState[]`: active first, then merged, then deleted; most recent
activity first within each. Query: `status?` (`active` | `merged` | `deleted`).
`404` for an unknown project. Returned whole (tens of rows), not paginated.

`changed_files` is the branch's diff against its merge base with the default
branch (GitHub's three-dot compare), i.e. what merging it would change. It's
refreshed a few seconds after each push; until the first refresh it's `[]`. The
default branch always has `[]`. Renames list both the old and new path. GitHub
caps the list at 300 files.

---

## 5. Project intelligence — owner B

These endpoints are proposed by A. B confirms or edits them in the PR.

### 5.1 ✅ `GET /projects/:projectId/state`
Everything the dashboard needs to paint the "plan vs reality" view in one
call. The dashboard polls this. It only reads; it never triggers analysis.

```ts
interface ProjectState {
  computed_at: string | null;              // latest analyzer write; null if never analyzed
  tasks: DerivedTaskState[];               // one per non-archived task that has been analyzed, plan order
  signals: HealthSignal[];                 // status = "active" only, newest first
  collisions: Collision[];                 // status = "active" only, newest first
  pending_links: Array<EventTaskLink & { event: GithubEvent }>;  // status = "suggested", newest event first
  open_replans: number;                    // count of status = "proposed"
}
```
→ `200 ProjectState` · `404`

A task with no `DerivedTaskState` row hasn't been analyzed yet. Show its
`plan_status` alone.

`pending_links` includes AI suggestions at or above 0.8 confidence. Those
already count toward the task's derived status (shown as AI-inferred), but they
stay in the review queue until someone confirms or rejects them. Each link has
a `reason: string | null` explaining why it was made.

### 5.2 ✅ `GET /projects/:projectId/tasks/:taskId/evidence`
Answers "why does Pit Crew believe this?" (tech doc §17).

```ts
interface TaskEvidence {
  task: Task;
  state: DerivedTaskState | null;
  blocking_tasks: Array<{ task: Task; state: DerivedTaskState | null }>;
  links: Array<EventTaskLink & { event: GithubEvent }>;   // not rejected, newest first
  signals: HealthSignal[];                                // active, mentioning this task
}
```
→ `200 TaskEvidence` · `404`

`blocking_tasks` follows `state.blocking_task_ids` order and omits IDs that no
longer resolve to a task in the project. `links` and `signals` are newest first.

### 5.3 ✅ `PUT /projects/:projectId/tasks/:taskId/override`
A human corrects the derived status. `effective_status` changes at once, while
`computed_status` is kept (tech doc §13).

```ts
{ override_status: DerivedStatus; reason?: string; member_id: string; version: number }
```
`version` is the `DerivedTaskState.version` the user saw. If it has changed,
the analyzer re-ran in between, and the response is `409` with the current
state so the UI can re-confirm.

→ `200 DerivedTaskState` · `409 { error, current: DerivedTaskState }`

### 5.4 ✅ `DELETE /projects/:projectId/tasks/:taskId/override`
Clears the override. `effective_status` falls back to `computed_status`.
→ `200 DerivedTaskState`

### 5.5 ✅ Event–task links
- `POST /projects/:projectId/links`. A human links an event to a task:
  `{ event_id, task_id, member_id }` → `201 EventTaskLink` (`method: "manual"`, `status: "confirmed"`)
- `PATCH /projects/:projectId/links/:linkId`. Confirms or rejects a suggestion:
  `{ status: "confirmed" | "rejected"; member_id: string }` → `200 EventTaskLink`

An `llm` link can only become `confirmed` through this endpoint. The
database rejects a confirmation without a confirmer.

### 5.6 ✅ Dismiss a signal or collision
- `PATCH /projects/:projectId/signals/:signalId` `{ status: "dismissed", member_id }` → `200 HealthSignal`
- `PATCH /projects/:projectId/collisions/:collisionId` `{ status: "dismissed", member_id }` → `200 Collision`

A dismissed condition isn't re-raised while it persists. If it resolves
and comes back later, it appears as a new signal.

### 5.7 ✅ Replan suggestions
- `GET /projects/:projectId/replans?status=proposed` → `200 ReplanSuggestion[]`, newest first.
  `status` is optional (omit it for all). `400` unknown status · `404` project.
- `POST /projects/:projectId/replans/:suggestionId/accept` `{ member_id }`
  → `200 { suggestion: ReplanSuggestion; plan_version: number }`
  In one transaction: applies `proposed_changes` to the plan, writes a
  `plan_versions` row (`source: "replan_accepted"`, a snapshot of milestones,
  tasks and dependencies), sets `projects.current_plan_version`, marks the
  suggestion accepted, marks every other `proposed` suggestion `superseded`,
  and adds `replan_reviewed` and `plan_change` timeline items. If any change
  fails, nothing is applied.
- `POST /projects/:projectId/replans/:suggestionId/reject` `{ member_id }` → `200 ReplanSuggestion`
  (adds a `replan_reviewed` timeline item).

| Status | When (accept and reject) |
|---|---|
| `400` | `member_id` missing or not a member of this project |
| `404` | Suggestion doesn't exist in this project |
| `409` | Suggestion isn't `proposed` any more · (accept) the plan moved past `based_on_plan_version` · a change no longer fits (task, milestone or dependency gone) · a change breaks a plan rule (`code: "cycle"`, duplicate dependency) |

`proposed_changes` uses this closed set of operations. B generates and applies
them, and FE renders them, so all sides need the same list. Field values follow
the same rules as the plan endpoints (§3), validated by
`backend/src/api/planChanges.ts`:

The analyzer may create at most one `proposed` suggestion for the current plan
version when active milestone-slipping or incomplete-dependency signals exist.
Generation never applies changes: only the accept endpoint mutates the plan.
Repeated analysis with the same plan version and signal set does not create a
duplicate; proposals based on an older plan version become `superseded`.


```ts
type PlanChange =
  | { op: "update_task"; task_id: string; changes: Partial<CreateTaskInput> }
  | { op: "create_task"; task: CreateTaskInput }
  | { op: "add_dependency"; task_id: string; depends_on_task_id: string }
  | { op: "remove_dependency"; task_id: string; depends_on_task_id: string }
  | { op: "update_milestone"; milestone_id: string; changes: { target_at?: string | null; name?: string } };
```

---

## 6. Timeline and decisions

### 6.1 ✅ `GET /projects/:projectId/timeline` — owner A
Query: `limit?` (default 50, max 200), `cursor?`, `task_id?`.
→ `200 Page<TimelineItem>`, newest first. `404` unknown project.

One feed for everything: GitHub activity (`kind: "github_event"`), plan saves
and accepted replans (`plan_change`), decisions, and B's signal/collision/replan
items. Every item points at its source (`entity_type`, `entity_id`).

GitHub rows: pushes (summary = head commit's first line), branch
created/deleted, and PR opened/merged/closed/reopened. Webhook commits are part
of their push and get no row; backfilled commits (no push) do. Titles are
ready to render, e.g. `"Pranshul-13 opened PR #4: PC-1: Webhook ingestion"`.

`task_id` matches items whose `related_task_ids` include the task. For GitHub
items that includes tasks linked later through non-rejected `event_task_links`,
so `related_task_ids` in the response is always current.

### 6.2 ✅ `GET /projects/:projectId/decisions` / `POST /projects/:projectId/decisions` — owner A
```ts
{ title: string; body?: string; member_id: string; related_task_ids?: string[] }
```
→ `200 Decision[]` (newest first) / `201 Decision` · `400` member or tasks
not in this project · `404` unknown project. Each decision also adds a
`decision` timeline item.

`Decision` isn't in `types.ts` yet. Its fields are `decision_id`, `project_id`,
`title`, `body`, `decided_by`, `decided_at`, `related_task_ids`, `suggestion_id`.

---

## 7. Build order

These unblock the most work first:

1. **§2–3, done.** FE can drop the localStorage mock.
2. **§3.7 plan versions, §2.6–2.7 members.** Needed by the plan editor (pc-2).
3. **§4.1, §4.4, §4.3 repo connection, webhook, backfill.** Once these work,
   Pit Crew can track its own repo for the demo.
4. **§5.1, §5.2 state and evidence.** The dashboard's core view. B can serve
   fixture data before the analyzers exist.
5. **§4.5–4.6, §5.3–5.7, §6.** Everything else.
