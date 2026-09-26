import { extractEventTaskKeys } from "./taskKeys.js";
import type { EventTaskLink, GithubEvent, Task } from "./types.js";

// Deterministic links for every event that names a task key. Keys that don't
// belong to a task in this project are ignored. Pairs that already have a link
// (including rejected ones) are skipped so a teammate's decision is never undone.
export function linkEventsByTaskKey(
  events: GithubEvent[],
  tasks: Task[],
  prefix: string,
  existing: EventTaskLink[] = [],
): EventTaskLink[] {
  const taskByKey = new Map(tasks.filter((t) => !t.archived).map((t) => [t.task_key, t]));
  const seen = new Set(existing.map((l) => `${l.event_id}|${l.task_id}`));
  const hasPrimary = new Set(
    existing.filter((l) => l.is_primary && l.status !== "rejected").map((l) => l.event_id),
  );

  const links: EventTaskLink[] = [];
  for (const event of events) {
    for (const key of extractEventTaskKeys(event, prefix)) {
      const task = taskByKey.get(key);
      if (!task) continue;
      const pair = `${event.event_id}|${task.task_id}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const isPrimary = !hasPrimary.has(event.event_id);
      if (isPrimary) hasPrimary.add(event.event_id);
      links.push({
        event_id: event.event_id,
        task_id: task.task_id,
        method: "task_key",
        confidence: 1,
        status: "confirmed",
        is_primary: isPrimary,
      });
    }
  }
  return links;
}
