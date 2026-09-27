"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createDecision, createManualLink, listDecisions, listStatusMoves, listTimeline, undoStatusMove, usingMockApi } from "@/lib/api";
import { useActingMember } from "@/lib/actingAs";
import type { Decision, ProjectWorkspace, StatusMove, TimelineItem, TimelineKind } from "@/lib/types";
import { actorName, buttonCls, ghostButtonCls, inputCls, timeAgo } from "@/lib/ui";

const POLL_MS = 20_000;
type Filter = "all" | "github" | "plan" | "risk" | "decision";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "github", label: "Development" },
  { value: "plan", label: "Planning" },
  { value: "risk", label: "Risks" },
  { value: "decision", label: "Decisions" },
];

export default function ActivityTimeline({ workspace }: { workspace: ProjectWorkspace }) {
  const pid = workspace.project.project_id;
  const { member } = useActingMember(workspace);
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [moves, setMoves] = useState<StatusMove[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [moreFilters, setMoreFilters] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [decisionTasks, setDecisionTasks] = useState<string[]>([]);

  const loadFirst = useCallback(async () => {
    const [page, knownDecisions, knownMoves] = await Promise.all([
      listTimeline(pid, { task_id: taskId || undefined, limit: 50 }),
      listDecisions(pid),
      listStatusMoves(pid).catch(() => [] as StatusMove[]),
    ]);
    setItems(page.items);
    setCursor(page.next_cursor);
    setDecisions(knownDecisions);
    setMoves(knownMoves);
    setError(null);
  }, [pid, taskId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listTimeline(pid, { task_id: taskId || undefined, limit: 50 }), listDecisions(pid), listStatusMoves(pid).catch(() => [] as StatusMove[])]).then(
      ([page, knownDecisions, knownMoves]) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.next_cursor);
        setDecisions(knownDecisions);
        setMoves(knownMoves);
        setError(null);
      },
      (e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load updates."),
    );
    return () => { cancelled = true; };
  }, [pid, taskId]);

  useEffect(() => {
    if (usingMockApi) return;
    const id = setInterval(() => {
      if (!loadingMore && document.visibilityState === "visible") void loadFirst();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [loadFirst, loadingMore]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await listTimeline(pid, { task_id: taskId || undefined, limit: 50, cursor });
      setItems((old) => [...(old ?? []), ...page.items]);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load older updates.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([loadFirst(), new Promise((resolve) => setTimeout(resolve, 450))]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't refresh activity.");
    } finally {
      setRefreshing(false);
    }
  }

  async function saveDecision() {
    if (!member || !title.trim()) return;
    try {
      await createDecision(pid, {
        title: title.trim(), body: body.trim() || undefined,
        member_id: member.member_id, related_task_ids: decisionTasks,
      });
      setTitle(""); setBody(""); setDecisionTasks([]); setDecisionOpen(false);
      await loadFirst();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't record decision.");
    }
  }

  const visible = useMemo(() => summarizeUpdates((items ?? []).filter((item) => matches(item.kind, filter))), [items, filter]);
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const decisionById = useMemo(() => new Map(decisions.map((d) => [d.decision_id, d])), [decisions]);
  const moveById = useMemo(() => new Map(moves.map((m) => [m.move_id, m])), [moves]);
  const tasksById = useMemo(() => new Map(workspace.tasks.map((t) => [t.task_id, t])), [workspace.tasks]);

  return <div className="mx-auto max-w-5xl">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line-strong pb-5">
      <div>
        <h2 className="text-xl font-semibold text-header">Updates</h2>
        <p className="mt-1 text-sm text-muted">The project changes that matter, without the repository noise.</p>
      </div>
      <div className="flex gap-2">
        <button className={`${ghostButtonCls} min-w-24 gap-2`} disabled={refreshing} onClick={() => void refresh()}>
          {refreshing && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-transparent" aria-hidden />}
          {refreshing ? "Refreshing" : "Refresh"}
        </button>
        <button className={buttonCls} disabled={!member} onClick={() => setDecisionOpen((open) => !open)}>Record decision</button>
      </div>
    </header>

    {error && <div className="mt-4 flex items-center justify-between gap-4 border-l-2 border-red bg-red/5 px-3 py-2 text-sm text-red"><span>{error}</span><button className="shrink-0 text-xs font-medium hover:underline" onClick={() => void refresh()}>Try again</button></div>}

    {decisionOpen && <DecisionForm workspace={workspace} title={title} body={body} selected={decisionTasks}
      setTitle={setTitle} setBody={setBody} setSelected={setDecisionTasks} onSave={saveDecision} onCancel={() => setDecisionOpen(false)} />}

    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4">
      <div className="flex gap-5 overflow-x-auto">
        {FILTERS.map((option) => <button key={option.value} onClick={() => setFilter(option.value)}
          className={`border-b-2 pb-1 text-sm ${filter === option.value ? "border-signal font-medium text-header" : "border-transparent text-muted hover:text-header"}`}>
          {option.label}
        </button>)}
      </div>
      <button className="text-xs text-muted hover:text-header" onClick={() => setMoreFilters((open) => !open)}>
        {moreFilters ? "Hide filters" : `More filters${taskId ? " · active" : ""}`}
      </button>
    </div>

    {moreFilters && <div className="flex flex-wrap gap-2 border-b border-line py-3">
      <select className={`${inputCls} !py-1 text-xs`} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
        <option value="">Any task</option>
        {workspace.tasks.filter((t) => !t.archived).map((t) => <option key={t.task_id} value={t.task_id}>{t.task_key} · {t.title}</option>)}
      </select>
      {taskId && <button className="text-xs text-link hover:underline" onClick={() => setTaskId("")}>Clear filter</button>}
    </div>}

    {items === null ? <Loading /> : groups.length === 0 ? <Empty hasItems={items.length > 0} filtered={filter !== "all" || !!taskId} /> : (
      <div>{groups.map((group) => <section key={group.label} className="border-b border-line py-6">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-[.14em] text-faint">{group.label}</h3>
        <ol>{group.items.map((item, index) => <EventRow key={item.item_id} item={item} first={index === 0} last={index === group.items.length - 1}
          workspace={workspace} decision={decisionById.get(item.entity_id)}
          move={item.entity_type === "plan_status_moves" ? moveById.get(item.entity_id) : undefined}
          tasksById={tasksById} onLinked={loadFirst} />)}</ol>
      </section>)}</div>
    )}

    {cursor && <div className="py-5 text-center"><button className={ghostButtonCls} disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load older updates"}</button></div>}
  </div>;
}

function EventRow({ item, first, last, workspace, decision, move, tasksById, onLinked }: {
  item: TimelineItem; first: boolean; last: boolean; workspace: ProjectWorkspace; decision?: Decision; move?: StatusMove;
  tasksById: Map<string, ProjectWorkspace["tasks"][number]>; onLinked: () => Promise<void>;
}) {
  const { member } = useActingMember(workspace);
  const [expanded, setExpanded] = useState(false);
  const [linkTask, setLinkTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const category = eventCategory(item.kind);

  async function undo() {
    if (!member || !move) return;
    setBusy(true);
    setUndoError(null);
    try {
      await undoStatusMove(workspace.project.project_id, move.move_id, member.member_id);
      await onLinked();
    } catch (e) {
      setUndoError(e instanceof Error ? e.message : "Couldn't undo this change.");
    } finally { setBusy(false); }
  }

  async function link() {
    if (!member || !linkTask) return;
    setBusy(true);
    try {
      await createManualLink(workspace.project.project_id, { event_id: item.entity_id, task_id: linkTask, member_id: member.member_id });
      setLinkTask("");
      await onLinked();
    } finally { setBusy(false); }
  }

  const decisionRationale = item.kind === "decision" ? uniqueRationale(item.title, item.summary, decision?.body ?? null) : null;
  const hasDetails = (item.kind !== "decision" && !!item.summary) || item.related_task_ids.length > 0 || item.kind === "github_event";
  const grouped = item.summary?.match(/(\d+) related changes grouped together/);
  return <li className="grid grid-cols-[20px_minmax(0,1fr)] gap-2">
    <div className="relative flex justify-center">
      {!first && <span className="absolute -top-4 bottom-1/2 w-px bg-line" />}
      {!last && <span className="absolute top-1/2 -bottom-4 w-px bg-line" />}
      <TimelineMarker kind={item.kind} color={category.dot} />
    </div>
    <article className="pb-6">
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline">
        <div className="min-w-0"><span className="mr-3 text-xs font-medium text-muted">{category.label}</span><span className={`${category.prominent || /merged/i.test(item.title) ? "font-semibold" : "font-medium"} text-header`}>{item.title}</span></div>
        <time className="shrink-0 text-xs text-faint" dateTime={item.occurred_at} title={new Date(item.occurred_at).toLocaleString()}>{timeAgo(item.occurred_at)}</time>
      </div>
      {decisionRationale && <p className="mt-1 text-sm leading-6 text-muted">{decisionRationale}</p>}
      <div className="mt-1 flex items-center gap-2 text-xs text-muted">
        {grouped && <span>{grouped[1]} related changes</span>}
        {hasDetails && !expanded && <button className="font-medium hover:text-header" onClick={() => setExpanded(true)}>View context</button>}
        {move && (move.undone_at
          ? <span className="text-faint">Undone{move.undone_by ? ` by ${actorName(workspace, move.undone_by)}` : ""}</span>
          : <button className="font-medium text-link hover:underline disabled:opacity-50" disabled={!member || busy}
              title={member ? "Put the task back and leave its status to the team" : "Choose who you're acting as to undo"}
              onClick={() => void undo()}>{busy ? "Undoing…" : "Undo"}</button>)}
      </div>
      {undoError && <p className="mt-1 text-xs text-red" role="alert">{undoError}</p>}
      {expanded && <div className="mt-2 max-w-2xl border-l-2 border-line-strong py-0.5 pl-3">
        <div className="mb-1.5 flex items-center gap-3 text-xs">
          <span className="font-medium text-muted">Context</span>
          <button className="font-medium text-faint hover:text-header" onClick={() => setExpanded(false)}>Close context</button>
        </div>
        {item.kind !== "decision" && item.summary && <p className="text-sm leading-6 text-muted">{item.summary}</p>}
        {item.related_task_ids.length > 0 && <p className="mt-1.5 text-xs text-muted">Tasks: {item.related_task_ids.map((id) => tasksById.get(id)?.task_key ?? id).join(", ")}</p>}
        {item.kind === "github_event" && <div className="mt-2 flex flex-wrap items-center gap-2">
          <select aria-label="Task to link" className={`${inputCls} !py-1 text-xs`} value={linkTask} onChange={(e) => setLinkTask(e.target.value)}>
            <option value="">Link to task…</option>
            {workspace.tasks.filter((t) => !t.archived && !item.related_task_ids.includes(t.task_id)).map((t) => <option key={t.task_id} value={t.task_id}>{t.task_key} · {t.title}</option>)}
          </select>
          <button className="text-xs text-link hover:underline disabled:opacity-50" disabled={!linkTask || !member || busy} onClick={() => void link()}>{busy ? "Linking…" : "Link event"}</button>
        </div>}
      </div>}
    </article>
  </li>;
}

function DecisionForm({ workspace, title, body, selected, setTitle, setBody, setSelected, onSave, onCancel }: {
  workspace: ProjectWorkspace; title: string; body: string; selected: string[];
  setTitle: (v: string) => void; setBody: (v: string) => void; setSelected: (v: string[]) => void;
  onSave: () => Promise<void>; onCancel: () => void;
}) {
  return <form className="border-b border-line py-5" onSubmit={(e) => { e.preventDefault(); void onSave(); }}>
    <h3 className="text-sm font-semibold text-header">Record a decision</h3>
    <div className="mt-3 grid gap-3 md:grid-cols-2"><input className={inputCls} placeholder="Decision title" value={title} onChange={(e) => setTitle(e.target.value)} /><textarea className={`${inputCls} min-h-20`} placeholder="Why this decision? (optional)" value={body} onChange={(e) => setBody(e.target.value)} /></div>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">{workspace.tasks.filter((t) => !t.archived).map((t) => <label key={t.task_id} className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={selected.includes(t.task_id)} onChange={(e) => setSelected(e.target.checked ? [...selected, t.task_id] : selected.filter((id) => id !== t.task_id))} />{t.task_key}</label>)}</div>
    <div className="mt-4 flex gap-2"><button className={buttonCls} disabled={!title.trim()}>Save decision</button><button type="button" className={ghostButtonCls} onClick={onCancel}>Cancel</button></div>
  </form>;
}

function eventCategory(kind: TimelineKind) {
  if (kind === "decision") return { label: "Decision", dot: "bg-purple", prominent: true };
  if (kind === "plan_change" || kind.startsWith("replan_")) return { label: "Planning", dot: "bg-signal", prominent: true };
  if (kind === "signal_resolved" || kind === "collision_resolved") return { label: "Resolved", dot: "bg-green", prominent: true };
  if (kind.startsWith("signal_") || kind.startsWith("collision_")) return { label: "Active risk", dot: "bg-yellow", prominent: true };
  if (kind === "github_event") return { label: "Development", dot: "bg-blue", prominent: false };
  return { label: "Status", dot: "bg-muted", prominent: false };
}

function TimelineMarker({ kind, color }: { kind: TimelineKind; color: string }) {
  const activeRisk = kind === "signal_detected" || kind === "collision_detected";
  const resolved = kind === "signal_resolved" || kind === "collision_resolved";
  if (kind === "decision" || activeRisk || resolved) {
    return <span className={`relative z-10 mt-[2px] grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-bold leading-none text-bg ring-3 ring-bg ${color}`} aria-hidden>
      {kind === "decision" ? "◆" : resolved ? "✓" : "!"}
    </span>;
  }
  return <span className={`relative z-10 mt-[7px] h-2.5 w-2.5 rounded-full ring-4 ring-bg ${color}`} aria-hidden />;
}

function uniqueRationale(title: string, summary: string | null, body: string | null) {
  const values = [body, summary].map((value) => value?.trim()).filter((value): value is string => !!value);
  const normalizedTitle = normalizeText(title.replace(/^Decision:\s*/i, ""));
  return values.find((value, index) => normalizeText(value) !== normalizedTitle && values.findIndex((candidate) => normalizeText(candidate) === normalizeText(value)) === index) ?? null;
}

function normalizeText(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function summarizeUpdates(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  for (const item of items) {
    const previous = result[result.length - 1];
    const branch = branchFromItem(item);
    const previousBranch = previous ? branchFromItem(previous) : null;
    const closeInTime = previous && Math.abs(new Date(previous.occurred_at).getTime() - new Date(item.occurred_at).getTime()) < 2 * 60 * 60 * 1000;
    const routine = /pushed new work|pushed to|started work|created branch|updated /;
    const isRoutineDevelopment = item.kind === "github_event" && routine.test(item.title) && !/review|merged|closed/.test(item.title);
    const previousIsRoutine = previous?.kind === "github_event" && routine.test(previous.title) && !/review|merged|closed/.test(previous.title);
    if (previous && closeInTime && branch && branch === previousBranch && item.actor === previous.actor && isRoutineDevelopment && previousIsRoutine) {
      const count = Number(previous.item_id.match(/:group:(\d+)$/)?.[1] ?? 1) + 1;
      result[result.length - 1] = {
        ...previous,
        item_id: `${previous.entity_id}:group:${count}`,
        title: `${item.actor ?? "Someone"} updated the project`,
        summary: [branch, `${count} related changes grouped together`].join(" · "),
      };
    } else {
      result.push(item);
    }
  }
  return result;
}

function branchFromSummary(summary: string | null) {
  if (!summary) return null;
  const parts = summary.split(" · ");
  return parts.find((part) => part.includes("/") || /^(main|master|develop|dev)$/.test(part)) ?? parts.at(-1) ?? null;
}

function branchFromItem(item: TimelineItem) {
  const fromSummary = branchFromSummary(item.summary);
  const fromTitle = item.title.match(/(?:pushed to|created branch|started work on|updated)\s+([^:]+)$/i)?.[1]?.trim();
  return fromTitle || fromSummary;
}

function matches(kind: TimelineKind, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "github") return kind === "github_event";
  if (filter === "decision") return kind === "decision";
  if (filter === "plan") return kind === "plan_change" || kind.startsWith("replan_");
  return kind.startsWith("signal_") || kind.startsWith("collision_") || kind === "task_override";
}

function groupByDay(items: TimelineItem[]) {
  const groups: Array<{ label: string; items: TimelineItem[] }> = [];
  for (const item of items) {
    const label = dayLabel(item.occurred_at);
    const current = groups[groups.length - 1];
    if (current?.label === label) current.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function Loading() {
  return <div className="py-7" aria-busy="true" aria-label="Loading activity">
    <div className="grid gap-5 md:grid-cols-[120px_1fr]">
      <div className="h-3 w-16 animate-pulse rounded bg-raised" />
      <div className="space-y-6">{[1, 2, 3, 4].map((i) => <div key={i} className="flex gap-3"><span className="mt-1 h-2.5 w-2.5 animate-pulse rounded-full bg-raised" /><div className="flex-1 space-y-2"><div className="h-3 w-3/4 animate-pulse rounded bg-raised" /><div className="h-2.5 w-24 animate-pulse rounded bg-raised" /></div></div>)}</div>
    </div>
  </div>;
}

function Empty({ hasItems, filtered }: { hasItems: boolean; filtered: boolean }) {
  const title = filtered || hasItems ? "No matching updates" : "No updates yet";
  const text = filtered || hasItems
    ? "Try clearing a filter."
    : "Development, planning, decisions, and risks will appear here.";
  return <div className="py-16 text-center"><div className="mx-auto mb-3 h-8 w-px bg-line-strong" /><p className="font-medium text-header">{title}</p><p className="mt-1 text-sm text-muted">{text}</p></div>;
}
