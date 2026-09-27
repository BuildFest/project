import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { startTestDb } from "./db.js";
import { startMaintainerDigests } from "../src/maintainer/service.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  process.env.ASK_RATE_LIMIT_PER_MINUTE = "2";
  db = await startTestDb();
  pool = db.pool;
  app = createApp(pool);
}, 120_000);

afterAll(async () => {
  delete process.env.ASK_RATE_LIMIT_PER_MINUTE;
  await db?.stop();
});

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body?: unknown) {
  const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

let n = 0;
async function seedProject() {
  const id = ++n;
  const p = `proj_${id}`;
  await pool.query(
    `insert into projects (project_id, name, task_key_prefix, created_by) values ($1, 'Pit Crew', 'PC', 'test')`,
    [p],
  );
  await pool.query(
    `insert into repositories (repository_id, project_id, owner, name, full_name)
     values ($1, $2, 'BuildFest', 'project', 'BuildFest/project')`,
    [`repo_${id}`, p],
  );
  await pool.query(
    `insert into tasks (task_id, task_key, project_id, title, sort_order, archived) values
       ($2, 'PC-1', $1, 'Authentication API', 1, false),
       ($3, 'PC-2', $1, 'Dashboard', 2, false),
       ($4, 'PC-3', $1, 'Old idea', 3, true)`,
    [p, `task_auth_${id}`, `task_dash_${id}`, `task_old_${id}`],
  );
  return {
    project: p,
    repo: `repo_${id}`,
    auth: `task_auth_${id}`,
    dash: `task_dash_${id}`,
    old: `task_old_${id}`,
  };
}

type Seed = Awaited<ReturnType<typeof seedProject>>;

async function addEvent(s: Seed, eventId: string, occurredAt: string) {
  await pool.query(
    `insert into github_events
       (event_id, project_id, repository_id, source, external_event_id, event_type, occurred_at, branch, commit)
     values ($1, $2, $3, 'backfill', $1, 'commit', $4, 'jwt', '{"sha":"a","message":"jwt refresh"}')`,
    [eventId, s.project, s.repo, occurredAt],
  );
}

async function addState(s: Seed, taskId: string, status: string, computedAt: string, blocking: string[] = []) {
  await pool.query(
    `insert into derived_task_states (task_id, project_id, computed_status, computed_at, blocking_task_ids)
     values ($1, $2, $3, $4, $5)`,
    [taskId, s.project, status, computedAt, blocking],
  );
}

async function addSignal(s: Seed, id: string, status: "active" | "resolved", taskIds: string[]) {
  await pool.query(
    `insert into health_signals
       (signal_id, project_id, type, status, severity, title, explanation, related_task_ids, resolved_at, fingerprint)
     values ($1, $2, 'task_possibly_blocked', $3, 'warning', 'Blocked', 'Waiting on PC-1', $4,
             case when $3 = 'active' then null else now() end, $1)`,
    [id, s.project, status, taskIds],
  );
}

describe("GET /projects/:projectId/state", () => {
  it("returns 404 for an unknown project", async () => {
    expect((await get("/projects/proj_missing/state")).status).toBe(404);
  });

  it("returns empty state for a project that was never analyzed", async () => {
    const s = await seedProject();
    const res = await get(`/projects/${s.project}/state`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      computed_at: null,
      agent: {
        status: "waiting",
        last_trigger: null,
        last_mode: null,
        ai_available: false,
        last_started_at: null,
        last_completed_at: null,
        last_succeeded_at: null,
        last_failed_at: null,
        last_error: null,
        last_result: null,
        runs_count: 0,
      },
      tasks: [],
      signals: [],
      collisions: [],
      pending_links: [],
      open_replans: 0,
    });
  });

  it("returns only current, active, non-archived state", async () => {
    const s = await seedProject();
    await addState(s, s.dash, "possibly_blocked", "2026-09-26T12:00:00Z", [s.auth]);
    await addState(s, s.auth, "in_progress", "2026-09-26T13:00:00Z");
    await addState(s, s.old, "not_started", "2026-09-26T14:00:00Z");
    await addSignal(s, `sig_a${n}`, "active", [s.dash]);
    await addSignal(s, `sig_r${n}`, "resolved", [s.dash]);
    await pool.query(
      `insert into collisions (collision_id, project_id, repository_id, branch_a, branch_b, overlapping_files, status, resolved_at)
       values ($1, $3, $4, 'a', 'b', '{src/x.ts}', 'active', null),
              ($2, $3, $4, 'c', 'd', '{src/y.ts}', 'resolved', now())`,
      [`col_a${n}`, `col_r${n}`, s.project, s.repo],
    );
    await addEvent(s, `evt_old${n}`, "2026-09-26T10:00:00Z");
    await addEvent(s, `evt_new${n}`, "2026-09-26T11:00:00Z");
    await pool.query(
      `insert into event_task_links (link_id, project_id, event_id, task_id, method, confidence, status) values
         ($1, $4, $5, $7, 'llm', 0.6, 'suggested'),
         ($2, $4, $6, $7, 'llm', 0.9, 'suggested'),
         ($3, $4, $6, $8, 'task_key', 1, 'confirmed')`,
      [`link_1${n}`, `link_2${n}`, `link_3${n}`, s.project, `evt_old${n}`, `evt_new${n}`, s.auth, s.dash],
    );
    await pool.query(
      `insert into plan_versions (project_id, version, source, snapshot) values ($1, 1, 'initial', '{}')`,
      [s.project],
    );
    await pool.query(
      `insert into replan_suggestions (suggestion_id, project_id, based_on_plan_version, status, rationale, generated_by)
       values ($1, $3, 1, 'proposed', 'x', 'rules'), ($2, $3, 1, 'superseded', 'y', 'rules')`,
      [`rp_1${n}`, `rp_2${n}`, s.project],
    );

    const { body } = await get(`/projects/${s.project}/state`);

    expect(body.computed_at).toBe("2026-09-26T14:00:00.000Z");
    expect(body.tasks.map((t: any) => [t.task_id, t.effective_status, t.blocking_task_ids])).toEqual([
      [s.auth, "in_progress", []],
      [s.dash, "possibly_blocked", [s.auth]],
    ]);
    expect(body.signals.map((x: any) => x.signal_id)).toEqual([`sig_a${n}`]);
    expect(body.collisions.map((x: any) => x.collision_id)).toEqual([`col_a${n}`]);
    expect(body.pending_links.map((l: any) => [l.link_id, l.event.event_id])).toEqual([
      [`link_2${n}`, `evt_new${n}`],
      [`link_1${n}`, `evt_old${n}`],
    ]);
    expect(body.pending_links[0].event.occurred_at).toBe("2026-09-26T11:00:00.000Z");
    expect(body.open_replans).toBe(1);
  });
});

