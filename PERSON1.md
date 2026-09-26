# Person 1 · Backend A: Task Breakdown

**Role:** Event infrastructure, plan CRUD, API contract  
**Timeline:** H0–H30 (30-hour hackathon)  
**Key accountability:** Ingestion live by H3, all P0 endpoints real by H12, export/restore working by H25

---

## 🏗️ Architecture Reality Check (read this first)

Grounded against the actual `db/schema.sql` and `backend/src/*`, not just the spec. Keeps the hour blocks below from re-planning work that's done or glossing over gaps that are real bugs.

### Deployment: Railway (AD-9, settled)
The spec now bakes this in as **AD-9**: no AWS, host on **Railway** (service + managed PostgreSQL in one project) with **Fly.io** as the fallback (`min_machines_running = 1`). This explicitly rules out **Render, Neon and Supabase too** — all three run on AWS underneath, so they fail the same constraint even though they aren't AWS by name. `backend/src/lambda.ts` is already deleted; the S3-key payload columns and "AWS Secrets Manager" comments are already cleaned out of `schema.sql`/`api-contract.md` (payload stored inline as `jsonb`, matching the spec's own recommendation).

**Action:** create the Railway project (service + PostgreSQL) before H1 — it's now a named blocker in the spec's execution plan, not an open choice.

### Already built — don't re-plan these
- **All three schema layers exist**, including Person 2's tables: `derived_task_states` (override-precedence via a generated `effective_status` column), `health_signals`, `collisions`, `replan_suggestions`, `timeline_items`, `event_task_links`. Treat H12–H18 below as "wire up endpoints for these," not "design them with Person 2."
- **Append-only enforcement is stricter than the spec asks**: `github_events_immutable()` rejects `UPDATE` and direct `DELETE` (checks `pg_trigger_depth()` so cascade deletes still work).
- **Task-key allocation is race-free** (`allocate_task_key()`, row-locked `UPDATE ... RETURNING`).
- Composite FKs (`(project_id, x_id)`) enforce project isolation everywhere — matches AD-7/AD-8.

### Real gaps — add these to the task list
| Gap | Why it matters |
|---|---|
| No `seq` column on `github_events` | Person 2's analyzers need a monotonic cursor. `occurred_at` isn't safe (backfilled facts land in the past, ties possible). Add `seq bigint generated always as identity unique` + the advisory-lock insert pattern before Person 2 builds their consumer loop |
| No `jobs` table | Nothing to run backfill/enrichment/redelivery against. Add before H3–H8 |
| No `backfill_runs` table | No way to report backfill progress via API |
| **Dependency-cycle trigger is a stub** | `task_dependencies_no_cycle()` has a `-- TODO` and always returns `new`. Direct self-dependency is caught by a separate `CHECK`, but **indirect cycles insert successfully with no error today.** Fix with the recursive CTE before the dependencies endpoint ships publicly |
| No webhook receiver / normalizer / worker code | Only `api/app.ts` (plan CRUD) exists. All of spec Part 3 (ingestion) is unbuilt |
| No migration tool | `schema.sql` is one file both you and Person 2 edit. Coordinate by hand — message before editing, keep diffs small |

