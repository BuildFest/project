import { groupEventsForLinking, type LinkSuggestion, type WorkGroup } from "./aiLinks.js";
import { linkEventsByTaskKey } from "./links.js";
import type { EventTaskLink, GithubEvent, Task } from "./types.js";

// AI links at or above this confidence count toward task state immediately
// (shown as AI-inferred, rejectable). Lower ones wait in the review queue.
export const AUTO_ACCEPT_CONFIDENCE = 0.8;

export function countsTowardState(link: EventTaskLink, threshold = AUTO_ACCEPT_CONFIDENCE): boolean {
  if (link.status === "confirmed") return true;
  return link.status === "suggested" && link.method === "llm" && link.confidence >= threshold;
}

export interface NewLink extends EventTaskLink {
  reason: string | null;
}

export interface LinkPlan {
  links: NewLink[];
  // Groups with unlinked events and no linked siblings: these need the model.
  needsAi: WorkGroup[];
}

class LinkBook {
  private pairs = new Set<string>();
  private primaries = new Set<string>();
  private linked = new Set<string>();
  readonly added: NewLink[] = [];

  constructor(private readonly all: EventTaskLink[]) {
    for (const l of all) this.track(l);
  }

  private track(l: EventTaskLink) {
    this.pairs.add(`${l.event_id}|${l.task_id}`);
    if (l.status !== "rejected") {
      this.linked.add(l.event_id);
      if (l.is_primary) this.primaries.add(l.event_id);
    }
  }

  isLinked(eventId: string) {
    return this.linked.has(eventId);
  }

  add(link: Omit<NewLink, "is_primary">) {
    if (this.pairs.has(`${link.event_id}|${link.task_id}`)) return;
    const full = { ...link, is_primary: !this.primaries.has(link.event_id) };
    this.track(full);
    this.all.push(full);
    this.added.push(full);
  }

  // The task most of a group's linked events point at, if any.
  inheritedTask(group: WorkGroup): { task_id: string; sources: EventTaskLink[] } | null {
    const ids = new Set(group.events.map((e) => e.event_id));
    const byTask = new Map<string, EventTaskLink[]>();
    for (const l of this.all) {
      if (!ids.has(l.event_id) || l.status === "rejected") continue;
      byTask.set(l.task_id, [...(byTask.get(l.task_id) ?? []), l]);
    }
    let best: { task_id: string; sources: EventTaskLink[] } | null = null;
    for (const [task_id, sources] of byTask) {
      if (!best || sources.length > best.sources.length) best = { task_id, sources };
    }
    return best;
  }
}

// Decides every link that can be made without a model: task keys first, then
// events inheriting the task their branch is already linked to. Whatever is
// left over is returned as groups for the model.
export function planLinks(
  events: GithubEvent[],
  tasks: Task[],
  prefix: string,
  existing: EventTaskLink[],
  defaultBranchFor: (repositoryId: string) => string,
): LinkPlan {
  const book = new LinkBook([...existing]);
  const keyByTask = new Map(tasks.map((t) => [t.task_id, t.task_key]));

  for (const link of linkEventsByTaskKey(events, tasks, prefix, existing)) {
    book.add({ ...link, reason: null });
  }

  const needsAi: WorkGroup[] = [];
  for (const group of groupEventsForLinking(events, defaultBranchFor)) {
    const unlinked = group.events.filter((e) => !book.isLinked(e.event_id));
    if (unlinked.length === 0) continue;

    const inherited = book.inheritedTask(group);
    if (!inherited) {
      needsAi.push({ ...group, events: unlinked });
      continue;
    }
    const allByKey = inherited.sources.every((s) => s.method === "task_key");
    const confidence = Math.max(
      ...inherited.sources.map((s) => (s.status === "confirmed" ? 1 : s.confidence)),
    );
    for (const e of unlinked) {
      book.add({
        event_id: e.event_id,
        task_id: inherited.task_id,
        method: allByKey ? "task_key" : "llm",
        status: allByKey ? "confirmed" : "suggested",
        confidence,
        reason: `Same branch as work already linked to ${keyByTask.get(inherited.task_id) ?? "this task"}`,
      });
    }
  }

  return { links: book.added, needsAi };
}

// Turns model suggestions into links. Pairs a teammate rejected are skipped.
export function linksFromSuggestions(
  groups: WorkGroup[],
  suggestions: LinkSuggestion[],
  existing: EventTaskLink[],
): NewLink[] {
  const book = new LinkBook([...existing]);
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const s of suggestions) {
    const group = byKey.get(s.group_key);
    if (!group || !s.task_id) continue;
    for (const e of group.events) {
      book.add({
        event_id: e.event_id,
        task_id: s.task_id,
        method: "llm",
        status: "suggested",
        confidence: s.confidence,
        reason: s.reason,
      });
    }
  }
  return book.added;
}
