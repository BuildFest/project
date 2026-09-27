import { extractTaskKeys } from "./taskKeys.js";
import type { GithubEvent, Task } from "./types.js";

export interface DerivedBranchFiles {
  repository_id: string;
  branch: string;
  changed_files: string[];
  task_id: string | null;
}

const RESET_EVENTS = new Set<GithubEvent["event_type"]>([
  "branch_created",
  "branch_deleted",
  "pull_request_merged",
]);

function eventBranch(event: GithubEvent): string | null {
  return event.pull_request?.head_branch ?? event.branch;
}

/**
 * Replays repository events to approximate each branch's diff from its
 * default branch. Ingestion remains authoritative for lifecycle fields; this
 * function derives only the two columns it leaves empty.
 */
export function deriveBranchFiles(
  events: GithubEvent[],
  tasks: Task[],
  prefix: string,
  defaultBranchFor: (repositoryId: string) => string,
): DerivedBranchFiles[] {
  const liveTaskByKey = new Map(
    tasks.filter((task) => !task.archived).map((task) => [task.task_key.toUpperCase(), task.task_id]),
  );
  const filesByBranch = new Map<string, Set<string>>();
  const names = new Map<string, { repository_id: string; branch: string }>();

  const ordered = [...events].sort(
    (a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || a.event_id.localeCompare(b.event_id),
  );
  for (const event of ordered) {
    const branch = eventBranch(event);
    if (!branch || branch === defaultBranchFor(event.repository_id)) continue;

    const key = `${event.repository_id}\0${branch}`;
    names.set(key, { repository_id: event.repository_id, branch });
    if (RESET_EVENTS.has(event.event_type)) {
      filesByBranch.set(key, new Set());
      continue;
    }

    const files = filesByBranch.get(key) ?? new Set<string>();
    for (const file of event.changed_files) files.add(file);
    filesByBranch.set(key, files);
  }

  return [...names.entries()]
    .map(([key, identity]) => {
      const taskKey = extractTaskKeys(identity.branch, prefix).find((candidate) => liveTaskByKey.has(candidate));
      return {
        ...identity,
        changed_files: [...(filesByBranch.get(key) ?? [])].sort(),
        task_id: taskKey ? (liveTaskByKey.get(taskKey) ?? null) : null,
      };
    })
    .sort(
      (a, b) =>
        a.repository_id.localeCompare(b.repository_id) || a.branch.localeCompare(b.branch),
    );
}
