import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { normalizePullRequest, normalizePush } from "../src/ingestion/normalize.js";
import { verifyGitHubSignature } from "../src/ingestion/verify.js";
import { startTestDb } from "./db.js";

const SECRET = "test-webhook-secret";

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;

// Each connected repo gets its own GitHub id: the same id connected to two
// projects fans deliveries out to both, which would couple tests.
let nextGithubId = 1000;
const githubIds = new Map<string, number>();

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = "https://pitcrew.example";
  vi.stubGlobal("fetch", async (url: string) => {
    const fullName = url.replace("https://api.github.com/repos/", "");
    const id = githubIds.get(fullName);
    if (!id) return new Response("{}", { status: 404 });
    const [owner, name] = fullName.split("/");
    return Response.json({ id, name, full_name: fullName, default_branch: "main", owner: { login: owner } });
  });
  db = await startTestDb();
  app = createApp(db.pool);
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

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function sendWebhook(event: string, payload: unknown, opts: { deliveryId?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const deliveryId = opts.deliveryId ?? randomUUID();
  const res = await app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": sign(body, opts.secret),
    },
    body,
  });
  return { status: res.status, body: await res.json(), deliveryId };
}

/** Creates a project and connects a fresh fake GitHub repo to it. */
async function connectedRepo() {
  const project = (await call("POST", "/projects", { name: "Hook test", task_key_prefix: "HK" })).body;
  const fullName = `buildfest/repo-${nextGithubId}`;
  const githubId = nextGithubId++;
  githubIds.set(fullName, githubId);
  const res = await call("POST", `/projects/${project.project.project_id}/repositories`, { full_name: fullName });
  expect(res.status).toBe(201);
  return { projectId: project.project.project_id as string, repositoryId: res.body.repository.repository_id as string, githubId };
}

const ZERO = "0".repeat(40);
const sha = (n: number) => n.toString(16).padStart(40, "a");

function pushPayload(githubId: number, opts: { branch?: string; before?: string; after?: string; created?: boolean; deleted?: boolean; commits?: object[] }) {
  const commits = opts.commits ?? [];
  return {
    ref: `refs/heads/${opts.branch ?? "feature/auth"}`,
    before: opts.before ?? ZERO,
    after: opts.after ?? ZERO,
    created: opts.created ?? false,
    deleted: opts.deleted ?? false,
    commits,
    head_commit: commits.at(-1) ?? null,
    sender: { login: "pranshul" },
    repository: { id: githubId, pushed_at: 1_790_000_000 },
  };
}

function commit(n: number, files: string[], timestamp = "2026-09-26T12:00:00Z") {
  return {
    id: sha(n), message: `commit ${n}`, timestamp, url: `https://github.com/c/${n}`,
    author: { name: "Pranshul", username: "pranshul" }, added: files, removed: [], modified: [],
  };
}

function prPayload(githubId: number, action: string, opts: { number?: number; merged?: boolean; branch?: string } = {}) {
  return {
    action,
    number: opts.number ?? 7,
    pull_request: {
      number: opts.number ?? 7, title: "Add auth", state: action === "closed" ? "closed" : "open",
      merged: opts.merged ?? false, html_url: "https://github.com/pr/7",
      created_at: "2026-09-26T12:05:00Z", updated_at: "2026-09-26T12:10:00Z",
      closed_at: action === "closed" ? "2026-09-26T12:20:00Z" : null,
      merged_at: opts.merged ? "2026-09-26T12:20:00Z" : null,
      head: { ref: opts.branch ?? "feature/auth", sha: sha(99) }, base: { ref: "main" },
    },
    sender: { login: "pranshul" },
    repository: { id: githubId },
  };
}

async function branchState(repositoryId: string, branch = "feature/auth") {
  const { rows } = await db.pool.query("select * from branch_states where repository_id = $1 and branch = $2", [repositoryId, branch]);
  return rows[0];
}

