"use client";

import { useState } from "react";
import type { EventTaskLink, GithubEvent, ProjectWorkspace } from "@/lib/types";
import { actorName, boxCls, boxHeaderCls, boxTitleCls, pillCls, smallButtonCls, timeAgo } from "@/lib/ui";

// Review queue for links Pit Crew guessed (contract §5.1, §5.5). Suggestions
// at >= 0.8 confidence already count toward a task's status, so leaving them
// unreviewed isn't neutral: a wrong one quietly skews "Repo says".

export type PendingLink = EventTaskLink & { event: GithubEvent };

const CONFIDENT = 0.8;

export default function LinkReview({
  workspace,
  links,
  onReview,
}: {
  workspace: ProjectWorkspace;
  links: PendingLink[];
  onReview: (link: PendingLink, status: "confirmed" | "rejected") => Promise<unknown> | undefined;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (links.length === 0) return null;

  async function review(l: PendingLink, status: "confirmed" | "rejected") {
    setBusy(l.link_id);
    try {
      await onReview(l, status);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>
          Suggested links
          <span className="ml-2 rounded-full bg-btn px-1.5 text-xs font-medium text-text">{links.length}</span>
        </h2>
        <span className="text-xs text-muted">Pit Crew guessed which task this work belongs to</span>
      </div>
      <ul>
        {links.map((l) => {
          const task = workspace.tasks.find((t) => t.task_id === l.task_id);
          const counted = l.confidence >= CONFIDENT;
          return (
            <li key={l.link_id} className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-header">{describe(l.event)}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {actorName(workspace, l.event.actor) ?? "Someone"}
                  {l.event.branch && <> on <span className="font-mono">{l.event.branch}</span></>}
                  {" · "}{timeAgo(l.event.occurred_at)}
                </p>
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted">→</span>
                  <span title={task?.title} className="rounded-full border border-line px-2 py-0.5 font-mono text-muted">
                    {task?.task_key ?? "Unknown task"}
                    {task && <span className="font-sans text-faint"> · {task.title}</span>}
                  </span>
                  <span className={pillCls} title={l.method === "llm" ? "Suggested by the AI linker" : `Method: ${l.method}`}>
                    {l.method === "llm" ? "AI" : l.method} · {Math.round(l.confidence * 100)}%
                  </span>
                  {counted && (
                    <span className="text-yellow" title="High-confidence suggestions count toward the task's status until someone reviews them.">
                      already counted
                    </span>
                  )}
                </p>
                {l.reason && <p className="mt-1 text-xs text-muted">{l.reason}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button className={smallButtonCls} disabled={busy !== null} onClick={() => review(l, "confirmed")}>
                  Confirm
                </button>
                <button className={`${smallButtonCls} hover:text-red`} disabled={busy !== null} onClick={() => review(l, "rejected")}>
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function describe(e: GithubEvent): string {
  if (e.commit) return `${e.commit.message.split("\n")[0]} (${e.commit.sha.slice(0, 7)})`;
  if (e.pull_request) return `PR #${e.pull_request.number}: ${e.pull_request.title}`;
  if (e.event_type === "push") return `Push to ${e.branch}`;
  return `${e.event_type.replace(/_/g, " ")}${e.branch ? ` ${e.branch}` : ""}`;
}
