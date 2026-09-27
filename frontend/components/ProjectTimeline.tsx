"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createDecision, listTimeline, usingMockApi } from "@/lib/api";
import { useActingMember } from "@/lib/actingAs";
import type { ProjectWorkspace, Task, TimelineItem, TimelineKind } from "@/lib/types";
import {
  actorName,
  boxCls,
  boxHeaderCls,
  boxTitleCls,
  buttonCls,
  dayLabel,
  ghostButtonCls,
  inputCls,
  pillCls,
  smallButtonCls,
  timeAgo,
} from "@/lib/ui";
import { IconAlert, IconCheck, IconChecklist, IconCommit } from "./Icons";

// One feed for the whole project (contract §6.1): GitHub activity, plan saves
// and replans, decisions, and the analyzers' risk items. Newest first.

type Group = "github" | "plan" | "decisions" | "risks";
type Filter = "all" | Group;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "github", label: "GitHub" },
  { value: "plan", label: "Plan" },
  { value: "decisions", label: "Decisions" },
  { value: "risks", label: "Risks" },
];

const GROUP: Record<TimelineKind, Group> = {
  github_event: "github",
  plan_change: "plan",
  task_override: "plan",
  replan_proposed: "plan",
  replan_reviewed: "plan",
  decision: "decisions",
  signal_detected: "risks",
  signal_resolved: "risks",
  collision_detected: "risks",
  collision_resolved: "risks",
};

const ICON: Record<Group, { icon: React.ReactNode; cls: string }> = {
  github: { icon: <IconCommit />, cls: "text-muted" },
  plan: { icon: <IconChecklist />, cls: "text-blue" },
  decisions: { icon: <IconCheck />, cls: "text-green" },
  risks: { icon: <IconAlert />, cls: "text-yellow" },
};

const POLL_MS = 20_000;
const PAGE = 50;