async function eventCount(repositoryId: string) {
  const { rows } = await db.pool.query("select count(*)::int as n from github_events where repository_id = $1", [repositoryId]);
  return rows[0].n as number;
}

// ---------------------------------------------------------------------------

describe("verifyGitHubSignature", () => {
  // Test vector from GitHub's "Validating webhook deliveries" docs.
  const body = Buffer.from("Hello, World!");
  const secret = "It's a Secret to Everybody";
  const good = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("accepts GitHub's published example", () => {
    expect(verifyGitHubSignature(body, good, secret)).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, and a missing header", () => {
    expect(verifyGitHubSignature(body, good, "wrong")).toBe(false);
    expect(verifyGitHubSignature(Buffer.from("Hello, World?"), good, secret)).toBe(false);
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
    expect(verifyGitHubSignature(body, "sha1=abc", secret)).toBe(false);
  });
});

describe("normalize", () => {
  const received = "2026-09-26T13:00:00.000Z";

  it("turns a branch-creating push into branch_created, push and commit events", () => {
    const events = normalizePush(
      pushPayload(1, { created: true, after: sha(2), commits: [commit(1, ["a.ts"]), commit(2, ["b.ts", "a.ts"])] }),
      received,
    );
    expect(events.map((e) => e.event_type)).toEqual(["branch_created", "push", "commit", "commit"]);
    expect(events[1]).toMatchObject({ external_event_id: `refs/heads/feature/auth:${sha(2)}`, changed_files: ["a.ts", "b.ts"] });
    expect(events[2]).toMatchObject({ external_event_id: sha(1), branch: "feature/auth" });
  });

  it("turns a delete push into branch_deleted only, and ignores tags", () => {
    expect(normalizePush(pushPayload(1, { deleted: true, before: sha(3) }), received).map((e) => e.event_type)).toEqual(["branch_deleted"]);
    expect(normalizePush({ ...pushPayload(1, {}), ref: "refs/tags/v1" }, received)).toEqual([]);
  });

  it("splits closed PRs into merged vs closed and ignores other actions", () => {
    expect(normalizePullRequest(prPayload(1, "closed", { merged: true }))?.event_type).toBe("pull_request_merged");
    expect(normalizePullRequest(prPayload(1, "closed"))?.event_type).toBe("pull_request_closed");
    expect(normalizePullRequest(prPayload(1, "labeled"))).toBeNull();
  });
});

describe("repositories", () => {
  it("connects a repo, returns the webhook setup, and lists it", async () => {
    const project = (await call("POST", "/projects", { name: "Connect", task_key_prefix: "CN" })).body;
    const pid = project.project.project_id;
    githubIds.set("BuildFest/project", 42);

    const res = await call("POST", `/projects/${pid}/repositories`, { full_name: "https://github.com/BuildFest/project.git" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      repository: { full_name: "BuildFest/project", github_repository_id: "42", connection_status: "pending" },
      webhook_url: "https://pitcrew.example/webhooks/github",
      webhook_secret: SECRET,
    });

    const list = await call("GET", `/projects/${pid}/repositories`);
    expect(list.body).toHaveLength(1);
    expect((await call("GET", `/projects/${pid}`)).body.project.primary_repository_id).toBe(res.body.repository.repository_id);

    expect((await call("POST", `/projects/${pid}/repositories`, { full_name: "BuildFest/project" })).status).toBe(409);
  });

  it("returns 400 for a repo GitHub doesn't know and 404 for an unknown project", async () => {
    const project = (await call("POST", "/projects", { name: "Missing", task_key_prefix: "MS" })).body;
    expect((await call("POST", `/projects/${project.project.project_id}/repositories`, { full_name: "nobody/nothing" })).status).toBe(400);
    expect((await call("POST", "/projects/proj_nope/repositories", { full_name: "BuildFest/project" })).status).toBe(404);
    expect((await call("GET", "/projects/proj_nope/repositories")).status).toBe(404);
  });
});

