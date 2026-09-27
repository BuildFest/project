"use client";

import { useEffect, useState } from "react";
import { getTaskEvidence } from "@/lib/api";
import type { ProjectWorkspace, TaskEvidence } from "@/lib/types";
import { formatDate, planAsDerived, smallButtonCls } from "@/lib/ui";
import StatusBadge from "./StatusBadge";

// "Why does Pit Crew believe this?" (contract §5.2). Slides in from the right.
export default function EvidenceDrawer({
  workspace,
  taskId,
  onClose,
}: {
  workspace: ProjectWorkspace;
  taskId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<TaskEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pid = workspace.project.project_id;

  useEffect(() => {
    let cancelled = false;
    getTaskEvidence(pid, taskId).then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load evidence.")
    );
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [pid, taskId, onClose]);

  const memberName = (id: string | null) =>
    workspace.members.find((m) => m.member_id === id)?.display_name ?? id ?? "someone";

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button aria-label="Close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside role="dialog" aria-modal
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line bg-raised px-4 py-3">
          <div className="min-w-0">
            <div className="font-mono text-xs text-muted">{data?.task.task_key ?? "…"}</div>
            <h2 className="truncate text-sm font-semibold text-header">{data?.task.title ?? "Loading…"}</h2>
          </div>
          <button className={smallButtonCls} onClick={onClose}>Close</button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-4 text-sm">
          {error && <p className="text-red">{error}</p>}
          {!data && !error && <p className="text-muted">Loading evidence…</p>}

          {data && (
            <>
              <section>
                <h3 className="mb-2 text-xs font-semibold text-muted">Status</h3>
                <div className="grid grid-cols-[80px_1fr] items-center gap-y-2">
                  <span className="text-muted">Planned</span>
                  <span><StatusBadge status={data.task.plan_status} /></span>
                  <span className="text-muted">Observed</span>
                  <span className="flex items-center gap-2">
                    {data.state ? <StatusBadge status={data.state.effective_status} /> : <span className="text-muted">Not analyzed yet</span>}
                    {data.state?.confidence != null && !data.state.override_status && (
                      <span className="text-xs text-faint">{Math.round(data.state.confidence * 100)}% confidence</span>
                    )}
                  </span>
                </div>
                {data.state?.explanation && (
                  <p className="mt-3 rounded-md border border-line bg-bg px-3 py-2 text-text">{data.state.explanation}</p>
                )}
                {data.state?.override_status && (
                  <p className="mt-2 text-xs text-muted">
                    Corrected by {memberName(data.state.override_by)} {formatDate(data.state.override_at)}.
                    Pit Crew computed <span className="text-text">{data.state.computed_status.replace("_", " ")}</span>
                    {data.state.override_reason && <> · “{data.state.override_reason}”</>}
                  </p>
                )}
                {data.state && planAsDerived(data.task.plan_status) !== data.state.effective_status && (
                  <p className="mt-2 text-xs text-yellow">The plan and the repository disagree about this task.</p>
                )}
              </section>

              {data.blocking_tasks.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold text-muted">Depends on</h3>
                  <ul className="overflow-hidden rounded-md border border-line">
                    {data.blocking_tasks.map(({ task, state }) => (
                      <li key={task.task_id} className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-b-0">
                        <span className="min-w-0 truncate"><span className="font-mono text-xs text-muted">{task.task_key}</span> {task.title}</span>
                        <StatusBadge status={state?.effective_status ?? task.plan_status} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {data.signals.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold text-muted">Active signals</h3>
                  <ul className="space-y-2">
                    {data.signals.map((s) => (
                      <li key={s.signal_id} className="rounded-md border border-yellow/30 bg-yellow/5 px-3 py-2">
                        <div className="font-medium text-header">{s.title}</div>
                        <div className="text-xs text-muted">{s.explanation}</div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold text-muted">Linked activity ({data.links.length})</h3>
                {data.links.length === 0 ? (
                  <p className="text-muted">
                    Nothing in the repo mentions {data.task.task_key} yet. Put the key in a branch name or PR title,
                    e.g. <span className="font-mono text-text">{data.task.task_key.toLowerCase()}-…</span>
                  </p>
                ) : (
                  <ul className="overflow-hidden rounded-md border border-line">
                    {data.links.map(({ event: e, method, confidence, status }) => (
                      <li key={e.event_id} className="border-b border-line px-3 py-2 last:border-b-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-text">{describe(e)}</span>
                          <span className="shrink-0 text-xs text-faint">{formatDate(e.occurred_at)}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-faint">
                          {e.actor && <>@{e.actor} · </>}
                          {e.branch && <span className="font-mono">{e.branch}</span>}
                          {" · "}
                          {method === "task_key" ? "matched by task key" : method === "manual" ? "linked by a teammate" : `AI match, ${Math.round(confidence * 100)}%${status === "suggested" ? " · unreviewed" : ""}`}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function describe(e: TaskEvidence["links"][number]["event"]) {
  switch (e.event_type) {
    case "commit":
      return `Commit ${e.commit?.sha.slice(0, 7)}: ${e.commit?.message.split("\n")[0] ?? ""}`;
    case "push":
      return "Pushed to branch";
    case "branch_created":
      return "Branch created";
    case "branch_deleted":
      return "Branch deleted";
    default:
      return `PR #${e.pull_request?.number} ${e.event_type.replace("pull_request_", "")}: ${e.pull_request?.title ?? ""}`;
  }
}
