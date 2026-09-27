import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { newId } from "../src/ids.js";
import { startTestDb } from "./db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = "ai-runs-secret";
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

async function project() {
  const ws = (await call("POST", "/projects", {
    name: "AI runs", task_key_prefix: "AR", members: [{ display_name: "Pranshul", github_login: "Pranshul-13" }],
  })).body;
  return ws.project.project_id as string;
}

// ai_runs is written directly by the router's audit logger (src/ai/audit.ts),
// never through the API, so tests seed it the same way.
async function seedRun(projectId: string, overrides: Partial<{
  job: string; status: "success" | "failed"; error: string | null; provider: string; createdAt: string;
}> = {}) {
  const runId = newId("airun");
  await db.pool.query(
    `insert into ai_runs (run_id, project_id, job, tier, provider, model, input_tokens, output_tokens,
                           duration_ms, cached, status, error, created_at)
     values ($1,$2,$3,'smart',$4,'PitCrewerTest',40,7,1200,false,$5,$6,coalesce($7::timestamptz, now()))`,
    [runId, projectId, overrides.job ?? "replan", overrides.provider ?? "foundry",
     overrides.status ?? "failed", overrides.error ?? "ModelError: 400", overrides.createdAt ?? null],
  );
  return runId;
}

describe("GET /projects/:projectId/ai-runs", () => {
  it("lists runs newest first and 404s an unknown project", async () => {
    const projectId = await project();
    const first = await seedRun(projectId, { createdAt: "2026-09-27T10:00:00Z" });
    const second = await seedRun(projectId, { createdAt: "2026-09-27T10:05:00Z" });

    const { status, body } = await call("GET", `/projects/${projectId}/ai-runs`);
    expect(status).toBe(200);
    expect(body.items.map((r: { run_id: string }) => r.run_id)).toEqual([second, first]);
    expect(body.items[0]).toMatchObject({ job: "replan", provider: "foundry", status: "failed", error: "ModelError: 400" });

    expect((await call("GET", "/projects/proj_nope/ai-runs")).status).toBe(404);
  });

  it("filters by status, so a failures-only view doesn't include successful runs", async () => {
    const projectId = await project();
    const failed = await seedRun(projectId, { status: "failed" });
    await seedRun(projectId, { status: "success", error: null });

    const { body } = await call("GET", `/projects/${projectId}/ai-runs?status=failed`);
    expect(body.items.map((r: { run_id: string }) => r.run_id)).toEqual([failed]);
  });

  it("pages with a cursor that visits every run once", async () => {
    const projectId = await project();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await seedRun(projectId, { createdAt: `2026-09-27T10:0${i}:00Z` }));
    const all = (await call("GET", `/projects/${projectId}/ai-runs?limit=200`)).body.items;
    expect(all).toHaveLength(4);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await call("GET", `/projects/${projectId}/ai-runs?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.body.items.map((r: { run_id: string }) => r.run_id));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all.map((r: { run_id: string }) => r.run_id));
  });

  it("keeps runs scoped to their own project", async () => {
    const a = await project();
    const b = await project();
    await seedRun(a);
    const { body } = await call("GET", `/projects/${b}/ai-runs`);
    expect(body.items).toEqual([]);
  });
});
