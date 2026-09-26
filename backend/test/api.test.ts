import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";

const SCHEMA = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");

let postgres: EmbeddedPostgres;
let pool: pg.Pool;
let dataDir: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "pitcrew-pg-"));
  const port = 50000 + Math.floor(Math.random() * 10000);
  postgres = new EmbeddedPostgres({
    databaseDir: dataDir, port, user: "postgres", password: "test", persistent: false, onLog: () => {},
  });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase("pitcrew_test");
  pool = new pg.Pool({ connectionString: `postgres://postgres:test@localhost:${port}/pitcrew_test` });
  await pool.query(SCHEMA);
  app = createApp(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await postgres?.stop();
  rmSync(dataDir, { recursive: true, force: true });
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

async function createProject(prefix = "pc") {
  const res = await call("POST", "/projects", {
    name: "Pit Crew",
    task_key_prefix: prefix,
    deadline_at: "2026-10-04",
    members: [
      { display_name: "Pranshul", github_login: "Pranshul-13" },
      { display_name: "Divij", github_login: "divij404" },
    ],
    brief: "Compare the plan with what the repo is doing.",
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("projects", () => {
  it("creates a full workspace matching the frontend shape", async () => {
    const ws = await createProject();
    expect(ws.project.project_id).toMatch(/^proj_[0-9A-Z]{26}$/);
    expect(ws.project.task_key_prefix).toBe("PC");
    expect(ws.project.created_by).toBe(ws.members[0].member_id);
    expect(ws.members.map((m: any) => m.access_level)).toEqual(["owner", "editor"]);
    expect(ws.brief.content).toContain("Compare the plan");
    expect(ws).toMatchObject({ milestones: [], tasks: [], dependencies: [] });
  });

  it("lists and fetches projects", async () => {
    const ws = await createProject();
    const list = await call("GET", "/projects");
    expect(list.body.map((w: any) => w.project.project_id)).toContain(ws.project.project_id);
    expect((await call("GET", `/projects/${ws.project.project_id}`)).body.project.name).toBe("Pit Crew");
    expect((await call("GET", "/projects/proj_nope")).status).toBe(404);
  });

  it("rejects bad input with 400", async () => {
    expect((await call("POST", "/projects", { name: "", task_key_prefix: "PC" })).status).toBe(400);
    expect((await call("POST", "/projects", { name: "x", task_key_prefix: "1PC" })).status).toBe(400);
    const res = await app.request("/projects", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("updates the brief", async () => {
    const ws = await createProject();
    const res = await call("PUT", `/projects/${ws.project.project_id}/brief`, { content: "v2" });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("v2");
  });
});

describe("tasks and milestones", () => {
  it("allocates sequential task keys per project", async () => {
    const a = await createProject("PC");
    const b = await createProject("OT");
    const t1 = await call("POST", `/projects/${a.project.project_id}/tasks`, { title: "Database Setup" });
    const t2 = await call("POST", `/projects/${a.project.project_id}/tasks`, { title: "Authentication API", priority: "critical" });
    const t3 = await call("POST", `/projects/${b.project.project_id}/tasks`, { title: "Other" });
    expect([t1.body.task_key, t2.body.task_key, t3.body.task_key]).toEqual(["PC-1", "PC-2", "OT-1"]);
    expect(t2.body).toMatchObject({ priority: "critical", scope: "must_have", plan_status: "not_started" });
  });

  it("creates a milestone and assigns a task to it", async () => {
    const ws = await createProject();
    const pid = ws.project.project_id;
    const ms = await call("POST", `/projects/${pid}/milestones`, { name: "Demo", target_at: "2026-10-04T17:00:00Z" });
    expect(ms.status).toBe(201);
    const task = await call("POST", `/projects/${pid}/tasks`, { title: "Auth", owner_member_id: ws.members[0].member_id });
    const patched = await call("PATCH", `/projects/${pid}/tasks/${task.body.task_id}`, {
      milestone_id: ms.body.milestone_id,
      plan_status: "in_progress",
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ milestone_id: ms.body.milestone_id, plan_status: "in_progress" });

    const full = await call("GET", `/projects/${pid}`);
    expect(full.body.milestones).toHaveLength(1);
    expect(full.body.tasks[0].task_key).toBe("PC-1");
  });

  it("rejects invalid enum values and empty patches with 400", async () => {
    const ws = await createProject();
    const pid = ws.project.project_id;
    expect((await call("POST", `/projects/${pid}/tasks`, { title: "x", priority: "urgent" })).status).toBe(400);
    const task = await call("POST", `/projects/${pid}/tasks`, { title: "x" });
    expect((await call("PATCH", `/projects/${pid}/tasks/${task.body.task_id}`, {})).status).toBe(400);
    expect((await call("PATCH", `/projects/${pid}/tasks/task_nope`, { title: "y" })).status).toBe(404);
  });

  it("does not burn a task number when the insert fails", async () => {
    const ws = await createProject();
    const pid = ws.project.project_id;
    const bad = await call("POST", `/projects/${pid}/tasks`, { title: "x", owner_member_id: "mem_not_in_project" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const ok = await call("POST", `/projects/${pid}/tasks`, { title: "y" });
    expect(ok.body.task_key).toBe("PC-1");
  });
});

describe("dependencies", () => {
  it("creates, lists and deletes a dependency", async () => {
    const ws = await createProject();
    const pid = ws.project.project_id;
    const auth = (await call("POST", `/projects/${pid}/tasks`, { title: "Auth" })).body;
    const dash = (await call("POST", `/projects/${pid}/tasks`, { title: "Dashboard" })).body;

    const dep = await call("POST", `/projects/${pid}/dependencies`, { task_id: dash.task_id, depends_on_task_id: auth.task_id });
    expect(dep.status).toBe(201);
    expect((await call("GET", `/projects/${pid}`)).body.dependencies).toHaveLength(1);

    const del = await call("DELETE", `/projects/${pid}/dependencies/${dash.task_id}/${auth.task_id}`);
    expect(del.status).toBe(204);
    expect((await call("DELETE", `/projects/${pid}/dependencies/${dash.task_id}/${auth.task_id}`)).status).toBe(404);
  });
});

// These rely on pgErrorToHttp() in src/api/errors.ts mapping database errors.
describe("database rule errors", () => {
  it("returns 409 for a duplicate dependency", async () => {
    const ws = await createProject();
    const pid = ws.project.project_id;
    const a = (await call("POST", `/projects/${pid}/tasks`, { title: "A" })).body;
    const b = (await call("POST", `/projects/${pid}/tasks`, { title: "B" })).body;
    await call("POST", `/projects/${pid}/dependencies`, { task_id: a.task_id, depends_on_task_id: b.task_id });
    const dup = await call("POST", `/projects/${pid}/dependencies`, { task_id: a.task_id, depends_on_task_id: b.task_id });
    expect(dup.status).toBe(409);
  });

  it("returns 400 when referencing another project's task", async () => {
    const p1 = await createProject();
    const p2 = await createProject();
    const mine = (await call("POST", `/projects/${p1.project.project_id}/tasks`, { title: "Mine" })).body;
    const theirs = (await call("POST", `/projects/${p2.project.project_id}/tasks`, { title: "Theirs" })).body;
    const res = await call("POST", `/projects/${p1.project.project_id}/dependencies`, {
      task_id: mine.task_id,
      depends_on_task_id: theirs.task_id,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a task depending on itself", async () => {
    const ws = await createProject();
    const pid = ws.project.project_id;
    const a = (await call("POST", `/projects/${pid}/tasks`, { title: "A" })).body;
    const res = await call("POST", `/projects/${pid}/dependencies`, { task_id: a.task_id, depends_on_task_id: a.task_id });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unparseable timestamp", async () => {
    const res = await call("POST", "/projects", { name: "x", task_key_prefix: "PC", deadline_at: "next friday" });
    expect(res.status).toBe(400);
  });

  it("does not leak internals in error bodies", async () => {
    const res = await call("POST", "/projects", { name: "x", task_key_prefix: "PC", deadline_at: "next friday" });
    expect(JSON.stringify(res.body)).not.toMatch(/projects_|timestamptz|constraint/);
  });
});
