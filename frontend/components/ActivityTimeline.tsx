"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, listEvents, usingMockApi } from "@/lib/api";
import { GithubEvent, ProjectWorkspace, Task } from "@/lib/types";
import { boxCls, boxHeaderCls, boxTitleCls, ghostButtonCls, inputCls } from "@/lib/ui";

// GitHub-style activity feed built from normalized github_events
// (docs/api-contract.md §4.5). Newest first, grouped by day.

type Filter = "all" | "commits" | "prs" | "branches";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "commits", label: "Commits" },
  { value: "prs", label: "Pull requests" },
  { value: "branches", label: "Branches" },
];

const POLL_MS = 20_000;

function matchesFilter(e: GithubEvent, f: Filter) {
  if (f === "all") return true;
  if (f === "commits") return e.event_type === "commit" || e.event_type === "push";
  if (f === "prs") return e.event_type.startsWith("pull_request");
  return e.event_type === "branch_created" || e.event_type === "branch_deleted";
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ActivityTimeline({ workspace }: { workspace: ProjectWorkspace }) {
  const { project, members, tasks } = workspace;
  const pid = project.project_id;

  const [events, setEvents] = useState<GithubEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [branch, setBranch] = useState("");

  const describeError = (e: unknown) =>
    e instanceof ApiError && e.status === 404
      ? "The events endpoint isn't available on the backend yet (contract §4.5)."
      : e instanceof Error
        ? e.message
        : "Couldn't load activity.";

  // Fetch the first page (on mount, on branch change, refresh, and polling).
  const loadFirst = useCallback(
    () =>
      listEvents(pid, { branch: branch || undefined, limit: 50 }).then(
        (page) => {
          setEvents(page.items);
          setCursor(page.next_cursor);
          setError(null);
        },
        (e) => setError(describeError(e))
      ),
    [pid, branch]
  );

  useEffect(() => {
    let cancelled = false;
    listEvents(pid, { branch: branch || undefined, limit: 50 }).then(
      (page) => {
        if (cancelled) return;
        setEvents(page.items);
        setCursor(page.next_cursor);
        setError(null);
      },
      (e) => !cancelled && setError(describeError(e))
    );
    return () => {
      cancelled = true;
    };
  }, [pid, branch]);

  // Light polling so new pushes show up without a refresh. Skipped once the
  // user has paged further back, so their scroll position isn't reset.
  useEffect(() => {
    if (usingMockApi) return;
    const id = setInterval(() => {
      if (!loadingMore && document.visibilityState === "visible") loadFirst();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [loadFirst, loadingMore]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await listEvents(pid, { branch: branch || undefined, limit: 50, cursor });
      setEvents((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load more activity.");
    } finally {
      setLoadingMore(false);
    }
  }

  // github_login -> display name
  const nameFor = useMemo(() => {
    const map = new Map(
      members.filter((m) => m.github_login).map((m) => [m.github_login!.toLowerCase(), m.display_name])
    );
    return (login: string | null) => (login ? map.get(login.toLowerCase()) : undefined);
  }, [members]);

  // Find a task key like "PC-3" in a branch / PR title / commit message.
  const taskFor = useMemo(() => {
    const byKey = new Map(tasks.map((t) => [t.task_key.toUpperCase(), t]));
    const re = new RegExp(`\\b(${project.task_key_prefix}-\\d+)\\b`, "i");
    return (e: GithubEvent): Task | undefined => {
      for (const text of [e.branch, e.pull_request?.title, e.commit?.message]) {
        const m = text?.match(re);
        if (m) {
          const t = byKey.get(m[1].toUpperCase());
          if (t) return t;
        }
      }
      return undefined;
    };
  }, [tasks, project.task_key_prefix]);

  const branches = useMemo(
    () => Array.from(new Set((events ?? []).map((e) => e.branch).filter((b): b is string => !!b))).sort(),
    [events]
  );

  const visible = (events ?? []).filter((e) => matchesFilter(e, filter));
  const groups: { day: string; items: GithubEvent[] }[] = [];
  for (const e of visible) {
    const day = dayLabel(e.occurred_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>Activity</h2>
        <div className="flex items-center gap-2">
          {usingMockApi && (
            <span className="rounded-full border border-yellow/40 bg-yellow/10 px-2 py-0.5 text-xs text-yellow"
              title="Set NEXT_PUBLIC_API_URL in frontend/.env.local to use real events">
              Sample data
            </span>
          )}
          <button className={`${ghostButtonCls} !px-2 !py-0.5 text-xs`} onClick={loadFirst}>
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
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
        <select className={`${inputCls} !py-1 text-xs`} value={branch}
          onChange={(e) => setBranch(e.target.value)}>
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>

      {/* Body: error / loading / empty / feed */}
      {error ? (
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-red">{error}</p>
          <button className={`${ghostButtonCls} mt-3`} onClick={loadFirst}>Try again</button>
        </div>
      ) : events === null ? (
        <ul aria-busy className="animate-pulse">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0">
              <div className="h-7 w-7 rounded-full bg-raised" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3 w-2/3 rounded bg-raised" />
                <div className="h-3 w-1/3 rounded bg-raised" />
              </div>
            </li>
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="font-semibold text-header">No activity yet</p>
          <p className="mt-1 text-sm text-muted">
            {events.length === 0
              ? "Once the repository is connected, branches, commits and pull requests show up here."
              : "Nothing matches this filter."}
          </p>
        </div>
      ) : (
        <div>
          {groups.map((g) => (
            <div key={g.day}>
              <div className="border-b border-line bg-bg/60 px-4 py-1.5 text-xs font-semibold text-muted">
                {g.day}
              </div>
              <ol>
                {g.items.map((e) => (
                  <EventRow key={e.event_id} event={e} name={nameFor(e.actor)} task={taskFor(e)}
                    onBranch={(b) => setBranch(b)} />
                ))}
              </ol>
            </div>
          ))}
          {cursor && (
            <div className="border-t border-line p-3 text-center">
              <button className={ghostButtonCls} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load older activity"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function EventRow({
  event: e,
  name,
  task,
  onBranch,
}: {
  event: GithubEvent;
  name: string | undefined;
  task: Task | undefined;
  onBranch: (b: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const who = name ?? (e.actor ? `@${e.actor}` : "Someone");
  const pr = e.pull_request;

  const chip = (b: string | null) =>
    b ? (
      <button onClick={() => onBranch(b)} title="Show only this branch"
        className="rounded-md bg-link/10 px-1.5 py-0.5 font-mono text-xs text-link hover:underline">
        {b}
      </button>
    ) : null;

  let icon: IconKind = "commit";
  let body: React.ReactNode = null;

  switch (e.event_type) {
    case "commit":
      icon = "commit";
      body = (
        <>
          <span className="font-semibold text-header">{who}</span> committed{" "}
          <a href={e.commit?.url} target="_blank" rel="noreferrer"
            className="font-mono text-xs text-link hover:underline">{e.commit?.sha.slice(0, 7)}</a>{" "}
          to {chip(e.branch)}
          {e.commit?.message && (
            <div className="mt-0.5 truncate text-text">{e.commit.message.split("\n")[0]}</div>
          )}
        </>
      );
      break;
    case "push":
      icon = "push";
      body = (<><span className="font-semibold text-header">{who}</span> pushed to {chip(e.branch)}</>);
      break;
    case "branch_created":
      icon = "branch";
      body = (<><span className="font-semibold text-header">{who}</span> created branch {chip(e.branch)}</>);
      break;
    case "branch_deleted":
      icon = "branch-deleted";
      body = (<><span className="font-semibold text-header">{who}</span> deleted branch <span className="font-mono text-xs text-muted">{e.branch}</span></>);
      break;
    default: {
      const verb = {
        pull_request_opened: "opened",
        pull_request_updated: "updated",
        pull_request_closed: "closed",
        pull_request_merged: "merged",
        pull_request_reopened: "reopened",
      }[e.event_type as string] ?? "updated";
      icon = e.event_type === "pull_request_merged" ? "pr-merged" : e.event_type === "pull_request_closed" ? "pr-closed" : "pr";
      body = (
        <>
          <span className="font-semibold text-header">{who}</span> {verb} pull request{" "}
          <a href={pr?.url} target="_blank" rel="noreferrer" className="text-link hover:underline">#{pr?.number}</a>
          {pr && (
            <div className="mt-0.5 text-text">
              {pr.title}{" "}
              <span className="text-xs text-muted">
                {chip(pr.head_branch)} → <span className="font-mono">{pr.base_branch}</span>
              </span>
            </div>
          )}
        </>
      );
    }
  }

  return (
    <li className="flex gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0 hover:bg-raised/40">
      <EventIcon kind={icon} />
      <div className="min-w-0 flex-1">
        <div className="leading-relaxed text-muted">{body}</div>
        {(task || e.changed_files.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            {task && (
              <span title={`Mentions ${task.task_key}: ${task.title}`}
                className="rounded-full border border-line px-2 py-0.5 font-mono text-muted">
                {task.task_key} <span className="font-sans text-faint">· {task.title}</span>
              </span>
            )}
            {e.changed_files.length > 0 && (
              <button className="text-muted hover:text-link" onClick={() => setOpen((o) => !o)}>
                {open ? "▾" : "▸"} {e.changed_files.length} file{e.changed_files.length === 1 ? "" : "s"} changed
              </button>
            )}
          </div>
        )}
        {open && (
          <ul className="mt-2 rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs text-muted">
            {e.changed_files.map((f) => (<li key={f} className="truncate">{f}</li>))}
          </ul>
        )}
      </div>
      <time dateTime={e.occurred_at} title={new Date(e.occurred_at).toLocaleString()}
        className="shrink-0 pt-0.5 text-xs text-faint">
        {timeAgo(e.occurred_at)}
      </time>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Small hand-drawn icons (16px), colored by meaning.

type IconKind = "commit" | "push" | "branch" | "branch-deleted" | "pr" | "pr-merged" | "pr-closed";

function EventIcon({ kind }: { kind: IconKind }) {
  const color = {
    commit: "text-muted",
    push: "text-muted",
    branch: "text-link",
    "branch-deleted": "text-faint",
    pr: "text-green",
    "pr-merged": "text-purple",
    "pr-closed": "text-red",
  }[kind];

  return (
    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line bg-surface ${color}`}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {kind === "commit" && (<><circle cx="8" cy="8" r="2.6" /><path d="M1 8h4.4M10.6 8H15" /></>)}
        {kind === "push" && (<><path d="M8 13V3" /><path d="M4 7l4-4 4 4" /></>)}
        {(kind === "branch" || kind === "branch-deleted") && (
          <><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6" /><path d="M11.5 7c0 2.5-2 3.5-7 4" /></>
        )}
        {(kind === "pr" || kind === "pr-closed") && (
          <><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="12.5" r="1.5" /><path d="M4 5v6" /><path d="M12 11V6.5a2 2 0 0 0-2-2H7.5" /><path d="M9 3L7.5 4.5 9 6" /></>
        )}
        {kind === "pr-merged" && (
          <><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="8" r="1.5" /><path d="M4 5v6" /><path d="M4 5c0 2.5 3 3 6.5 3" /></>
        )}
      </svg>
    </span>
  );
}
