import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { savePlanVersion } from "../src/api/planVersions.js";
import { exportProject, importProject, parseExport } from "../src/backup.js";
import { withTransaction } from "../src/db.js";
import { startTestDb } from "./db.js";

const SECRET = "backup-secret";

// Two separate clusters: production-like source, empty "demo laptop" target.
let source: Awaited<ReturnType<typeof startTestDb>>;
let target: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;
let projectId: string;
let lines: string[];

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function sendWebhook(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-github-event": event, "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  expect(res.status).toBe(202);
}

/** Every row of a table for the project, as canonical JSON, sorted. */
async function snapshot(db: typeof source, table: string) {
  const where = table === "webhook_deliveries"
    ? "github_delivery_id in (select github_delivery_id from github_events where project_id = $1)"
    : "project_id = $1";
  const { rows } = await db.pool.query(`select to_jsonb(t)::text as j from ${table} t where ${where} order by 1`, [projectId]);
  return rows.map((r) => r.j);
}

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = "https://pitcrew.example";
  vi.stubGlobal("fetch", async () =>
    Response.json({ id: 4242, name: "demo", full_name: "acme/demo", default_branch: "main", owner: { login: "acme" } }));
  [source, target] = await Promise.all([startTestDb(), startTestDb()]);
  app = createApp(source.pool);

  // A project touching every kind of data, including the FK cycle
  // projects.current_plan_version -> plan_versions -> projects.
  const ws = (await call("POST", "/projects", {
    name: "Pit Crew", task_key_prefix: "PC", brief: "# Pit Crew",
    members: [{ display_name: "Pranshul", github_login: "Pranshul-13" }],
  })).body;
  projectId = ws.project.project_id;
  const a = (await call("POST", `/projects/${projectId}/tasks`, { title: "Schema" })).body;
  const b = (await call("POST", `/projects/${projectId}/tasks`, { title: "Ingestion" })).body;
  await call("POST", `/projects/${projectId}/dependencies`, { task_id: b.task_id, depends_on_task_id: a.task_id });
  await withTransaction(source.pool, (tx) =>
    savePlanVersion(tx, { projectId, version: 1, source: "initial", summary: "v1", createdBy: null }));
  await call("POST", `/projects/${projectId}/repositories`, { full_name: "acme/demo" });
  await sendWebhook("push", {
    ref: "refs/heads/PC-2-ingest", before: "0".repeat(40), after: "b".repeat(40), created: true, deleted: false,
    commits: [{ id: "b".repeat(40), message: "PC-2: \"quotes\" & ünïcode ✓", timestamp: "2026-09-21T10:00:00Z", url: "u",
      author: { name: "P", username: "Pranshul-13" }, added: ["a.ts"], removed: [], modified: [] }],
    head_commit: null, sender: { login: "Pranshul-13" }, repository: { id: 4242, pushed_at: 1_790_000_000 },
  });
  const { rows: [ev] } = await source.pool.query("select event_id from github_events where event_type = 'commit'");
  await source.pool.query(
    `insert into event_task_links (link_id, project_id, event_id, task_id, method, confidence, status)
     values ('link_1', $1, $2, $3, 'task_key', 1, 'confirmed')`,
    [projectId, ev.event_id, b.task_id],
  );

  lines = [];
  await exportProject(source.pool, projectId, (line) => { lines.push(line); });
}, 240_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([source?.stop(), target?.stop()]);
});

describe("export", () => {
  it("writes a header, every project table, the raw deliveries and a verifiable footer", () => {
    const { header, rows } = parseExport(lines);
    expect(header).toMatchObject({ format: "pitcrew-export", format_version: 1, project_id: projectId });
    expect(header.schema_version).toMatch(/^\d{14}_/);
    expect(header.tables).toMatchObject({
      projects: 1, project_members: 1, tasks: 2, task_dependencies: 1, plan_versions: 1,
      repositories: 1, webhook_deliveries: 1, github_events: 3, branch_states: 1, event_task_links: 1,
    });
    expect(rows[0].table).toBe("projects");
  });
});

describe("import", () => {
  it("restores every table exactly, keeping event seq numbers", async () => {
    const result = await importProject(target.pool, lines);
    expect(result).toMatchObject({ projectId, rows: lines.length - 2 });
    const { header } = parseExport(lines);
    for (const table of Object.keys(header.tables)) {
      expect(await snapshot(target, table), table).toEqual(await snapshot(source, table));
    }
  });

  it("continues seq after the restored events and serves the API from the restored data", async () => {
    const { rows: [{ max }] } = await target.pool.query("select max(seq)::int as max from github_events");
    const { rows: [{ seq }] } = await target.pool.query(
      `insert into github_events (event_id, project_id, repository_id, source, external_event_id, event_type, occurred_at)
       select 'event_new', project_id, repository_id, 'backfill', 'x', 'push', now() from repositories limit 1
       returning seq::int`,
    );
    expect(seq).toBeGreaterThan(max);

    const restored = createApp(target.pool);
    const ws = await (await restored.request(`/projects/${projectId}`)).json();
    expect(ws.project.current_plan_version).toBe(1);
    expect(ws.dependencies).toHaveLength(1);
  });

  it("refuses to restore over an existing project", async () => {
    await expect(importProject(target.pool, lines)).rejects.toThrow(/already exists/);
  });

  it("rejects corrupted and truncated files before touching the database", () => {
    const tampered = [...lines];
    tampered[1] = tampered[1].replace("Pit Crew", "Pit Krew");
    expect(() => parseExport(tampered)).toThrow(/sha256/);
    expect(() => parseExport(lines.slice(0, -1))).toThrow(/truncated|footer/);
    expect(() => parseExport(['{"kind":"header","format":"other"}', "{}"])).toThrow(/not a pitcrew export/);
  });
});