describe("GET /projects/:projectId/risks", () => {
  it("returns unified risk lifecycles and links matching resolution events", async () => {
    const s = await seedProject();
    await addSignal(s, `sig_active${n}`, "active", [s.auth]);
    await addSignal(s, `sig_resolved${n}`, "resolved", [s.dash]);
    await pool.query(
      `insert into collisions
         (collision_id, project_id, repository_id, branch_a, branch_b, overlapping_files, status, detected_at, resolved_at)
       values ($1, $2, $3, 'feature/a', 'feature/b', '{src/shared.ts}', 'resolved',
               '2026-09-26T11:00:00Z', '2026-09-26T13:00:00Z')`,
      [`col_resolved${n}`, s.project, s.repo],
    );
    await pool.query(
      `insert into timeline_items
         (item_id, project_id, occurred_at, kind, title, entity_type, entity_id)
       values ($1, $3, '2026-09-26T10:00:00Z', 'signal_detected', 'Blocked', 'health_signal', $4),
              ($2, $3, '2026-09-26T12:00:00Z', 'signal_resolved', 'Blocked resolved', 'health_signal', $4),
              ($5, $3, '2026-09-26T13:00:00Z', 'collision_resolved', 'Collision resolved', 'collision', $6)`,
      [`tl_detected${n}`, `tl_resolved${n}`, s.project, `sig_resolved${n}`, `tl_collision${n}`, `col_resolved${n}`],
    );

    const all = await get(`/projects/${s.project}/risks`);
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(3);
    expect(all.body.find((risk: any) => risk.risk_id === `sig_resolved${n}`)).toMatchObject({
      kind: "signal", status: "resolved", detection_event_id: `tl_detected${n}`,
      resolution_event_id: `tl_resolved${n}`,
    });
    expect(all.body.find((risk: any) => risk.risk_id === `col_resolved${n}`)).toMatchObject({
      kind: "collision", status: "resolved", resolution_event_id: `tl_collision${n}`,
    });

    const active = await get(`/projects/${s.project}/risks?status=active&limit=1`);
    expect(active.body.map((risk: any) => risk.risk_id)).toEqual([`sig_active${n}`]);
  });

  it("validates filters and returns 404 for an unknown project", async () => {
    const s = await seedProject();
    expect((await get(`/projects/${s.project}/risks?status=unknown`)).status).toBe(400);
    expect((await get(`/projects/${s.project}/risks?limit=0`)).status).toBe(400);
    expect((await get("/projects/proj_missing/risks")).status).toBe(404);
  });
});

