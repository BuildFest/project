import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type pg from "pg";
import { requireEnv } from "../config.js";
import { withTransaction, type Db } from "../db.js";
import { newId } from "../ids.js";
import { applyToBranchState } from "../ingestion/branches.js";
import {
  normalizePullRequest,
  normalizePush,
  type NormalizedEvent,
  type PullRequestPayload,
  type PushPayload,
} from "../ingestion/normalize.js";
import { verifyGitHubSignature } from "../ingestion/verify.js";
import { notFound, parseBody } from "./http.js";
import { ConnectRepositoryInput } from "./inputs.js";

// One webhook secret for every connected repo (hackathon scale: one repo).
// The column records where the secret lives, never the secret itself.
const WEBHOOK_SECRET_ENV = "GITHUB_WEBHOOK_SECRET";

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  owner: { login: string };
}

async function fetchGitHubRepo(fullName: string): Promise<GitHubRepo> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "pitcrew",
    "x-github-api-version": "2022-11-28",
  };
  // Optional for public repos, required for private ones.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  } catch {
    throw new HTTPException(502, { message: "could not reach GitHub" });
  }
  if (res.status === 404) {
    throw new HTTPException(400, { message: "GitHub repository not found, or GITHUB_TOKEN can't see it" });
  }
  if (!res.ok) throw new HTTPException(502, { message: `GitHub returned ${res.status}` });
  return (await res.json()) as GitHubRepo;
}

interface Delivery {
  deliveryId: string;
  githubEvent: string;
  payload: any; // signed by GitHub, shape depends on githubEvent
  payloadJson: string;
  repos: { repository_id: string; project_id: string }[];
  receivedAt: string;
}

type IngestResult = { duplicate: true } | { duplicate: false; status: "normalized" | "ignored"; inserted: number };

function normalize(githubEvent: string, payload: any, receivedAt: string): NormalizedEvent[] {
  if (githubEvent === "push") return normalizePush(payload as PushPayload, receivedAt);
  if (githubEvent === "pull_request") {
    const event = normalizePullRequest(payload as PullRequestPayload);
    return event ? [event] : [];
  }
  return []; // ping, issues, etc.: stored, not normalized
}

async function ingestDelivery(tx: pg.PoolClient, d: Delivery): Promise<IngestResult> {
  // Dedup point. A delivery that failed earlier may be retried (GitHub's
  // "Redeliver" button); anything else already stored is a no-op.
  const claimed = await tx.query(
    `insert into webhook_deliveries (github_delivery_id, repository_id, github_event, action, payload, received_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (github_delivery_id) do update set status = 'received', error = null
       where webhook_deliveries.status = 'failed'
     returning 1`,
    [
      d.deliveryId,
      d.repos.length === 1 ? d.repos[0].repository_id : null,
      d.githubEvent,
      typeof d.payload?.action === "string" ? d.payload.action : null,
      d.payloadJson,
      d.receivedAt,
    ],
  );
  if (claimed.rowCount === 0) return { duplicate: true };

  const events = normalize(d.githubEvent, d.payload, d.receivedAt);
  let inserted = 0;

  // The same GitHub repo can be connected to more than one project; each gets
  // its own copy of the events.
  for (const repo of d.repos) {
    let latest: string | null = null;
    for (const event of events) {
      const { rowCount } = await tx.query(
        `insert into github_events (event_id, project_id, repository_id, source, github_delivery_id, external_event_id,
                                    event_type, actor, occurred_at, branch, commit, pull_request, changed_files)
         values ($1, $2, $3, 'webhook', $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (repository_id, event_type, external_event_id) do nothing`,
        [
          newId("event"), repo.project_id, repo.repository_id, d.deliveryId, event.external_event_id,
          event.event_type, event.actor, event.occurred_at, event.branch, event.commit, event.pull_request,
          event.changed_files,
        ],
      );
      if (!rowCount) continue; // already known (redelivery overlap or backfill)
      inserted++;
      if (!latest || event.occurred_at > latest) latest = event.occurred_at;
      await applyToBranchState(tx, repo.project_id, repo.repository_id, event);
    }

    // Any verified delivery proves the webhook is wired up.
    await tx.query(
      `update repositories
          set connection_status = 'connected',
              connected_at = coalesce(connected_at, now()),
              last_event_at = greatest(last_event_at, $2::timestamptz)
        where repository_id = $1`,
      [repo.repository_id, latest],
    );
  }

  const status = events.length > 0 ? "normalized" : "ignored";
  await tx.query(
    `update webhook_deliveries set status = $2, processed_at = now() where github_delivery_id = $1`,
    [d.deliveryId, status],
  );
  return { duplicate: false, status, inserted };
}

