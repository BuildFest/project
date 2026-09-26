import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { startTestDb } from "./db.js";

const SECRET = "ops-secret";
const sha = (c: string) => c.repeat(40);

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;
const onEventsIngested = vi.fn();
const onBranchesPushed = vi.fn();
let nextGithubId = 9000;

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = "https://pitcrew.example";
  // Fake GitHub repo lookup: acme/demo-<id> has GitHub id <id>.
  vi.stubGlobal("fetch", async (url: string) => {
    const fullName = url.replace("https://api.github.com/repos/", "");
    const id = Number(fullName.split("-").pop());
    return Response.json({ id, name: fullName.split("/")[1], full_name: fullName, default_branch: "main", owner: { login: "acme" } });
  });
  db = await startTestDb();
  app = createApp(db.pool, onEventsIngested, onBranchesPushed);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
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

async function sendWebhook(event: string, payload: unknown, deliveryId = randomUUID()) {
  const body = JSON.stringify(payload);
  const res = await app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-github-event": event, "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  return { status: res.status, deliveryId };
}

async function setup() {
  const project = (await call("POST", "/projects", { name: "Ops", task_key_prefix: "PC" })).body;
  const projectId = project.project.project_id as string;
  const githubId = nextGithubId++;
  const repo = (await call("POST", `/projects/${projectId}/repositories`, { full_name: `acme/demo-${githubId}` })).body.repository;
  return { projectId, githubId, repositoryId: repo.repository_id as string };
}

/** A push whose commit timestamp Postgres can't parse: the delivery fails and is stored. */
function brokenPush(githubId: number, timestamp = "not a timestamp") {
  return {
    ref: "refs/heads/feat", before: "0".repeat(40), after: sha("a"), created: true, deleted: false,
    commits: [{ id: sha("a"), message: "work", timestamp, url: "u", author: { name: "P", username: "dev" }, added: [], removed: [], modified: [] }],
    head_commit: null, sender: { login: "dev" }, repository: { id: githubId, pushed_at: 1_790_000_000 },
  };
}

async function repository(projectId: string) {
  return (await call("GET", `/projects/${projectId}/repositories`)).body[0];
}

describe("ingestion health on GET /repositories", () => {
  it("goes waiting -> live -> degraded as deliveries arrive and fail", async () => {
    const { projectId, githubId } = await setup();
    expect(await repository(projectId)).toMatchObject({ ingestion_health: "waiting", last_delivery_at: null, failed_deliveries: 0 });

    await sendWebhook("ping", { zen: "hi", repository: { id: githubId } });
    const live = await repository(projectId);
    expect(live).toMatchObject({ ingestion_health: "live", failed_deliveries: 0 });
    expect(live.last_delivery_at).not.toBeNull();

    expect((await sendWebhook("push", brokenPush(githubId))).status).toBe(400);
    expect(await repository(projectId)).toMatchObject({ ingestion_health: "degraded", failed_deliveries: 1 });
  });

  it("attributes a failed delivery to its repository", async () => {
    const { githubId, repositoryId } = await setup();
    const { deliveryId } = await sendWebhook("push", brokenPush(githubId));
    const { rows } = await db.pool.query("select repository_id, status from webhook_deliveries where github_delivery_id = $1", [deliveryId]);
    expect(rows[0]).toEqual({ repository_id: repositoryId, status: "failed" });
  });
});

describe("POST .../repositories/:repositoryId/deliveries/retry", () => {
  it("re-runs failed deliveries once the cause is fixed, and fires the follow-up hooks", async () => {
    const { projectId, githubId, repositoryId } = await setup();
    const { deliveryId } = await sendWebhook("push", brokenPush(githubId));

    // Still broken: stays failed.
    const first = await call("POST", `/projects/${projectId}/repositories/${repositoryId}/deliveries/retry`);
    expect(first.body).toEqual({ retried: 1, succeeded: 0, still_failed: 1 });

    // "Deploy a fix": here, correct the stored payload the fix would have handled.
    await db.pool.query(
      `update webhook_deliveries
          set payload = jsonb_set(payload, '{commits,0,timestamp}', '"2026-09-21T10:00:00Z"')
        where github_delivery_id = $1`,
      [deliveryId],
    );
    onEventsIngested.mockClear();
    onBranchesPushed.mockClear();
    const second = await call("POST", `/projects/${projectId}/repositories/${repositoryId}/deliveries/retry`);
    expect(second.body).toEqual({ retried: 1, succeeded: 1, still_failed: 0 });

    const { rows } = await db.pool.query("select status, error from webhook_deliveries where github_delivery_id = $1", [deliveryId]);
    expect(rows[0]).toEqual({ status: "normalized", error: null });
    const events = (await call("GET", `/projects/${projectId}/events`)).body.items;
    expect(events.map((e: any) => e.event_type).sort()).toEqual(["branch_created", "commit", "push"]);
    expect(onEventsIngested).toHaveBeenCalledWith([projectId]);
    expect(onBranchesPushed).toHaveBeenCalledWith(expect.arrayContaining([{ repositoryId, branch: "feat" }]));
    expect(await repository(projectId)).toMatchObject({ failed_deliveries: 0 });

    // Nothing left to retry.
    const third = await call("POST", `/projects/${projectId}/repositories/${repositoryId}/deliveries/retry`);
    expect(third.body).toEqual({ retried: 0, succeeded: 0, still_failed: 0 });
  });

  it("only touches the repository asked for, and 404s for another project's repo", async () => {
    const a = await setup();
    const b = await setup();
    await sendWebhook("push", brokenPush(b.githubId));
    const res = await call("POST", `/projects/${a.projectId}/repositories/${a.repositoryId}/deliveries/retry`);
    expect(res.body).toEqual({ retried: 0, succeeded: 0, still_failed: 0 });
    expect((await call("POST", `/projects/${a.projectId}/repositories/${b.repositoryId}/deliveries/retry`)).status).toBe(404);
  });
});
