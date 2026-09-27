import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalysis } from "../../src/analysis/runner.js";
import { createApp } from "../../src/api/app.js";
import { startTestDb } from "../db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
const changed = vi.fn();
let app: ReturnType<typeof createApp>;
const configuredRouter = { available: () => true, run: async () => { throw new Error("not called"); } } as never;

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = "agent-status-secret";
  db = await startTestDb();
  app = createApp(db.pool, changed);
}, 120_000);

beforeEach(() => changed.mockClear());

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
  const workspace = (await call("POST", "/projects", {
    name: "Connected agent",
    task_key_prefix: "CA",
    brief: "Build a connected project planner.",
    members: [{ display_name: "Alex", github_login: "alex" }],
  })).body;
  changed.mockClear();
  return {
    projectId: workspace.project.project_id as string,
    memberId: workspace.members[0].member_id as string,
  };
}

describe("planning agent connectivity", () => {
  it("schedules relevant app changes with their real trigger", async () => {
    const { projectId, memberId } = await project();

    expect((await call("PUT", `/projects/${projectId}/brief`, {
      content: "Build a connected planner with a live status.",
      updated_by: memberId,
    })).status).toBe(200);
    expect(changed).toHaveBeenLastCalledWith([projectId], "brief");

    expect((await call("POST", `/projects/${projectId}/tasks`, { title: "Show agent health" })).status).toBe(201);
    expect(changed).toHaveBeenLastCalledWith([projectId], "plan");

    expect((await call("POST", `/projects/${projectId}/decisions`, {
      title: "Use automatic monitoring",
      member_id: memberId,
      related_task_ids: [],
    })).status).toBe(201);
    expect(changed).toHaveBeenLastCalledWith([projectId], "decision");
  });

  it("records successful no-op runs as fresh heartbeats", async () => {
    const { projectId } = await project();
    await runAnalysis(db.pool, configuredRouter, projectId, new Date(), { skipAi: true, trigger: "brief" });

    const first = (await call("GET", `/projects/${projectId}/state`)).body;
    expect(first.agent).toMatchObject({
      status: "healthy",
      last_trigger: "brief",
      last_mode: "rules",
      runs_count: 1,
      last_error: null,
    });
    expect(first.agent.last_completed_at).toEqual(expect.any(String));
    expect(first.agent.last_result).toEqual(expect.objectContaining({ aiApplied: false }));

    await runAnalysis(db.pool, configuredRouter, projectId, new Date(), { skipAi: true, trigger: "periodic" });
    const second = (await call("GET", `/projects/${projectId}/state`)).body;
    expect(second.agent).toMatchObject({ status: "healthy", last_trigger: "periodic", runs_count: 2 });
  });

  it("reports a rules fallback when no planning AI provider is configured", async () => {
    const { projectId } = await project();
    await runAnalysis(db.pool, null, projectId, new Date(), { skipAi: true, trigger: "startup" });

    const state = (await call("GET", `/projects/${projectId}/state`)).body;
    expect(state.agent).toMatchObject({
      status: "degraded",
      ai_available: false,
      last_trigger: "startup",
      last_error: "No AI provider is configured for planning jobs",
    });
  });
});