### Stack: actual vs. spec-recommended
Hono (not Fastify — fine, same raw-body access), `pg` (matches spec's listed alternative), prefixed ULIDs (not uuid — deliberate), zod v4 (matches). **Not yet installed:** Octokit + `@octokit/plugin-throttling` (needed once ingestion starts), pino/structured logging (needed once ingestion starts).

### Design-principles scorecard (spec §1.2)
✅ done: semantic dedupe keys, append-only events, facts-vs-interpretation separation, contract-first stub marking, no per-person surveillance.
⚠️ partial: raw-first (table exists, no receiver yet), visible plumbing (`repositories` has `connection_status`/`last_backfill_at`/`last_event_at` columns but nothing computes an `ingestion.health` field yet).
❌ not started: at-least-once/exactly-once (no worker to exercise it), deterministic normalization (no normalizer), boring-tech job queue (`jobs` table missing).

---

## ⏰ H0–H1: Agreement & Contracts (2 hours)

### Pre-meeting prep
- [ ] Review the spec [§1–§2]: architecture, data model, short task IDs
- [ ] Prepare `src/contracts/` zod schemas (stubs) for all request/response types
- [ ] Draft `fixtures/sample-project.json` (Pit Crew itself, with Person 2/3 task assignments)
- [ ] Draft `fixtures/sample-events.json` (24 events telling the demo story)

### Hour 0–1 sync with Persons 2 & 3
- [ ] Walk the [§7.3 Hour 0–1 checklist](#decisions-to-sign-off):
  - D1: Stack (TypeScript, Fastify, PostgreSQL, dbmate, zod, Octokit)
  - D2: Hosting — **settled: Railway** (service + PostgreSQL, one project; Fly.io as fallback). No AWS, which also rules out Render/Neon/Supabase
  - D3: Which repos to connect
  - D4: Task ID prefix + branch/PR naming conventions
  - D5: Task status vocabulary (not_started / in_progress / complete / blocked)
  - D6: Branch changed-file facts (Person 2's input to collisions)
  - D7: Person 2 runtime (in-process CoreFacade vs out-of-process)
  - D8: API auth (shared token + X-Pitcrew-Member-Id)
  - D9: Brief format (ProseMirror JSON vs markdown)
  - D10: Person 2 event conventions (reserved namespaces, keys, summary)
  - D11: Timeline projection (server-side)
  - D12: Sample project approval
  - D13: Demo signals ownership & timing
- [ ] **Sign off on:** `0001_init.sql`, fixtures, API contract (`src/contracts/`)

### Commit & notify
- [ ] Commit schema + contracts + fixtures to main
- [ ] Message team: "contracts locked, integrate from fixtures"

---

## 🚀 H1–H3: Ingestion Deployed (2 hours)

### Service skeleton
- [ ] Project structure: `src/app.ts`, `src/config.ts`, `src/db.ts`, `src/ids.ts`
- [ ] Env parsing (fail fast): `DATABASE_URL`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, tokens, `CORS_ALLOWED_ORIGINS`
- [ ] Database connection pool + `dbmate up` (release step)
- [ ] Health endpoints: `/healthz`, `/readyz`, `/api/v1/meta`

### Stub mode (every P0 endpoint from fixtures)
- [ ] Create stub handler that returns fixtures with `X-Pitcrew-Stub: true`
- [ ] Deploy stub API (Person 3 integrates against it now)

### Webhook receiver [§3.3]
- [ ] Route: `POST /webhooks/github`
- [ ] Raw body handling (Fastify plugin or Express middleware)
- [ ] HMAC-SHA256 verification (timing-safe)
  - [ ] Unit test: GitHub's vector (secret: "It's a Secret to Everybody", payload: "Hello, World!")
  - [ ] Negative tests: bad signature, missing header, `sha1=` (legacy)
- [ ] Insert into `webhook_deliveries` (idempotent, `delivery_id` PK)
- [ ] Respond `202`/`200` within 100 ms

### Ingestion worker + normalizers
- [ ] Worker loop: claim delivery → normalize → evolve → commit
- [ ] `src/modules/ingestion/normalize/`: dispatch by event type
  - [ ] `push.ts`: handles branch create/delete/push
  - [ ] `pull_request.ts`: opened/closed/merged/reopened/edited/synchronize
- [ ] `src/modules/ingestion/normalize/keys.ts`: deterministic `external_event_id` builders (the dedupe contract)
  - [ ] Test: same delivery twice → same keys
- [ ] Evolve (read-model reducers):
  - [ ] `branches.ts`: state machine (ABSENT → PRESENT → ABSENT)
  - [ ] `pull_requests.ts`: monotonic upsert on `gh_updated_at`
  - [ ] `commits.ts`: first-writer-wins
- [ ] Retry logic: exponential backoff, mark `failed` after 8 attempts
- [ ] Test: send a real push fixture, verify `branch.created`, `push`, `commit` rows exist

### Minimal APIs (enough to bootstrap)
- [ ] `POST /api/v1/projects` (create project + team + brief + initial plan in one txn)
- [ ] `POST /api/v1/projects/:id/repositories` (connect GitHub repo, create hook auto)
- [ ] Emit `pitcrew` events for create actions

### Deploy & smoke test
- [ ] Deploy to Railway (service + PostgreSQL, `dbmate up` as the release step)
- [ ] Create sample project on the real Pit Crew repo(s)
- [ ] Push to a branch (`pc-2-webhook-ingestion`), verify events appear within 5 s

**Exit criterion:** Real GitHub pushes/PRs produce events in production. Person 2 can see `seq` data.

---

## 📡 H3–H8: Core APIs, Backfill, Timeline (5 hours)

### Real planning APIs
- [ ] `GET /api/v1/projects/{id}` + list
- [ ] `PUT /api/v1/projects/{id}/brief` (with `expected_revision` concurrency control)
- [ ] `GET /api/v1/projects/{id}/brief`
- [ ] `POST/GET/PATCH/DELETE /projects/{id}/members`
- [ ] `POST/GET/PATCH/DELETE /projects/{id}/milestones`
- [ ] `POST /projects/{id}/tasks` (allocate `short_id` atomically)
- [ ] `GET/PATCH /projects/{id}/tasks/{taskRef}` (by ID or short_id)
- [ ] `DELETE /projects/{id}/tasks/{taskRef}` (soft delete)
- [ ] `POST/DELETE /projects/{id}/dependencies` (cycle check)
- [ ] Validation: task prefix locked after first task, cycle detection, FK/project isolation
- [ ] Emit `plan.*` events on every mutation

### Event consumption (for Person 2)
- [ ] `GET /api/v1/projects/{id}/events` (filters: types, source, since/until, actor, branch, task)
- [ ] Sequence pagination: `after_seq`, `next_after_seq`
- [ ] `GET /api/v1/projects/{id}/events/{eventId}`
- [ ] **In-process facade:** `readEventsAfter()`, `onEventsIngested()`, `recordEvents()` (Person 2 owns their output table + event writes)
- [ ] Test: Person 2 can resume from a checkpoint

### Backfill job [§4.4]
- [ ] Backfill runner: repository connect triggers it
- [ ] Steps:
  1. `GET /repos/{o}/{r}` → refresh default_branch
  2. `GET /repos/{o}/{r}/activity` (OLDEST → NEWEST) → push/branch events
  3. For each unseen push: `GET /compare/{before}...{after}` → commits
  4. `GET /repos/{o}/{r}/branches` → branch listing → per-branch `GET /compare/{default}...{head}`
  5. `GET /repos/{o}/{r}/pulls?state=all` → PR events + open PR files
  6. `GET /repos/{o}/{r}/commits?sha={default}` → commit listing
- [ ] Write through the same path as webhook (normalize + evolve)
- [ ] Debounce: only one pending backfill per repo
- [ ] Record `backfill_runs` with stats
- [ ] Test: backfill after webhook and webhook after backfill → identical event set

### Enrichment jobs
- [ ] Job runner: poll `jobs` table with `FOR UPDATE SKIP LOCKED`
- [ ] `enrich.branch_compare`: `GET /compare/{default}...{head}`, upsert `branch_files`
- [ ] `enrich.pr_files`: `GET /pulls/{n}/files`, upsert `pull_request_files`
- [ ] Rate-limit aware: respect `x-ratelimit-reset`, `retry-after`
- [ ] Test: compare refresh debounce works (5 s, merge bursts)

### Timeline projection [§5.3]
- [ ] `GET /api/v1/projects/{id}/timeline` (cursor paginated, newest first)
- [ ] Projection rules:
  - Push + nested commits (max 20)
  - Branch lifecycle items
  - PR items (opened/merged/closed)
  - Plan items (task/milestone created/updated/deleted, changeset applied)
  - Brief edits coalesced by actor within 15 min
  - Repository events (connected, verified, backfill done)
  - Analysis items (Person 2's conclusions)
- [ ] Keyset cursor on `(occurred_at desc, event_id)`
- [ ] Test: events project into readable items with correct nesting

### Reconcile loop [§4.8]
- [ ] Lightweight backfill: activity (OLDEST → NEWEST) since last run − 10 min
- [ ] Detect missed changes: if activity recovered anything the webhook should have brought, set `missed_changes_detected_at` and `webhook_status = failing`
- [ ] Run every 10 min + on startup
- [ ] Don't emit to timeline (noise)

**Exit criterion:** Person 3's timeline renders real events. Person 2 can consume by `seq`. Backfill recovers history.

---

## 🎯 H8–H12: End-to-End (4 hours)

### Remaining P0 APIs
- [ ] `GET /api/v1/projects/{id}/workspace` (one-call hydration: project, members, brief, plan, repos, timeline)
- [ ] `GET /api/v1/projects/{id}/branches` (with optional `?include=files`)
- [ ] `GET /api/v1/projects/{id}/pull-requests` (with optional `?include=files`)
- [ ] `GET /api/v1/projects/{id}/commits`
- [ ] Repository ingestion status: `webhook.status`, `health`, `last_delivery_at`, rate limits, backfill status

### Export [§6.3]
- [ ] `GET /api/v1/admin/projects/{id}/export` (NDJSON, gzip)
- [ ] Format: header → planning tables → deliveries (received_at order) → events (seq order) → read models → extension tables → footer (sha256)
- [ ] CLI: `pitcrew export --project {id} | gzip > export.ndjson.gz`
- [ ] Test: export can be read line by line

### Hardening
- [ ] Retry backoff: exponential from 2 s to 10 min
- [ ] Unroutable repository: retry 10 min, then `ignored`
- [ ] NUL byte stripping in receiver (payload strings can contain `\u0000`)
- [ ] Parse `repository.pushed_at` as both integer epoch and ISO string
- [ ] Body size limits: 25 MiB webhook, 1 MiB brief, 256 KiB elsewhere
- [ ] Error standardization: never leak SQL/constraint names, always `{error, code?, issues?}`

### Logging
- [ ] Structured JSON logs: `delivery.received`, `delivery.processed`, `delivery.failed`, `job.succeeded`, `reconcile.missed_changes`
- [ ] Always include: `request_id`, `delivery_id`, `event_name`, `project_id`
- [ ] Never log payloads at info level

### Integration test suite
- [ ] Embedded PostgreSQL (`vtest/api.test.ts`)
- [ ] Fixtures sent through the full pipeline
- [ ] Assert: workspace shape matches frontend types, timeline structure, event counts

**Exit criterion:** `POST /projects` → `GET /workspace` + `GET /timeline` shows real history. No stub mode.

---

## 🔍 H12–H18: Collision & Derived State Facts (6 hours)

### Branch changed files [§3.8]
- [ ] Ensure `branch.compared` events are emitted on every push to non-default branches
- [ ] Verify `branch_files` snapshot is populated and indexed
- [ ] Add fields:
  - [ ] `branches.merged_pr_number` (set on PR merge, cleared if head moves)
  - [ ] `branches.compare_*`, `merge_base_sha`, `ahead_by`, `behind_by`
  - [ ] `files_head_sha`, `files_truncated`, `files_refreshed_at`
- [ ] Branch lifecycle guard: don't emit `branch.compared` if `files_head_sha` == current head
- [ ] Test: two active branches modifying the same file produce both `branch.compared` events with overlapping files

### Person 2's event writes
- [ ] `POST /api/v1/projects/{id}/events` (Person 2's internal write API)
  - [ ] Require `Authorization: Bearer <PITCREW_SERVICE_TOKEN>` (or in-process call)
  - [ ] Restrict `event_type` to reserved namespaces: `state.*`, `health.*`, `collision.*`, `inference.*`, `replan.*`, `correction.*`
  - [ ] Require `payload.summary` (human-readable, rendered on timeline)
  - [ ] Accept deterministic `external_event_id` (idempotent re-runs)
  - [ ] Return `201 {id, seq}` or `200 {id, seq, duplicate: true}`
- [ ] Timeline includes `analysis` items with `severity` (info/warning/critical)

### Support Person 2's integration
- [ ] `registerExportTable()`: Person 2 registers their tables for export
- [ ] Test Person 2's analyzer loop:
  - [ ] `readEventsAfter(projectId, 0)` returns events in order
  - [ ] `onEventsIngested()` fires after each commit
  - [ ] `recordEvents(tx, projectId, [...])` persists their conclusions

---

## 📋 H18–H20: Plan Versions & Changesets (2 hours)

### Plan revisions [§2.4]
- [ ] `plan_revisions` table: record every plan mutation (revision, source, changes, snapshot)
- [ ] Every plan mutation (task/milestone create/update/delete, changeset) bumps `projects.plan_revision` and writes one row
- [ ] `GET /api/v1/projects/{id}/plan/revisions` (paginated, newest first)
- [ ] `GET /api/v1/projects/{id}/plan/revisions/{revision}` (detail with snapshot)

### Atomic changesets [§5.3]
- [ ] `POST /api/v1/projects/{id}/plan/changesets`
  - [ ] Input: `expected_plan_revision`, `dry_run`, `source`, `suggestion_id`, `summary`, `operations[]`
  - [ ] Operations: create_task, update_task, delete_task, add_dependency, remove_dependency, reorder, create_milestone, update_milestone, delete_milestone
  - [ ] `dry_run: true` → validate, return diff + resulting plan, **don't commit**
  - [ ] `dry_run: false` → apply atomically in one txn, write `plan_revisions` row, emit `plan.changeset_applied` event
- [ ] Validation: dependency cycles, FK integrity, `expected_plan_revision` matches
- [ ] Error response includes detailed issues per operation
- [ ] Test: changeset → export → import → same plan state

---

## 🛡️ H20–H25: Hardening, Drills, Replay (5 hours)

### Restore [§6.4.1]
- [ ] CLI: `pitcrew import --file export.ndjson.gz` into an empty database
- [ ] Bulk-insert by `external_event_id`: new events inserted, changed payloads updated in place
- [ ] Rebuild read models: truncate, fold all events through `evolve`
- [ ] `pitcrew verify --file export.ndjson.gz`: checksums + key count validation
- [ ] Test: export → import → same event count, seq order, checksums

### Timed replay [§6.4.2]
- [ ] CLI: `pitcrew replay --file export.ndjson.gz --from T --speed 20`
- [ ] Restore up to `T`
- [ ] Stream events after `T` with `sleep((Δ ingested_at) / speed)` between them
- [ ] Events written with original `occurred_at` (the truthful story)
- [ ] `ingest_mode = replay`, original delivery included
- [ ] Person 2's recorded conclusions skipped by default (they regenerate from facts)
- [ ] Honors `PITCREW_CLOCK_OFFSET_SECONDS` for time-based rules
- [ ] Test: replay twice, dashboard reacts live to events

### Failure drills
- [ ] **Drill 1:** Stop the service while pushing, let reconcile recover
  - [ ] Push a commit, stop backend mid-processing, verify reconcile recovers the push
- [ ] **Drill 2:** Wrong webhook secret
  - [ ] Change the secret, send a delivery, verify `401` in logs
  - [ ] Fix the secret, redeliver manually, verify it processes
- [ ] **Drill 3:** Normalizer exception
  - [ ] Inject a bug in a normalizer, send a delivery, verify it lands in `failed`
  - [ ] Fix the bug, `POST /admin/deliveries/retry-failed`, verify it processes
- [ ] **Drill 4:** Full Plan B on the demo laptop
  - [ ] Restore export, run backend with `PITCREW_OFFLINE=1`
  - [ ] Rehearse `pitcrew replay --from T --speed 20` for demo moments
  - [ ] Verify replay captures all signals the live version showed

### Round-trip test
- [ ] Export → import into an empty DB
- [ ] Compare: event counts, checksums, read-model row counts
- [ ] All checks must pass

---

## ❄️ H25–H26: Freeze Prep (1 hour)

- [ ] Take pre-freeze export at H25:00
- [ ] Restore it on the demo laptop (local PostgreSQL + backend with `PITCREW_OFFLINE=1`)
- [ ] Verify frontend can switch to laptop stack (env var or UI toggle)
- [ ] Record replay cutoffs in `docs/demo-moments.md` for each demo signal
- [ ] Rehearse timed replay twice end-to-end
- [ ] Verify PAT expiry is after judging + host won't sleep

---

## 🎬 H26–H30: Freeze, Rehearsal, Judging (4 hours)

- [ ] **No schema changes.** Bug fixes only.
- [ ] Export again at H28 + H29:00 (two storage locations)
- [ ] Dogfood the dashboard with the team for 2 hours
- [ ] Run the [pre-judging checklist](#h84-pre-judging-checklist) before H30:00
- [ ] Final replay rehearsal at H29:45

---

## 📊 Decision Checklist (H0–H1)

### D1: Stack
- [ ] TypeScript, Node 22 LTS, Fastify, PostgreSQL 16, dbmate, zod, Octokit

### D2: Hosting — ✅ settled (AD-9)
- [x] Railway: one project, service + managed PostgreSQL. No scale-to-zero, no cold-start
- [ ] Fallback if Railway doesn't work out: Fly.io with `min_machines_running = 1`
- Excluded (all run on AWS underneath): Render, Neon, Supabase

### D3: Repositories
- [ ] Which repos? ______________________

### D4: Task IDs
- [ ] Prefix: `pc` (or ____), branch: `pc-<n>-slug`, PR: `pc-<n>: title`
- [ ] Matcher regex: `/(?<![a-z0-9])pc-(\d+)(?![0-9])/gi`

### D5: Plan status vocabulary
- [ ] Declared: `not_started`, `in_progress`, `complete`, `blocked`
- [ ] Mirrors derived states (Person 2 agrees)

### D6: Changed files
- [ ] Person 1: per-branch compare-based file sets
- [ ] Person 2: defines "active", intersects for collisions

### D7: Person 2 runtime
- [ ] In-process modules + `CoreFacade`
- [ ] Derived-state served by Person 2's endpoints
- [ ] `workspace?include=derived_state` optional

### D8: API auth
- [ ] Shared bearer token + `X-Pitcrew-Member-Id`
- [ ] Frontend server proxy or SPA (decided: ______)

### D9: Brief format
- [ ] ProseMirror JSON (TipTap)
- [ ] Markdown fallback in same endpoint

### D10: Person 2 event conventions
- [ ] Namespaces: `state.*`, `health.*`, `collision.*`, `inference.*`, `replan.*`, `correction.*`
- [ ] Deterministic keys, `payload.summary`, optional `severity`, optional `evidence_event_ids`

### D11: Timeline
- [ ] Server-side projection (Person 1 owns)
- [ ] Ready-made titles, nesting, grouping

### D12: Sample project
- [ ] Approved: `fixtures/sample-project.json` (Pit Crew with task assignments)

### D13: Demo signals
- [ ] Collision pair owners: ______ & ______, by H16
- [ ] PR depending on unfinished task: ______, by H11
- [ ] Other signals (happening naturally): marked by H18

---

## 🚨 Pre-Judging Checklist (H26–H30)

- [ ] `ingestion.health = live`. Last delivery ≤ 10 min ago.
- [ ] Zero failed deliveries (or each one understood).
- [ ] Reconcile ran in last 15 min, recovered nothing (or noted the gap).
- [ ] **Demo signals present:** list event IDs in `docs/demo-moments.md`.
- [ ] Final export taken, stored in two places.
- [ ] Laptop stack running (`PITCREW_OFFLINE=1`), frontend switch tested.
- [ ] Replay cutoffs rehearsed twice.
- [ ] PAT expiry after judging. Host always-on. No deploys after H29 (except P0 bug).
- [ ] Admin token available (never shown).

---

## 🔪 Cut List (if behind)

Cut in this order:

1. GitHub redelivery job ([§4.9](#49-redelivering-failed-deliveries-from-github-p2)). Reconcile covers it.
2. Re-normalization tool ([§6.6](#66-re-normalization)). Use targeted retries.
3. `pull_request_review` ingestion.
4. Lazy commit-file enrichment (backfilled commits).
5. Plan revision detail endpoint.
6. Timed replay. **Keep export + restore.**
7. Changesets `dry_run` (keep PATCH for manual edits).

**Never cut:** webhook ingestion, event store, backfill (activity + branches + PRs), branch files (collision example), projects/brief/plan APIs, timeline, ingestion status, export/restore.

---

## 📚 Reference

- **[Full spec](PitCrew-Person1-BackendA-Spec.md)** § citations above link to that document
- **Sample project:** `fixtures/sample-project.json`
- **Sample events:** `fixtures/sample-events.json`
- **Contract types:** `src/contracts/api.ts`, `src/contracts/events.ts`
- **Run:** `npm run dev` (local), `dbmate up` (migrations)
