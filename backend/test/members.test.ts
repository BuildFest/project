import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { startTestDb } from "./db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await startTestDb();
  app = createApp(db.pool);
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
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function createProject() {
  const ws = (await call("POST", "/projects", {
    name: "Pit Crew", task_key_prefix: "PC",
    members: [{ display_name: "Pranshul", github_login: "Pranshul-13" }],
  })).body;
  return { projectId: ws.project.project_id as string, ownerId: ws.members[0].member_id as string };
}

describe("members", () => {
  it("adds a member with defaults and shows them in the workspace", async () => {
    const { projectId } = await createProject();
    const res = await call("POST", `/projects/${projectId}/members`, { display_name: " Divij ", github_login: "divij404", role_label: "Backend B" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ display_name: "Divij", github_login: "divij404", role_label: "Backend B", access_level: "editor" });
    expect(res.body.member_id).toMatch(/^mem_/);
    const ws = (await call("GET", `/projects/${projectId}`)).body;
    expect(ws.members.map((m: any) => m.display_name)).toEqual(["Pranshul", "Divij"]);
  });

  it("rejects a GitHub login already used in the project, case-insensitively", async () => {
    const { projectId } = await createProject();
    const dup = await call("POST", `/projects/${projectId}/members`, { display_name: "Imposter", github_login: "pranshul-13" });
    expect(dup.status).toBe(409);
    // The same login in another project is fine.
    const other = await createProject();
    expect((await call("POST", `/projects/${other.projectId}/members`, { display_name: "X", github_login: "divij404" })).status).toBe(201);
  });

  it("updates fields, clears a login with an empty string, and 404s unknown ids", async () => {
    const { projectId, ownerId } = await createProject();
    const res = await call("PATCH", `/projects/${projectId}/members/${ownerId}`, { role_label: "Backend A", github_login: "" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role_label: "Backend A", github_login: null, access_level: "owner" });
    expect((await call("PATCH", `/projects/${projectId}/members/mem_nope`, { role_label: "x" })).status).toBe(404);
    expect((await call("PATCH", `/projects/${projectId}/members/${ownerId}`, {})).status).toBe(400);
    expect((await call("POST", "/projects/proj_nope/members", { display_name: "X" })).status).toBe(404);
  });
});

describe("POST /projects/:projectId/plan-versions", () => {
  it("saves v1 as initial, then manual versions, with a snapshot and a timeline entry", async () => {
    const { projectId, ownerId } = await createProject();
    const task = (await call("POST", `/projects/${projectId}/tasks`, { title: "Webhook ingestion" })).body;

    const v1 = await call("POST", `/projects/${projectId}/plan-versions`, { summary: "Initial plan", member_id: ownerId });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ project_id: projectId, version: 1, source: "initial", summary: "Initial plan" });

    await call("PATCH", `/projects/${projectId}/tasks/${task.task_id}`, { title: "Webhook ingestion + backfill" });
    const v2 = await call("POST", `/projects/${projectId}/plan-versions`, {});
    expect(v2.body).toMatchObject({ version: 2, source: "manual", summary: null });

    expect((await call("GET", `/projects/${projectId}`)).body.project.current_plan_version).toBe(2);
    const { rows } = await db.pool.query(
      "select version, snapshot from plan_versions where project_id = $1 order by version",
      [projectId],
    );
    expect(rows.map((r) => r.snapshot.tasks[0].title)).toEqual(["Webhook ingestion", "Webhook ingestion + backfill"]);

    const { rows: items } = await db.pool.query(
      "select kind, title, actor, entity_id from timeline_items where project_id = $1 order by occurred_at, item_id",
      [projectId],
    );
    expect(items).toEqual([
      { kind: "plan_change", title: "Plan v1 saved", actor: ownerId, entity_id: `${projectId}:1` },
      { kind: "plan_change", title: "Plan v2 saved", actor: null, entity_id: `${projectId}:2` },
    ]);
  });

  it("gives concurrent saves distinct version numbers", async () => {
    const { projectId } = await createProject();
    const results = await Promise.all([1, 2, 3].map(() => call("POST", `/projects/${projectId}/plan-versions`, {})));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(results.map((r) => r.body.version).sort()).toEqual([1, 2, 3]);
  });

  it("rejects a member from elsewhere and unknown projects", async () => {
    const { projectId } = await createProject();
    const other = await createProject();
    expect((await call("POST", `/projects/${projectId}/plan-versions`, { member_id: other.ownerId })).status).toBe(400);
    expect((await call("POST", "/projects/proj_nope/plan-versions", {})).status).toBe(404);
  });
});