describe("GET /projects/:projectId/tasks/:taskId/evidence", () => {
  it("returns 404 for an unknown project or task", async () => {
    const s = await seedProject();
    expect((await get(`/projects/proj_missing/tasks/${s.auth}/evidence`)).status).toBe(404);
    expect((await get(`/projects/${s.project}/tasks/task_missing/evidence`)).status).toBe(404);

    const other = await seedProject();
    expect((await get(`/projects/${s.project}/tasks/${other.auth}/evidence`)).status).toBe(404);
  });

  it("returns empty evidence for a task that was never analyzed", async () => {
    const s = await seedProject();
    const res = await get(`/projects/${s.project}/tasks/${s.old}/evidence`);

    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({ task_id: s.old, archived: true });
    expect(res.body.state).toBeNull();
    expect(res.body.blocking_tasks).toEqual([]);
    expect(res.body.links).toEqual([]);
    expect(res.body.signals).toEqual([]);
  });

  it("returns current evidence with nested events in newest-first order", async () => {
    const s = await seedProject();
    await addState(s, s.auth, "complete", "2026-09-26T09:00:00Z");
    await addState(s, s.dash, "possibly_blocked", "2026-09-26T12:00:00Z", [s.auth, "task_dangling"]);
    await addEvent(s, `evt_old${n}`, "2026-09-26T10:00:00Z");
    await addEvent(s, `evt_new${n}`, "2026-09-26T11:00:00Z");
    await addEvent(s, `evt_rejected${n}`, "2026-09-26T09:00:00Z");
    await pool.query(
      `insert into event_task_links (link_id, project_id, event_id, task_id, method, confidence, status, reason) values
         ($1, $5, $6, $8, 'manual', 1, 'confirmed', 'older proof'),
         ($2, $5, $7, $8, 'llm', 0.9, 'suggested', 'newer proof'),
         ($3, $5, $7, $9, 'manual', 1, 'confirmed', 'other task'),
         ($4, $5, $10, $8, 'llm', 0.5, 'rejected', 'rejected proof')`,
      [
        `link_old${n}`, `link_new${n}`, `link_other${n}`, `link_rejected${n}`, s.project,
        `evt_old${n}`, `evt_new${n}`, s.dash, s.auth, `evt_rejected${n}`,
      ],
    );
    await addSignal(s, `sig_old${n}`, "active", [s.dash]);
    await pool.query("update health_signals set detected_at = $2 where signal_id = $1", [`sig_old${n}`, "2026-09-26T12:00:00Z"]);
    await addSignal(s, `sig_new${n}`, "active", [s.auth, s.dash]);
    await pool.query("update health_signals set detected_at = $2 where signal_id = $1", [`sig_new${n}`, "2026-09-26T13:00:00Z"]);
    await addSignal(s, `sig_resolved${n}`, "resolved", [s.dash]);
    await addSignal(s, `sig_other${n}`, "active", [s.auth]);

    const res = await get(`/projects/${s.project}/tasks/${s.dash}/evidence`);

    expect(res.status).toBe(200);
    expect(res.body.task.task_id).toBe(s.dash);
    expect(res.body.state).toMatchObject({ task_id: s.dash, effective_status: "possibly_blocked" });
    expect(res.body.state.computed_at).toBe("2026-09-26T12:00:00.000Z");
    expect(res.body.blocking_tasks).toHaveLength(1);
    expect(res.body.blocking_tasks[0].task.task_id).toBe(s.auth);
    expect(res.body.blocking_tasks[0].state).toMatchObject({ task_id: s.auth, effective_status: "complete" });
    expect(res.body.links.map((link: any) => [link.link_id, link.reason, link.event.event_id])).toEqual([
      [`link_new${n}`, "newer proof", `evt_new${n}`],
      [`link_old${n}`, "older proof", `evt_old${n}`],
    ]);
    expect(res.body.links[0].event.occurred_at).toBe("2026-09-26T11:00:00.000Z");
    expect(res.body.signals.map((signal: any) => signal.signal_id)).toEqual([`sig_new${n}`, `sig_old${n}`]);
    expect(res.body.signals[0].detected_at).toBe("2026-09-26T13:00:00.000Z");
  });
});

