import type { ModelRouter } from "../ai/router.js";
import { withTransaction, type Db, type Queryable } from "../db.js";
import { newId } from "../ids.js";
import { suggestLinks } from "./aiLinks.js";
import { linksFromSuggestions, planLinks, type NewLink } from "./linkPlan.js";
import type { EventTaskLink, GithubEvent, Task } from "./types.js";

export interface LinkRunResult {
  keyOrInherited: number;
  ai: number;
  // Set when the model couldn't be used; rule-based links were still saved.
  aiError: string | null;
}

async function loadLinkInputs(db: Queryable, projectId: string) {
  const project = await db.query<{ task_key_prefix: string }>(
    "select task_key_prefix from projects where project_id = $1",
    [projectId],
  );
  if (project.rowCount === 0) throw new Error(`project ${projectId} not found`);

  const [repos, tasks, events, links] = await Promise.all([
    db.query<{ repository_id: string; default_branch: string }>(
      "select repository_id, default_branch from repositories where project_id = $1",
      [projectId],
    ),
    db.query<Task>(
      `select task_id, task_key, title, description, priority, scope, plan_status,
              milestone_id, target_at, created_at, archived
         from tasks where project_id = $1 and not archived and plan_status <> 'cancelled'`,
      [projectId],
    ),
    db.query<GithubEvent>(
      `select event_id, repository_id, event_type, actor, occurred_at, branch,
              commit, pull_request, changed_files
         from github_events where project_id = $1 order by occurred_at, event_id`,
      [projectId],
    ),
    db.query<EventTaskLink>(
      `select event_id, task_id, method, confidence, status, is_primary
         from event_task_links where project_id = $1`,
      [projectId],
    ),
  ]);

  const defaults = new Map(repos.rows.map((r) => [r.repository_id, r.default_branch]));
  return {
    prefix: project.rows[0].task_key_prefix,
    defaultBranchFor: (repositoryId: string) => defaults.get(repositoryId) ?? "main",
    tasks: tasks.rows,
    events: events.rows,
    links: links.rows,
  };
}

async function insertLinks(db: Queryable, projectId: string, links: NewLink[]): Promise<number> {
  let inserted = 0;
  for (const l of links) {
    // No conflict target: skips duplicates of (event_id, task_id) and a second
    // primary per event, whichever a concurrent run got to first.
    const res = await db.query(
      `insert into event_task_links
         (link_id, project_id, event_id, task_id, method, confidence, status, is_primary, created_by, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'system', $9)
       on conflict do nothing`,
      [newId("link"), projectId, l.event_id, l.task_id, l.method, l.confidence, l.status, l.is_primary, l.reason],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

// Links a project's events to its tasks: task keys and branch inheritance
// first (free, deterministic), then the fast model for whatever is left.
// The model call happens outside any transaction; without a router or API
// key, only rule-based links are made.
export async function linkProjectEvents(
  db: Db,
  router: ModelRouter | null,
  projectId: string,
): Promise<LinkRunResult> {
  const input = await loadLinkInputs(db, projectId);
  const plan = planLinks(input.events, input.tasks, input.prefix, input.links, input.defaultBranchFor);

  let aiLinks: NewLink[] = [];
  let aiError: string | null = null;
  if (plan.needsAi.length > 0) {
    if (!router || !router.available("link_suggestion")) {
      aiError = "no model configured for link_suggestion";
    } else {
      try {
        const suggestions = await suggestLinks(router, plan.needsAi, input.tasks);
        aiLinks = linksFromSuggestions(plan.needsAi, suggestions, [...input.links, ...plan.links]);
      } catch (err) {
        aiError = (err as Error).message;
      }
    }
  }

  return withTransaction(db, async (tx) => ({
    keyOrInherited: await insertLinks(tx, projectId, plan.links),
    ai: await insertLinks(tx, projectId, aiLinks),
    aiError,
  }));
}