describe("POST /webhooks/github", () => {
  it("rejects a bad signature and an unknown repository", async () => {
    const { githubId } = await connectedRepo();
    expect((await sendWebhook("ping", { repository: { id: githubId } }, { secret: "wrong" })).status).toBe(401);
    expect((await sendWebhook("ping", { repository: { id: 999_999 } })).status).toBe(404);
  });

  it("marks the repo connected on the first delivery (GitHub's ping)", async () => {
    const { githubId, projectId } = await connectedRepo();
    const res = await sendWebhook("ping", { zen: "Keep it logically awesome.", repository: { id: githubId } });
    expect(res).toMatchObject({ status: 202, body: { status: "ignored", events: 0 } });
    const repo = (await call("GET", `/projects/${projectId}/repositories`)).body[0];
    expect(repo.connection_status).toBe("connected");
    expect(repo.connected_at).not.toBeNull();
  });

  it("stores a push, updates the branch, and dedupes redeliveries", async () => {
    const { githubId, repositoryId } = await connectedRepo();
    const payload = pushPayload(githubId, { created: true, after: sha(2), commits: [commit(1, ["a.ts"]), commit(2, ["b.ts"])] });

    const first = await sendWebhook("push", payload);
    expect(first).toMatchObject({ status: 202, body: { status: "normalized", events: 4 } });
    expect(await eventCount(repositoryId)).toBe(4);
    expect(await branchState(repositoryId)).toMatchObject({ status: "active", head_sha: sha(2), open_pr_number: null });

    // Same delivery ID (GitHub retry): no-op.
    expect(await sendWebhook("push", payload, { deliveryId: first.deliveryId })).toMatchObject({ status: 200, body: { status: "duplicate" } });
    // New delivery ID, same facts: stored delivery, zero new events.
    expect((await sendWebhook("push", payload)).body).toMatchObject({ status: "normalized", events: 0 });
    expect(await eventCount(repositoryId)).toBe(4);
  });

  it("tracks a PR from opened to merged on the head branch", async () => {
    const { githubId, repositoryId } = await connectedRepo();
    await sendWebhook("push", pushPayload(githubId, { created: true, after: sha(2), commits: [commit(2, ["a.ts"])] }));

    await sendWebhook("pull_request", prPayload(githubId, "opened"));
    expect(await branchState(repositoryId)).toMatchObject({ status: "active", open_pr_number: 7 });

    await sendWebhook("pull_request", prPayload(githubId, "closed", { merged: true }));
    expect(await branchState(repositoryId)).toMatchObject({ status: "merged", open_pr_number: null });
  });

  it("marks a deleted branch as deleted", async () => {
    const { githubId, repositoryId } = await connectedRepo();
    await sendWebhook("push", pushPayload(githubId, { branch: "spike", created: true, after: sha(5), commits: [commit(5, ["x.ts"])] }));
    await sendWebhook("push", pushPayload(githubId, { branch: "spike", deleted: true, before: sha(5) }));
    expect((await branchState(repositoryId, "spike")).status).toBe("deleted");
  });

  it("records a failed delivery and lets GitHub's redelivery retry it", async () => {
    const { githubId, repositoryId } = await connectedRepo();
    const bad = pushPayload(githubId, { after: sha(8), commits: [commit(8, ["a.ts"], "not a timestamp")] });

    const failed = await sendWebhook("push", bad);
    expect(failed.status).toBe(400); // unparseable timestamp, via pgErrorToHttp
    const { rows } = await db.pool.query("select status, error from webhook_deliveries where github_delivery_id = $1", [failed.deliveryId]);
    expect(rows[0].status).toBe("failed");
    expect(await eventCount(repositoryId)).toBe(0);

    const good = pushPayload(githubId, { after: sha(8), commits: [commit(8, ["a.ts"])] });
    expect((await sendWebhook("push", good, { deliveryId: failed.deliveryId })).status).toBe(202);
    expect(await eventCount(repositoryId)).toBe(2);
  });
});

