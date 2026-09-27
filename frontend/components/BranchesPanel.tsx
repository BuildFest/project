"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { listBranches, listPrNotes, listRepositories, usingMockApi } from "@/lib/api";
import type { BranchState, PrNote, ProjectWorkspace, Repository, Task } from "@/lib/types";
import { boxCls, boxHeaderCls, boxTitleCls, ghostButtonCls, pillCls, smallButtonCls, timeAgo } from "@/lib/ui";
import { IconBranches } from "./Icons";

// Branch state from the backend (contract §4.6): status, linked task, open PR
// and changed_files = what merging the branch would change. Pre-merge notes
// (§5.8) are shown on the branch whose PR they're about.

const POLL_MS = 20_000;

// Flags a branch that deserves a look, as a short label ("Quiet 6h"), or null.
// Called for active, non-default branches only. `sharedFiles` is how many of
// its changed files another active branch also changes.
//
// TODO(you): decide what "needs a look" means for a hackathon team.
export function branchAttention(b: BranchState, sharedFiles: number, now: number): string | null {
  void b;
  void sharedFiles;
  void now;
  return null;
}

export default function BranchesPanel({ workspace }: { workspace: ProjectWorkspace }) {
  const pid = workspace.project.project_id;
  const [branches, setBranches] = useState<BranchState[] | null>(null);
  const [notes, setNotes] = useState<PrNote[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  // Staleness is judged against when the data arrived, not each re-render.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(
    () =>
      Promise.all([listBranches(pid), listPrNotes(pid, 100).catch(() => []), listRepositories(pid).catch(() => [])]).then(
        ([b, n, r]) => {
          setLoadedAt(Date.now());
          setBranches(b);
          setNotes(n);
          setRepos(r);
          setError(null);
        },
        (e) => setError(e instanceof Error ? e.message : "Couldn't load branches.")
      ),
    [pid]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (usingMockApi) return;
    const id = setInterval(() => document.visibilityState === "visible" && load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const repoById = useMemo(() => new Map(repos.map((r) => [r.repository_id, r])), [repos]);
  const taskById = useMemo(() => new Map(workspace.tasks.map((t) => [t.task_id, t])), [workspace.tasks]);
  const isDefault = useCallback(
    (b: BranchState) => b.branch === (repoById.get(b.repository_id)?.default_branch ?? "main"),
    [repoById]
  );

  // file -> active feature branches that change it; >1 means a likely conflict.
  const touching = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const b of branches ?? []) {
      if (b.status !== "active" || isDefault(b)) continue;
      for (const f of b.changed_files) m.set(f, [...(m.get(f) ?? []), b.branch]);
    }
    return m;
  }, [branches, isDefault]);

  // Newest note per branch (the list comes newest first).
  const noteFor = useMemo(() => {
    const m = new Map<string, PrNote>();
    for (const n of notes) if (!m.has(n.branch)) m.set(n.branch, n);
    return m;
  }, [notes]);

  const by = (s: BranchState["status"]) => (branches ?? []).filter((b) => b.status === s);
  const sections: { title: string; rows: BranchState[] }[] = [
    { title: "Active", rows: by("active") },
    { title: "Merged", rows: by("merged") },
    ...(showDeleted ? [{ title: "Deleted", rows: by("deleted") }] : []),
  ];
  const deletedCount = by("deleted").length;

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>Branches</h2>
        <div className="flex items-center gap-2">
          {usingMockApi && <span className={pillCls}>Sample data</span>}
          {deletedCount > 0 && (
            <button className={smallButtonCls} onClick={() => setShowDeleted((s) => !s)}>
              {showDeleted ? "Hide" : "Show"} deleted ({deletedCount})
            </button>
          )}
          <button className={smallButtonCls} onClick={load}>Refresh</button>
        </div>
      </div>

      {error ? (
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-red">{error}</p>
          <button className={`${ghostButtonCls} mt-3`} onClick={load}>Try again</button>
        </div>
      ) : branches === null ? (
        <p aria-busy className="px-4 py-8 text-center text-sm text-muted">Loading branches…</p>
      ) : branches.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="font-semibold text-header">No branches yet</p>
          <p className="mt-1 text-sm text-muted">Branches appear after the first push to the connected repository.</p>
        </div>
      ) : (
        sections.filter((s) => s.rows.length > 0).map((s) => (
          <div key={s.title}>
            <div className="border-b border-line bg-bg/60 px-4 py-1.5 text-xs font-semibold text-muted">
              {s.title} <span className="font-normal">· {s.rows.length}</span>
            </div>
            <ul>
              {s.rows.map((b) => {
                const shared = b.changed_files.filter((f) => (touching.get(f)?.length ?? 0) > 1);
                const flag = b.status === "active" && !isDefault(b) ? branchAttention(b, shared.length, loadedAt) : null;
                return (
                  <BranchRow key={`${b.repository_id}:${b.branch}`} b={b}
                    repo={repoById.get(b.repository_id)} task={b.task_id ? taskById.get(b.task_id) : undefined}
                    isDefault={isDefault(b)} flag={flag} touching={touching}
                    note={b.open_pr_number ? noteFor.get(b.branch) : undefined} />
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function BranchRow({
  b,
  repo,
  task,
  isDefault,
  flag,
  touching,
  note,
}: {
  b: BranchState;
  repo: Repository | undefined;
  task: Task | undefined;
  isDefault: boolean;
  flag: string | null;
  touching: Map<string, string[]>;
  note: PrNote | undefined;
}) {
  const [open, setOpen] = useState(false);
  const gh = repo && !usingMockApi ? `https://github.com/${repo.full_name}` : null;
  const statusCls =
    b.status === "active" ? "border-green/50 text-green" : b.status === "merged" ? "border-purple/50 text-purple" : "border-line text-faint";
  const others = (f: string) => (touching.get(f) ?? []).filter((x) => x !== b.branch);
  const overlapping = b.changed_files.filter((f) => others(f).length > 0).length;

  return (
    <li className="border-b border-line px-4 py-3 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <IconBranches className="text-muted" />
        {gh && b.status !== "deleted" ? (
          <a href={`${gh}/tree/${encodeURIComponent(b.branch)}`} target="_blank" rel="noreferrer"
            className="font-mono text-link hover:underline">{b.branch}</a>
        ) : (
          <span className={`font-mono ${b.status === "deleted" ? "text-muted line-through" : "text-header"}`}>{b.branch}</span>
        )}
        {isDefault && <span className={pillCls}>default</span>}
        {!isDefault && <span className={`inline-flex rounded-full border px-2 text-xs ${statusCls}`}>{b.status}</span>}
        {task && (
          <span title={task.title} className="rounded-full border border-line px-2 py-0.5 font-mono text-xs text-muted">
            {task.task_key} <span className="font-sans text-faint">· {task.title}</span>
          </span>
        )}
        {b.open_pr_number && (
          gh ? (
            <a href={`${gh}/pull/${b.open_pr_number}`} target="_blank" rel="noreferrer"
              className="text-xs text-link hover:underline">PR #{b.open_pr_number}</a>
          ) : (
            <span className="text-xs text-muted">PR #{b.open_pr_number}</span>
          )
        )}
        {flag && (
          <span className="rounded-full border border-yellow/50 bg-yellow/10 px-2 text-xs text-yellow">{flag}</span>
        )}
        <span className="ml-auto text-xs text-faint">{timeAgo(b.last_activity_at)}</span>
      </div>

      {b.changed_files.length > 0 && (
        <div className="mt-1.5 pl-6 text-xs">
          <button className="text-muted hover:text-link" onClick={() => setOpen((o) => !o)}>
            {open ? "▾" : "▸"} {b.changed_files.length} file{b.changed_files.length === 1 ? "" : "s"} changed
            {b.status === "active" && overlapping > 0 && (
              <span className="text-yellow"> · {overlapping} also changed on another branch</span>
            )}
          </button>
          {open && (
            <ul className="mt-2 max-h-64 overflow-y-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-muted">
              {b.changed_files.map((f) => {
                const o = b.status === "active" ? others(f) : [];
                return (
                  <li key={f} className="truncate" title={o.length ? `Also changed on ${o.join(", ")}` : f}>
                    <span className={o.length ? "text-yellow" : ""}>{f}</span>
                    {o.length > 0 && <span className="font-sans text-faint"> ← {o.join(", ")}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {note && (
        <div className="mt-2 ml-6 rounded-md border border-line bg-bg px-3 py-2 text-xs">
          <p className="font-semibold text-header">
            Pre-merge note · PR #{note.pull_request_number}
            <span className="ml-2 font-normal text-faint">{note.generated_by === "llm" ? "AI" : "rules"} · {timeAgo(note.created_at)}</span>
          </p>
          <p className="mt-1 whitespace-pre-wrap text-text">{note.note}</p>
          {note.facts.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted">
              {note.facts.map((f) => <li key={f.id}>{f.summary}</li>)}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
