import { withTransaction, type Db } from "../db.js";
import { githubGet, githubList } from "../github.js";
import { changedFilesOf, storeChangedFiles, type CompareResponse } from "./compare.js";
import { normalizePullRequest, type NormalizedEvent, type PullRequestPayload } from "./normalize.js";
import { recordEvents } from "./record.js";

// Imports what happened before the webhook existed (or while deliveries were
// failing) from GitHub's REST API: pull requests, branches, branch-unique
// commits and changed files. Re-runnable: everything goes through the same
// recordEvents() path and dedupe keys as webhooks, so a second run inserts
// nothing and webhook/backfill overlap collapses into one event.
//
// Not yet: the repository activity log (exact push/branch times) and
// default-branch commit history. Branch creation times are approximated from
// the branch's oldest unique commit.

type Fetch = typeof fetch;

interface RepoRow {
  repository_id: string;
  project_id: string;
  full_name: string;
  default_branch: string;
}

interface RestPull {
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface RestBranch {
  name: string;
  commit: { sha: string };
}

interface RestCommit {
  sha: string;
  html_url: string;
  author: { login: string } | null;
  commit: { message: string; author: { name: string } | null; committer: { date: string } | null };
}

interface RestCompare extends CompareResponse {
  commits?: RestCommit[];
}

export interface BackfillStats {
  prs_listed: number;
  branches_listed: number;
  events_inserted: number;
  branches_deleted: number;
  failures: string[];
}

const BRANCH_REF = "refs/heads/";
const MAX_PAGES = 10;

function commitEvent(c: RestCommit, branch: string, fallbackTime: string): NormalizedEvent {
  return {
    event_type: "commit",
    external_event_id: c.sha,
    actor: c.author?.login ?? null,
    occurred_at: c.commit.committer?.date ?? fallbackTime,
    branch,
    commit: { sha: c.sha, message: c.commit.message, author: c.author?.login ?? c.commit.author?.name ?? null, url: c.html_url },
    pull_request: null,
    changed_files: [], // not in compare/commit-list responses
  };
}

/** The lifecycle facts a PR listing can prove: it opened, and (maybe) it closed or merged. */
function pullRequestEvents(pr: RestPull): NormalizedEvent[] {
  const payload = (action: string): PullRequestPayload => ({
    action,
    number: pr.number,
    pull_request: { ...pr, merged: pr.merged_at !== null },
    sender: pr.user ?? undefined, // the author; the listing doesn't say who merged
    repository: { id: 0 },
  });
  const events = [normalizePullRequest(payload("opened"))];
  if (pr.closed_at) events.push(normalizePullRequest(payload("closed"))); // merged or closed
  return events.filter((e): e is NormalizedEvent => e !== null);
}

export async function runBackfill(db: Db, repositoryId: string, fetchImpl: Fetch = fetch): Promise<BackfillStats> {
  const { rows } = await db.query<RepoRow>(
    "select repository_id, project_id, full_name, default_branch from repositories where repository_id = $1",
    [repositoryId],
  );
  const repo = rows[0];
  if (!repo) throw new Error(`repository ${repositoryId} not found`);

  // Outcome goes on the repository row (GET /repositories shows it), not just the logs.
  await db.query("update repositories set backfill_status = 'running', backfill_error = null where repository_id = $1", [
    repositoryId,
  ]);
  try {
    const stats = await backfillStages(db, repo, fetchImpl);
    const partial = stats.failures.length > 0;
    await db.query(
      `update repositories set last_backfill_at = now(), backfill_status = $2, backfill_error = $3
        where repository_id = $1`,
      [repositoryId, partial ? "partial" : "succeeded", partial ? stats.failures.join("\n").slice(0, 4000) : null],
    );
    return stats;
  } catch (err) {
    await db
      .query("update repositories set backfill_status = 'failed', backfill_error = $2 where repository_id = $1", [
        repositoryId,
        (err as Error).message.slice(0, 4000),
      ])
      .catch(() => {});
    throw err;
  }
}

/**
 * Stages are independent: one that fails (say, the token can't list pull
 * requests) is recorded in stats.failures and the others still run. Only an
 * unreadable repository aborts the run.
 */
async function backfillStages(db: Db, repo: RepoRow, fetchImpl: Fetch): Promise<BackfillStats> {
  const repositoryId = repo.repository_id;
  const path = `/repos/${repo.full_name}`;
  const stats: BackfillStats = { prs_listed: 0, branches_listed: 0, events_inserted: 0, branches_deleted: 0, failures: [] };
  const record = async (events: NormalizedEvent[]) => {
    const r = await withTransaction(db, (tx) => recordEvents(tx, repo, events, "backfill", null));
    stats.events_inserted += r.inserted;
    return r;
  };

  const gh = await githubGet<{ default_branch: string }>(path, fetchImpl);
  if (gh.default_branch !== repo.default_branch) {
    await db.query("update repositories set default_branch = $2 where repository_id = $1", [repositoryId, gh.default_branch]);
    repo.default_branch = gh.default_branch;
  }

  // 1. Pull requests, oldest first so branch state folds in order.
  let prs: RestPull[] = [];
  try {
    prs = await githubList<RestPull>(`${path}/pulls?state=all&sort=created&direction=asc`, fetchImpl, MAX_PAGES);
  } catch (err) {
    stats.failures.push(`pull requests: ${(err as Error).message} (does GITHUB_TOKEN have "Pull requests: Read"?)`);
  }
  stats.prs_listed = prs.length;
  for (const pr of prs) {
    try {
      await withTransaction(db, async (tx) => {
        // PR keys include the head SHA, which moves as commits land, so match
        // on (type, PR number) instead: a webhook-seen "opened" must not get a twin.
        const fresh: NormalizedEvent[] = [];
        for (const event of pullRequestEvents(pr)) {
          const { rowCount } = await tx.query(
            `select 1 from github_events
              where repository_id = $1 and event_type = $2 and (pull_request ->> 'number')::integer = $3`,
            [repositoryId, event.event_type, pr.number],
          );
          if (!rowCount) fresh.push(event);
        }
        stats.events_inserted += (await recordEvents(tx, repo, fresh, "backfill", null)).inserted;
      });
    } catch (err) {
      stats.failures.push(`PR #${pr.number}: ${(err as Error).message}`);
    }
  }

  // 2. Branches: create unknown ones, catch up heads that moved unseen, store changed files.
  const listedAt = new Date().toISOString();
  let branches: RestBranch[];
  try {
    branches = await githubList<RestBranch>(`${path}/branches`, fetchImpl, MAX_PAGES);
  } catch (err) {
    stats.failures.push(`branches: ${(err as Error).message} (does GITHUB_TOKEN have "Contents: Read"?)`);
    return stats; // without a listing, deletions can't be inferred either
  }
  stats.branches_listed = branches.length;
  for (const b of branches) {
    try {
      await backfillBranch(db, repo, b, listedAt, fetchImpl, record);
    } catch (err) {
      stats.failures.push(`branch ${b.name}: ${(err as Error).message}`);
    }
  }

  // 3. Active branches GitHub no longer lists were deleted while we weren't
  // listening. Skipped if the listing may be truncated, and for branches
  // touched after the listing started (created since, must survive).
  if (branches.length < MAX_PAGES * 100) {
    const listed = new Set(branches.map((b) => b.name));
    const { rows: active } = await db.query<{ branch: string; head_sha: string | null; last_activity_at: Date | null }>(
      "select branch, head_sha, last_activity_at from branch_states where repository_id = $1 and status = 'active'",
      [repositoryId],
    );
    for (const s of active) {
      if (listed.has(s.branch) || !s.head_sha) continue;
      if (s.last_activity_at && s.last_activity_at >= new Date(listedAt)) continue;
      const r = await record([
        {
          event_type: "branch_deleted",
          external_event_id: `${BRANCH_REF}${s.branch}:${s.head_sha}`, // same key a deleting push produces
          actor: null,
          occurred_at: listedAt, // approximate: when we noticed
          branch: s.branch,
          commit: null,
          pull_request: null,
          changed_files: [],
        },
      ]);
      stats.branches_deleted += r.inserted;
    }
  }
  return stats;
}

async function backfillBranch(
  db: Db,
  repo: RepoRow,
  b: RestBranch,
  listedAt: string,
  fetchImpl: Fetch,
  record: (events: NormalizedEvent[]) => Promise<unknown>,
) {
  const path = `/repos/${repo.full_name}`;
  const head = b.commit.sha;
  const ref = `${BRANCH_REF}${b.name}`;
  const isDefault = b.name === repo.default_branch;

  // One compare call gives both the branch-unique commits and its changed
  // files. The default branch is the base, so it has neither.
  const cmp = isDefault ? null : await githubGet<RestCompare>(`${path}/compare/${repo.default_branch}...${head}`, fetchImpl);
  const unique = cmp?.commits ?? [];

  const { rows } = await db.query<{ status: string; head_sha: string | null; last_activity_at: Date | null }>(
    "select status, head_sha, last_activity_at from branch_states where repository_id = $1 and branch = $2",
    [repo.repository_id, b.name],
  );
  const state = rows[0];
  // A row with no head was only inferred from a PR event: its creation was never recorded.
  const unknown = !state || state.status === "deleted" || state.head_sha === null;
  const headMovedUnseen =
    !unknown && state.head_sha !== head && (!state.last_activity_at || state.last_activity_at < new Date(listedAt));

  const events: NormalizedEvent[] = unique.map((c) => commitEvent(c, b.name, listedAt));
  if (unknown || headMovedUnseen) {
    // Network before the transaction: the head's own commit, if compare didn't include it.
    const tip = unique.find((c) => c.sha === head) ?? (await githubGet<RestCommit>(`${path}/commits/${head}`, fetchImpl));
    const tipTime = tip.commit.committer?.date ?? listedAt;
    const headCommit = { sha: head, message: tip.commit.message, author: tip.author?.login ?? tip.commit.author?.name ?? null, url: tip.html_url };
    const base = { actor: null, branch: b.name, pull_request: null, changed_files: [] as string[] };
    if (unknown) {
      events.unshift({
        ...base,
        event_type: "branch_created",
        external_event_id: `${ref}:${head}`,
        // Approximate: git doesn't record when a ref was created.
        occurred_at: unique[0]?.commit.committer?.date ?? tipTime,
        commit: headCommit,
      });
    } else {
      // A push moved the head while we weren't listening (same key a webhook would give it).
      events.push({ ...base, event_type: "push", external_event_id: `${ref}:${head}`, occurred_at: tipTime, commit: headCommit });
    }
  }
  await record(events);

  if (cmp) await storeChangedFiles(db, { repositoryId: repo.repository_id, branch: b.name }, head, changedFilesOf(cmp));
}
