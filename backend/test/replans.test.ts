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

describe("POST .../replans/:suggestionId/accept", () => {
  it("applies every change, saves plan v2 and supersedes other proposals", async () => {
    const s = await seedProject();
    const other = await addSuggestion(s, []);
    const id = await addSuggestion(s, [
      { op: "update_task", task_id: s.auth, changes: { priority: "critical" } },
      { op: "update_task", task_id: s.stats, changes: { plan_status: "cancelled" } },
      { op: "create_task", task: { title: "Mock auth for dashboard", scope: "optional" } },
      { op: "remove_dependency", task_id: s.dash, depends_on_task_id: s.auth },
      { op: "add_dependency", task_id: s.stats, depends_on_task_id: s.dash },
      { op: "update_milestone", milestone_id: s.milestone, changes: { target_at: "2026-09-28T12:00:00Z" } },
    ]);

    const res = await call("POST", `/projects/${s.project}/replans/${id}/accept`, { member_id: s.member });
    expect(res.status).toBe(200);
    expect(res.body.plan_version).toBe(2);
    expect(res.body.suggestion).toMatchObject({ suggestion_id: id, status: "accepted", reviewed_by: s.member });

    const tasks = await pool.query(
      "select task_key, title, priority, plan_status, scope, created_in_plan_version, updated_in_plan_version from tasks where project_id = $1 order by task_key",
      [s.project],
    );
    expect(tasks.rows).toEqual([
      { task_key: "PC-1", title: "Authentication API", priority: "critical", plan_status: "not_started", scope: "must_have", created_in_plan_version: null, updated_in_plan_version: 2 },
      { task_key: "PC-2", title: "Dashboard", priority: "medium", plan_status: "not_started", scope: "must_have", created_in_plan_version: null, updated_in_plan_version: null },
      { task_key: "PC-3", title: "Analytics", priority: "low", plan_status: "cancelled", scope: "optional", created_in_plan_version: null, updated_in_plan_version: 2 },
      { task_key: "PC-4", title: "Mock auth for dashboard", priority: "medium", plan_status: "not_started", scope: "optional", created_in_plan_version: 2, updated_in_plan_version: null },
    ]);
    const deps = await pool.query("select task_id, depends_on_task_id from task_dependencies where project_id = $1", [s.project]);
    expect(deps.rows).toEqual([{ task_id: s.stats, depends_on_task_id: s.dash }]);
    const ms = await pool.query("select target_at from milestones where milestone_id = $1", [s.milestone]);
    expect(ms.rows[0].target_at.toISOString()).toBe("2026-09-28T12:00:00.000Z");

    const project = await pool.query("select current_plan_version from projects where project_id = $1", [s.project]);
    expect(project.rows[0].current_plan_version).toBe(2);
    const version = await pool.query(
      "select source, suggestion_id, created_by, snapshot from plan_versions where project_id = $1 and version = 2",
      [s.project],
    );
    expect(version.rows[0]).toMatchObject({ source: "replan_accepted", suggestion_id: id, created_by: s.member });
    expect(version.rows[0].snapshot.tasks).toHaveLength(4);
    expect(version.rows[0].snapshot.dependencies).toHaveLength(1);

    const otherRow = await pool.query("select status from replan_suggestions where suggestion_id = $1", [other]);
    expect(otherRow.rows[0].status).toBe("superseded");
    expect((await timeline(s)).map((t) => [t.kind, t.title])).toEqual([
      ["plan_change", "Plan v2 saved from an accepted replan"],
      ["replan_reviewed", "Replan accepted"],
    ]);
  });

  it("refuses a suggestion made against an older plan version", async () => {
    const s = await seedProject();
    await pool.query(
      `insert into plan_versions (project_id, version, source, snapshot) values ($1, 2, 'manual', '{}')`,
      [s.project],
    );
    await pool.query(`update projects set current_plan_version = 2 where project_id = $1`, [s.project]);
    const id = await addSuggestion(s, [{ op: "update_task", task_id: s.auth, changes: { priority: "critical" } }]);

    const res = await call("POST", `/projects/${s.project}/replans/${id}/accept`, { member_id: s.member });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("v1 -> v2");
    const task = await pool.query("select priority from tasks where task_id = $1", [s.auth]);
    expect(task.rows[0].priority).toBe("high");
  });

  it("serializes concurrent accepts without deadlocking", async () => {
    const s = await seedProject();
    const first = await addSuggestion(s, [
      { op: "update_task", task_id: s.auth, changes: { priority: "critical" } },
    ]);
    const second = await addSuggestion(s, [
      { op: "update_task", task_id: s.auth, changes: { priority: "low" } },
    ]);

    const responses = await Promise.all([
      call("POST", `/projects/${s.project}/replans/${first}/accept`, { member_id: s.member }),
      call("POST", `/projects/${s.project}/replans/${second}/accept`, { member_id: s.member }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const suggestions = await pool.query(
      "select status from replan_suggestions where suggestion_id = any($1) order by status",
      [[first, second]],
    );
    expect(suggestions.rows.map((row) => row.status)).toEqual(["accepted", "superseded"]);
  });

  it("rolls back every change when one of them fails", async () => {
    const s = await seedProject();
    const id = await addSuggestion(s, [
      { op: "update_task", task_id: s.auth, changes: { priority: "critical" } },
      // auth -> dash closes a cycle, because dash already requires auth.
      { op: "add_dependency", task_id: s.auth, depends_on_task_id: s.dash },
    ]);

    const res = await call("POST", `/projects/${s.project}/replans/${id}/accept`, { member_id: s.member });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("cycle");

    const task = await pool.query("select priority from tasks where task_id = $1", [s.auth]);
    expect(task.rows[0].priority).toBe("high");
    const suggestion = await pool.query("select status from replan_suggestions where suggestion_id = $1", [id]);
    expect(suggestion.rows[0].status).toBe("proposed");
    const versions = await pool.query("select count(*)::int as n from plan_versions where project_id = $1", [s.project]);
    expect(versions.rows[0].n).toBe(1);
  });

  it("returns 409 for changes that no longer fit the plan", async () => {
    const s = await seedProject();
    const missingDep = await addSuggestion(s, [
      { op: "remove_dependency", task_id: s.stats, depends_on_task_id: s.auth },
    ]);
    const res = await call("POST", `/projects/${s.project}/replans/${missingDep}/accept`, { member_id: s.member });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no longer exists");

    const malformed = await addSuggestion(s, [{ op: "delete_everything" }]);
    const bad = await call("POST", `/projects/${s.project}/replans/${malformed}/accept`, { member_id: s.member });
    expect(bad.status).toBe(409);
  });
});

async function timeline(s: Seed) {
  const { rows } = await pool.query(
    "select kind, title, actor, entity_id from timeline_items where project_id = $1 order by kind",
    [s.project],
  );
  return rows;
}

describe("POST .../replans/:suggestionId/reject", () => {
  it("rejects a proposed suggestion and records who did it", async () => {
    const s = await seedProject();
    const id = await addSuggestion(s, [{ op: "update_task", task_id: s.auth, changes: { priority: "critical" } }]);

    const res = await call("POST", `/projects/${s.project}/replans/${id}/reject`, { member_id: s.member });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ suggestion_id: id, status: "rejected", reviewed_by: s.member });
    expect(res.body.reviewed_at).toEqual(expect.any(String));
    expect(await timeline(s)).toEqual([
      { kind: "replan_reviewed", title: "Replan rejected", actor: s.member, entity_id: id },
    ]);
    const { rows } = await pool.query("select priority from tasks where task_id = $1", [s.auth]);
    expect(rows[0].priority).toBe("high");
  });

  it("refuses to review twice, and checks the member and suggestion exist", async () => {
    const s = await seedProject();
    const id = await addSuggestion(s, []);
    const path = `/projects/${s.project}/replans/${id}/reject`;

    expect((await call("POST", path, { member_id: "mem_stranger" })).status).toBe(400);
    expect((await call("POST", path, {})).status).toBe(400);
    expect((await call("POST", path, { member_id: s.member })).status).toBe(200);
    const again = await call("POST", path, { member_id: s.member });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("rejected");
    expect((await call("POST", `/projects/${s.project}/replans/rp_missing/reject`, { member_id: s.member })).status).toBe(
      404,
    );
  });
});
