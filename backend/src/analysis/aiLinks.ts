import { createHash } from "node:crypto";
import { z } from "zod";
import { runJson } from "../ai/json.js";
import type { ModelRouter } from "../ai/router.js";
import type { GithubEvent, Task } from "./types.js";

// A unit of work to link as a whole. Every event on a feature branch (commits,
// pushes, PR events via head_branch) normally belongs to one task, so the model
// is asked once per branch. Commits made directly on the default branch are
// judged one by one.
export interface WorkGroup {
  key: string;
  branch: string | null;
  events: GithubEvent[];
}

export interface LinkSuggestion {
  group_key: string;
  task_id: string | null;
  confidence: number;
  reason: string;
}

export function groupEventsForLinking(
  events: GithubEvent[],
  defaultBranchFor: (repositoryId: string) => string,
): WorkGroup[] {
  const groups = new Map<string, WorkGroup>();
  for (const event of events) {
    if (event.event_type === "branch_deleted") continue;
    const branch = event.pull_request?.head_branch ?? event.branch;
    let key: string;
    if (branch && branch !== defaultBranchFor(event.repository_id)) {
      key = `branch:${event.repository_id}:${branch}`;
    } else if (event.event_type === "commit") {
      key = `commit:${event.event_id}`;
    } else {
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { key, branch: key.startsWith("branch:") ? branch : null, events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  return [...groups.values()];
}

const MAX_COMMITS = 15;
const MAX_FILES = 40;

function firstLine(text: string | null | undefined, max = 200): string {
  return (text ?? "").split("\n")[0].slice(0, max);
}

function describeGroup(group: WorkGroup) {
  const ordered = [...group.events].sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
  const prs = new Map<number, string>();
  const commits: string[] = [];
  const files = new Set<string>();
  for (const e of ordered) {
    if (e.pull_request) prs.set(e.pull_request.number, e.pull_request.title);
    if (e.event_type === "commit" && e.commit?.message) commits.push(firstLine(e.commit.message));
    e.changed_files.forEach((f) => files.add(f));
  }
  return {
    branch: group.branch,
    pull_requests: [...prs].map(([number, title]) => `#${number} ${title}`),
    commits: commits.slice(-MAX_COMMITS),
    files: [...files].slice(0, MAX_FILES),
  };
}

const SYSTEM_PROMPT = `You are the link classifier for Pit Crew, a project tracker for small coding teams.
You receive the team's plan tasks and groups of GitHub activity (a branch with its PRs, commits and changed files, or a single commit).
For each group, pick the one task the work implements, or null if it doesn't clearly belong to any task (tooling, formatting, dependency bumps, unrelated fixes).
Only use task_id values from the task list.
confidence: 0.9 or higher only when the work plainly implements that task; 0.5 to 0.8 when plausible; below 0.5 when guessing.
reason: one short sentence naming the evidence (branch name, commit message, PR title or files).
Reply with JSON: {"links":[{"group":"g1","task_id":"task_...","confidence":0.9,"reason":"..."}]}, one entry per group.`;

// Asks the model which task each group belongs to, in batches. Replies are
// validated against the real task IDs, so the model cannot invent a task.
export async function suggestLinks(
  router: ModelRouter,
  groups: WorkGroup[],
  tasks: Task[],
  batchSize = 8,
): Promise<LinkSuggestion[]> {
  const candidates = tasks.filter((t) => !t.archived && t.plan_status !== "cancelled");
  if (groups.length === 0 || candidates.length === 0) return [];

  const taskIds = candidates.map((t) => t.task_id) as [string, ...string[]];
  const taskList = candidates.map((t) => ({
    task_id: t.task_id,
    key: t.task_key,
    title: t.title,
    ...(t.description ? { description: t.description.slice(0, 300) } : {}),
  }));

  const suggestions: LinkSuggestion[] = [];
  for (let i = 0; i < groups.length; i += batchSize) {
    const batch = groups.slice(i, i + batchSize);
    const aliases = batch.map((_, j) => `g${j + 1}`) as [string, ...string[]];
    const schema = z.object({
      links: z.array(
        z.object({
          group: z.enum(aliases),
          task_id: z.enum(taskIds).nullable(),
          confidence: z.number().min(0).max(1),
          reason: z.string().max(300),
        }),
      ),
    });
    const payload = {
      tasks: taskList,
      groups: batch.map((g, j) => ({ group: aliases[j], ...describeGroup(g) })),
    };
    const content = JSON.stringify(payload);
    const reply = await runJson(
      router,
      "link_suggestion",
      { system: SYSTEM_PROMPT, messages: [{ role: "user", content }], maxTokens: 150 * batch.length + 100 },
      schema,
      { cacheKey: createHash("sha1").update(content).digest("hex") },
    );
    for (const link of reply.links) {
      const group = batch[aliases.indexOf(link.group)];
      if (suggestions.some((s) => s.group_key === group.key)) continue;
      suggestions.push({
        group_key: group.key,
        task_id: link.task_id,
        confidence: link.confidence,
        reason: link.reason,
      });
    }
  }
  return suggestions;
}