export function registerIngestionRoutes(app: Hono, db: Db) {
  app.post("/projects/:projectId/repositories", async (c) => {
    const input = await parseBody(c, ConnectRepositoryInput);
    const projectId = c.req.param("projectId");
    const secret = requireEnv(WEBHOOK_SECRET_ENV);

    // Check before calling GitHub; the FK still covers a concurrent delete.
    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");

    const gh = await fetchGitHubRepo(input.full_name);
    const repository = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `insert into repositories (repository_id, project_id, github_repository_id, owner, name, full_name,
                                   default_branch, webhook_secret_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [newId("repo"), projectId, gh.id, gh.owner.login, gh.name, gh.full_name, gh.default_branch, `env:${WEBHOOK_SECRET_ENV}`],
      );
      if (input.make_primary) {
        await tx.query("update projects set primary_repository_id = $2 where project_id = $1", [projectId, rows[0].repository_id]);
      }
      return rows[0];
    });

    const base = (process.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
    return c.json({ repository, webhook_url: `${base}/webhooks/github`, webhook_secret: secret }, 201);
  });

  app.get("/projects/:projectId/repositories", async (c) => {
    const projectId = c.req.param("projectId");
    const { rows } = await db.query("select * from repositories where project_id = $1 order by created_at", [projectId]);
    if (rows.length === 0) {
      const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
      if (!rowCount) notFound("project");
    }
    return c.json(rows);
  });

  app.post("/webhooks/github", async (c) => {
    // Raw bytes first: the signature covers them exactly, so no c.req.json().
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!verifyGitHubSignature(raw, c.req.header("x-hub-signature-256"), requireEnv(WEBHOOK_SECRET_ENV))) {
      throw new HTTPException(401, { message: "signature does not verify" });
    }

    const deliveryId = c.req.header("x-github-delivery");
    const githubEvent = c.req.header("x-github-event");
    if (!deliveryId || !githubEvent) {
      throw new HTTPException(400, { message: "missing X-GitHub-Delivery or X-GitHub-Event header" });
    }

    // GitHub's "application/x-www-form-urlencoded" content type wraps the JSON
    // in a `payload` form field; "application/json" sends it bare.
    let payloadJson = raw.toString("utf8");
    if (c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      payloadJson = new URLSearchParams(payloadJson).get("payload") ?? "";
    }
    let payload: any;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      throw new HTTPException(400, { message: "payload must be JSON" });
    }

    const githubRepoId = payload?.repository?.id;
    const { rows: repos } =
      typeof githubRepoId === "number"
        ? await db.query("select repository_id, project_id from repositories where github_repository_id = $1", [githubRepoId])
        : { rows: [] };
    if (repos.length === 0) notFound("repository");

    const delivery: Delivery = { deliveryId, githubEvent, payload, payloadJson, repos, receivedAt: new Date().toISOString() };
    let result: IngestResult;
    try {
      result = await withTransaction(db, (tx) => ingestDelivery(tx, delivery));
    } catch (err) {
      // The transaction rolled back; record the failure separately so it's
      // findable (webhook_deliveries_failed_idx) and retryable via redelivery.
      await db
        .query(
          `insert into webhook_deliveries (github_delivery_id, github_event, action, payload, status, error, received_at, processed_at)
           values ($1, $2, $3, $4::jsonb, 'failed', $5, $6, now())
           on conflict (github_delivery_id) do update set status = 'failed', error = excluded.error, processed_at = now()`,
          [deliveryId, githubEvent, payload?.action ?? null, payloadJson, String(err), delivery.receivedAt],
        )
        .catch((recordErr) => console.error("could not record failed delivery", deliveryId, recordErr));
      throw err;
    }

    if (result.duplicate) return c.json({ status: "duplicate" }, 200);
    return c.json({ status: result.status, events: result.inserted }, 202);
  });
}
