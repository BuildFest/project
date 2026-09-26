import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { startTestDb } from "./db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await startTestDb();
  pool = db.pool;
  app = createApp(pool);
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let n = 0;

// A project with one member, a milestone, three tasks (dash requires auth)
// and a saved plan version 1.
async function seedProject() {
  const id = ++n;
  const s = {
    project: `proj_${id}`,
    member: `mem_${id}`,
    milestone: `ms_${id}`,
    auth: `task_auth_${id}`,
    dash: `task_dash_${id}`,
    stats: `task_stats_${id}`,
  };
  await pool.query(
    `insert into projects (project_id, name, task_key_prefix, created_by, next_task_number)
     values ($1, 'Pit Crew', 'PC', 'test', 4)`,
    [s.project],
  );
  await pool.query(
    `insert into project_members (member_id, project_id, display_name) values ($1, $2, 'Dev')`,
    [s.member, s.project],
  );
  await pool.query(
    `insert into milestones (milestone_id, project_id, name, target_at) values ($1, $2, 'MVP', '2026-09-27T12:00:00Z')`,
    [s.milestone, s.project],
  );
  await pool.query(
    `insert into tasks (task_id, task_key, project_id, title, priority, scope, milestone_id) values
       ($2, 'PC-1', $1, 'Authentication API', 'high', 'must_have', $5),
       ($3, 'PC-2', $1, 'Dashboard', 'medium', 'must_have', $5),
       ($4, 'PC-3', $1, 'Analytics', 'low', 'optional', $5)`,
    [s.project, s.auth, s.dash, s.stats, s.milestone],
  );
  await pool.query(
    `insert into task_dependencies (project_id, task_id, depends_on_task_id) values ($1, $2, $3)`,
    [s.project, s.dash, s.auth],
  );
  await pool.query(
    `insert into plan_versions (project_id, version, source, snapshot) values ($1, 1, 'initial', '{}')`,
    [s.project],
  );
  await pool.query(`update projects set current_plan_version = 1 where project_id = $1`, [s.project]);
  return s;
}

type Seed = Awaited<ReturnType<typeof seedProject>>;

let r = 0;
async function addSuggestion(s: Seed, changes: unknown[], status = "proposed", basedOn = 1) {
  const suggestionId = `rp_${++r}`;
  await pool.query(
    `insert into replan_suggestions
       (suggestion_id, project_id, based_on_plan_version, status, rationale, proposed_changes, generated_by, created_at)
     values ($1, $2, $3, $4, 'Auth is blocking the dashboard', $5, 'rules', now() + ($6 || ' seconds')::interval)`,
    [suggestionId, s.project, basedOn, status, JSON.stringify(changes), r],
  );
  return suggestionId;
}

describe("GET /projects/:projectId/replans", () => {
  it("lists suggestions newest first, optionally filtered by status", async () => {
    const s = await seedProject();
    const older = await addSuggestion(s, []);
    const rejected = await addSuggestion(s, [], "superseded");
    const newer = await addSuggestion(s, []);

    const all = await call("GET", `/projects/${s.project}/replans`);
    expect(all.status).toBe(200);
    expect(all.body.map((x: any) => x.suggestion_id)).toEqual([newer, rejected, older]);

    const proposed = await call("GET", `/projects/${s.project}/replans?status=proposed`);
    expect(proposed.body.map((x: any) => x.suggestion_id)).toEqual([newer, older]);
    expect(proposed.body[0].proposed_changes).toEqual([]);
  });

  it("rejects an unknown status and an unknown project", async () => {
    const s = await seedProject();
    expect((await call("GET", `/projects/${s.project}/replans?status=maybe`)).status).toBe(400);
    expect((await call("GET", `/projects/proj_missing/replans`)).status).toBe(404);
  });
});