describe("GET /projects/:projectId/events", () => {
  async function seeded() {
    const repo = await connectedRepo();
    await sendWebhook("push", pushPayload(repo.githubId, {
      created: true, after: sha(3),
      commits: [commit(1, ["a.ts"], "2026-09-26T10:00:00Z"), commit(2, ["b.ts"], "2026-09-26T10:05:00Z"), commit(3, ["c.ts"], "2026-09-26T10:10:00Z")],
    }));
    await sendWebhook("push", pushPayload(repo.githubId, { branch: "other", created: true, after: sha(9), commits: [commit(9, ["z.ts"])] }));
    return repo;
  }

  it("browses newest first with a cursor that visits every event exactly once", async () => {
    const { projectId } = await seeded();
    const all = (await call("GET", `/projects/${projectId}/events?limit=200`)).body;
    expect(all.next_cursor).toBeNull();
    expect(all.items.length).toBe(8); // 5 on feature/auth, 3 on other
    const times = all.items.map((e: any) => e.occurred_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(typeof all.items[0].seq).toBe("number");

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = (await call("GET", `/projects/${projectId}/events?limit=3${cursor ? `&cursor=${cursor}` : ""}`)).body;
      seen.push(...page.items.map((e: any) => e.event_id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map((e: any) => e.event_id));
  });

  it("consumes by seq for analyzers (after_seq)", async () => {
    const { projectId } = await seeded();
    const first = (await call("GET", `/projects/${projectId}/events?after_seq=0&limit=5`)).body;
    expect(first.items).toHaveLength(5);
    expect(first.has_more).toBe(true);
    const seqs = first.items.map((e: any) => e.seq);
    expect([...seqs].sort((a: number, b: number) => a - b)).toEqual(seqs);
    expect(first.next_after_seq).toBe(seqs[4]);

    const rest = (await call("GET", `/projects/${projectId}/events?after_seq=${first.next_after_seq}`)).body;
    expect(rest).toMatchObject({ has_more: false });
    expect(rest.items).toHaveLength(3);
    const done = (await call("GET", `/projects/${projectId}/events?after_seq=${rest.next_after_seq}`)).body;
    expect(done).toEqual({ items: [], next_after_seq: rest.next_after_seq, has_more: false });
  });

  it("filters by branch and by task links that aren't rejected", async () => {
    const { projectId } = await seeded();
    const other = (await call("GET", `/projects/${projectId}/events?branch=other`)).body.items;
    expect(other.map((e: any) => e.branch)).toEqual(["other", "other", "other"]);

    const task = (await call("POST", `/projects/${projectId}/tasks`, { title: "Auth" })).body;
    const [linked, rejected] = (await call("GET", `/projects/${projectId}/events?branch=feature/auth`)).body.items;
    for (const [i, e, status] of [[1, linked, "confirmed"], [2, rejected, "rejected"]] as const) {
      await db.pool.query(
        `insert into event_task_links (link_id, project_id, event_id, task_id, method, confidence, status)
         values ($1, $2, $3, $4, 'task_key', 1, $5)`,
        [`link_${projectId}_${i}`, projectId, e.event_id, task.task_id, status],
      );
    }
    const byTask = (await call("GET", `/projects/${projectId}/events?task_id=${task.task_id}`)).body.items;
    expect(byTask.map((e: any) => e.event_id)).toEqual([linked.event_id]);
  });

  it("rejects mixing modes and unknown projects", async () => {
    const { projectId } = await seeded();
    expect((await call("GET", `/projects/${projectId}/events?after_seq=0&cursor=5`)).status).toBe(400);
    expect((await call("GET", `/projects/${projectId}/events?limit=zero`)).status).toBe(400);
    expect((await call("GET", "/projects/proj_nope/events")).status).toBe(404);
  });
});
