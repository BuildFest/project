import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireEnv } from "../config.js";
import { withTransaction, type Db } from "../db.js";
import { githubHeaders } from "../github.js";
import { newId } from "../ids.js";
import type { BranchRef } from "../ingestion/compare.js";
import { processDelivery, retryFailedDeliveries, type ProcessResult } from "../ingestion/deliveries.js";
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
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${fullName}`, { headers: githubHeaders() });
  } catch {
    throw new HTTPException(502, { message: "could not reach GitHub" });
  }
  if (res.status === 404) {
    throw new HTTPException(400, { message: "GitHub repository not found, or GITHUB_TOKEN can't see it" });
  }
  if (!res.ok) throw new HTTPException(502, { message: `GitHub returned ${res.status}` });
  return (await res.json()) as GitHubRepo;
}

export function registerIngestionRoutes(
  app: Hono,
  db: Db,
  onEventsIngested?: (projectIds: string[]) => void,
  onBranchesPushed?: (refs: BranchRef[]) => void,
) {
  // Follow-up work outside the ingest transaction: task linking, changed files.
  function afterDelivery(result: ProcessResult) {
    if (result.kind !== "processed") return;
    if (result.inserted > 0) onEventsIngested?.([...new Set(result.repos.map((repo) => repo.project_id))]);
    if (result.pushedBranches.length > 0) onBranchesPushed?.(result.pushedBranches);
  }

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

    // Tolerate PUBLIC_BASE_URL set as a bare host ("x.up.railway.app"): GitHub
    // rejects a payload URL without a scheme.
    let base = (process.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base)) base = `https://${base}`;
    return c.json({ repository, webhook_url: `${base}/webhooks/github`, webhook_secret: secret }, 201);
  });

  app.get("/projects/:projectId/repositories", async (c) => {
    const projectId = c.req.param("projectId");
    const { rows } = await db.query(
      `select r.*,
              (select max(d.received_at) from webhook_deliveries d
                where d.repository_id = r.repository_id) as last_delivery_at,
              (select count(*)::int from webhook_deliveries d
                where d.repository_id = r.repository_id and d.status = 'failed') as failed_deliveries
         from repositories r
        where r.project_id = $1
        order by r.created_at`,
      [projectId],
    );
    if (rows.length === 0) {
      const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
      if (!rowCount) notFound("project");
    }
    // One word for the UI badge: is GitHub activity actually reaching us?
    for (const r of rows) {
      r.ingestion_health =
        r.last_delivery_at === null ? "waiting"
        : r.failed_deliveries > 0 || r.backfill_status === "failed" || r.backfill_status === "partial" ? "degraded"
        : "live";
    }
    return c.json(rows);
  });

  // Re-runs this repository's stored failed deliveries (e.g. after a bug fix
  // is deployed), then does the same follow-up work as a live delivery.
  app.post("/projects/:projectId/repositories/:repositoryId/deliveries/retry", async (c) => {
    const { projectId, repositoryId } = c.req.param();
    const { rowCount } = await db.query("select 1 from repositories where project_id = $1 and repository_id = $2", [
      projectId,
      repositoryId,
    ]);
    if (!rowCount) notFound("repository");
    const { results, ...counts } = await retryFailedDeliveries(db, repositoryId);
    for (const result of results) afterDelivery(result);
    return c.json(counts);
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

    const result = await processDelivery(db, { deliveryId, githubEvent, payload, payloadJson, receivedAt: new Date().toISOString() });
    if (result.kind === "unknown_repository") notFound("repository");
    if (result.kind === "duplicate") return c.json({ status: "duplicate" }, 200);
    afterDelivery(result);
    return c.json({ status: result.status, events: result.inserted }, 202);
  });
}