export default function ProjectTimeline({ workspace }: { workspace: ProjectWorkspace }) {
  const pid = workspace.project.project_id;
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [paged, setPaged] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [composing, setComposing] = useState(false);

  const taskById = useMemo(() => new Map(workspace.tasks.map((t) => [t.task_id, t])), [workspace.tasks]);

  const loadFirst = useCallback(
    () =>
      listTimeline(pid, { limit: PAGE }).then(
        (page) => {
          setItems(page.items);
          setCursor(page.next_cursor);
          setPaged(false);
          setError(null);
        },
        (e) => setError(e instanceof ApiError && e.status === 404
          ? "The timeline endpoint isn't available on the backend (contract §6.1)."
          : e instanceof Error ? e.message : "Couldn't load the timeline.")
      ),
    [pid]
  );

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  // Poll only while the user is looking at the first page, so paging back
  // isn't reset under them.
  useEffect(() => {
    if (usingMockApi || paged) return;
    const id = setInterval(() => document.visibilityState === "visible" && loadFirst(), POLL_MS);
    return () => clearInterval(id);
  }, [loadFirst, paged]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await listTimeline(pid, { limit: PAGE, cursor });
      setItems((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.next_cursor);
      setPaged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load older items.");
    } finally {
      setLoadingMore(false);
    }
  }

  const visible = (items ?? []).filter((i) => filter === "all" || GROUP[i.kind] === filter);
  const groups: { day: string; items: TimelineItem[] }[] = [];
  for (const i of visible) {
    const day = dayLabel(i.occurred_at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(i);
    else groups.push({ day, items: [i] });
  }

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>Timeline</h2>
        <div className="flex items-center gap-2">
          {usingMockApi && <span className={pillCls}>Sample data</span>}
          <button className={smallButtonCls} onClick={loadFirst}>Refresh</button>
          <button className={smallButtonCls} onClick={() => setComposing((c) => !c)}>
            {composing ? "Cancel" : "Log decision"}
          </button>
        </div>
      </div>

      {composing && (
        <DecisionForm workspace={workspace}
          onSaved={() => {
            setComposing(false);
            setFilter("all");
            loadFirst();
          }} />
      )}

      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="flex overflow-hidden rounded-md border border-line">
          {FILTERS.map((f) => (
            <button key={f.value}
              className={`border-r border-line px-3 py-1 text-xs last:border-r-0 ${
                filter === f.value ? "bg-raised font-semibold text-header" : "text-muted hover:bg-raised"
              }`}
              onClick={() => setFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-red">{error}</p>
          <button className={`${ghostButtonCls} mt-3`} onClick={loadFirst}>Try again</button>
        </div>
      ) : items === null ? (
        <p aria-busy className="px-4 py-8 text-center text-sm text-muted">Loading timeline…</p>
      ) : visible.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="font-semibold text-header">Nothing here yet</p>
          <p className="mt-1 text-sm text-muted">
            {items.length === 0
              ? "Pushes, pull requests, plan saves and decisions show up here as they happen."
              : filter === "decisions"
                ? "No decisions logged yet. Use “Log decision” to record one."
                : "Nothing in the loaded items matches this filter."}
          </p>
        </div>
      ) : (
        <div>
          {groups.map((g) => (
            <div key={g.day}>
              <div className="border-b border-line bg-bg/60 px-4 py-1.5 text-xs font-semibold text-muted">{g.day}</div>
              <ol>
                {g.items.map((i) => (
                  <TimelineRow key={i.item_id} item={i} who={actorName(workspace, i.actor)}
                    tasks={i.related_task_ids.map((id) => taskById.get(id)).filter((t): t is Task => !!t)} />
                ))}
              </ol>
            </div>
          ))}
          {cursor && (
            <div className="border-t border-line p-3 text-center">
              <button className={ghostButtonCls} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load older"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TimelineRow({ item: i, who, tasks }: { item: TimelineItem; who: string | null; tasks: Task[] }) {
  const group = GROUP[i.kind] ?? "plan";
  const { icon, cls } = ICON[group];
  // GitHub titles already name the actor ("alice pushed to main").
  const byline = group !== "github" && who;
  return (
    <li className="flex gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0 hover:bg-raised/40">
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-bg ${cls}`}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-header">{i.title}</p>
        {i.summary && (
          <p className={`mt-0.5 text-text ${group === "github" ? "truncate" : "whitespace-pre-wrap"}`}>{i.summary}</p>
        )}
        {(byline || tasks.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            {byline && <span>by {byline}</span>}
            {tasks.map((t) => (
              <span key={t.task_id} title={t.title} className="rounded-full border border-line px-2 py-0.5 font-mono">
                {t.task_key}
              </span>
            ))}
          </div>
        )}
      </div>
      <time dateTime={i.occurred_at} title={new Date(i.occurred_at).toLocaleString()}
        className="shrink-0 pt-0.5 text-xs text-faint">
        {timeAgo(i.occurred_at)}
      </time>
    </li>
  );
}

// ---------------------------------------------------------------------------

function DecisionForm({ workspace, onSaved }: { workspace: ProjectWorkspace; onSaved: () => void }) {
  const pid = workspace.project.project_id;
  const { member } = useActingMember(workspace);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = workspace.tasks.filter((t) => !t.archived && !taskIds.includes(t.task_id));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!member) return setError("Add a team member first. Decisions are recorded against whoever made them.");
    setSaving(true);
    setError(null);
    try {
      await createDecision(pid, {
        title: title.trim(),
        body: body.trim() || undefined,
        member_id: member.member_id,
        related_task_ids: taskIds,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the decision.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-b border-line bg-bg/40 px-4 py-4">
      <input className={`${inputCls} w-full`} placeholder="What did the team decide?" autoFocus
        value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      <textarea className={`${inputCls} w-full`} rows={3} placeholder="Why? What did you rule out? (optional)"
        value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        {taskIds.map((id) => {
          const t = workspace.tasks.find((x) => x.task_id === id);
          return (
            <button key={id} type="button" title="Remove"
              onClick={() => setTaskIds((ids) => ids.filter((x) => x !== id))}
              className="rounded-full border border-line px-2 py-0.5 font-mono text-xs text-muted hover:border-red hover:text-red">
              {t?.task_key ?? id} ×
            </button>
          );
        })}
        {open.length > 0 && (
          <select className={`${inputCls} !py-1 text-xs`} value=""
            onChange={(e) => e.target.value && setTaskIds((ids) => [...ids, e.target.value])}>
            <option value="">Link a task…</option>
            {open.map((t) => (
              <option key={t.task_id} value={t.task_id}>{t.task_key} · {t.title}</option>
            ))}
          </select>
        )}
      </div>
      {error && <p className="text-sm text-red">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted">Recorded as {member?.display_name ?? "—"}</span>
        <button className={buttonCls} disabled={saving || !title.trim()}>
          {saving ? "Saving…" : "Log decision"}
        </button>
      </div>
    </form>
  );
}