describe("Maintainer API", () => {
  it("creates on-demand deterministic digests and lists notes without keys", async () => {
    const s = await seedProject();
    await addEvent(s, `evt_digest${n}`, "2026-09-26T12:00:00Z");
    const created = await post(`/projects/${s.project}/maintainer/digest`);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ project_id: s.project, kind: "digest", generated_by: "rules" });
    expect(created.body.citations).toEqual([{ type: "event", id: `evt_digest${n}` }]);
    const notes = await get(`/projects/${s.project}/maintainer/notes`);
    expect(notes.body.map((note: any) => note.note_id)).toEqual([created.body.note_id]);
  });

  it("answers Ask Pit Crew with stored grounded fallback and validates input", async () => {
    const s = await seedProject();
    await addSignal(s, `sig_ask${n}`, "active", [s.auth]);
    expect((await post(`/projects/${s.project}/ask`, { question: "?" })).status).toBe(400);
    const answer = await post(`/projects/${s.project}/ask`, { question: "What needs attention?" });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ kind: "answer", question: "What needs attention?", generated_by: "rules" });
    expect(answer.body.citations).toContainEqual({ type: "signal", id: `sig_ask${n}` });
    expect(answer.body.body).toContain("What needs attention?");
  });

  it("rate limits Ask Pit Crew per project", async () => {
    const first = await seedProject();
    const second = await seedProject();
    for (const question of ["First question", "Second question"]) {
      expect((await post(`/projects/${first.project}/ask`, { question })).status).toBe(201);
    }
    const limited = await post(`/projects/${first.project}/ask`, { question: "Third question" });
    expect(limited).toMatchObject({ status: 429, body: { error: "Ask Pit Crew rate limit exceeded" } });
    expect((await post(`/projects/${second.project}/ask`, { question: "Independent project" })).status).toBe(201);
  });

  it("returns 404 for missing projects", async () => {
    expect((await post("/projects/proj_missing/maintainer/digest")).status).toBe(404);
    expect((await post("/projects/proj_missing/ask", { question: "What changed?" })).status).toBe(404);
    expect((await get("/projects/proj_missing/maintainer/notes")).status).toBe(404);
  });

  it("runs an initial digest sweep without waiting for the interval", async () => {
    const s = await seedProject();
    const timer = startMaintainerDigests(pool, null, 1_000);
    try {
      let count = 0;
      for (let attempt = 0; attempt < 50 && count === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        count = (await pool.query("select count(*)::int n from maintainer_notes where project_id=$1 and kind='digest'", [s.project])).rows[0].n;
      }
      expect(count).toBe(1);
    } finally { clearInterval(timer); }
  });
});
