"use client";

import { useEffect, useState } from "react";
import { acceptReplan, ApiError, listReplans, rejectReplan, usingMockApi } from "@/lib/api";
import type { PlanChange, ProjectWorkspace, ReplanSuggestion, Task } from "@/lib/types";
import { boxCls, boxHeaderCls, boxTitleCls, buttonCls, formatDate, ghostButtonCls, pillCls } from "@/lib/ui";

// Suggested plan changes (contract §5.7). Nothing is applied until a teammate
// accepts; each change is shown as before → after against the current plan.
export default function ReplanPanel({
  workspace,
  memberId,
  refreshKey,
  onWorkspaceChange,
  onNotice,
}: {
  workspace: ProjectWorkspace;
  memberId: string | null;
  refreshKey: string; // changes when the analysis re-runs
  onWorkspaceChange: (w: ProjectWorkspace) => void;
  onNotice: (msg: string) => void;
}) {
  const pid = workspace.project.project_id;
  const [items, setItems] = useState<ReplanSuggestion[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listReplans(pid).then(
      (r) => {
        if (cancelled) return;
        setItems(r);
        setUnavailable(false);
      },
      (e) => {
        if (cancelled) return;
        // Endpoint not built yet: stay quiet rather than show an error box.
        if (e instanceof ApiError && e.status === 404) setUnavailable(true);
        setItems([]);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [pid, workspace, refreshKey]);

  async function review(s: ReplanSuggestion, accept: boolean) {
    if (!memberId) {
      onNotice("Add a team member first. Plan changes are recorded under a member's name.");
      return;
    }
    setBusy(s.suggestion_id);
    try {
      if (accept) {
        const { workspace: w, plan_version } = await acceptReplan(pid, s.suggestion_id, memberId);
        onWorkspaceChange(w);
        onNotice(`Plan updated to version ${plan_version}. ${s.proposed_changes.length} change${s.proposed_changes.length === 1 ? "" : "s"} applied.`);
      } else {
        await rejectReplan(pid, s.suggestion_id, memberId);
        onNotice("Suggestion rejected. The plan is unchanged.");
      }
      setItems((prev) => (prev ?? []).filter((x) => x.suggestion_id !== s.suggestion_id));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        onNotice("The plan changed since this was suggested. Pit Crew will re-suggest against the current plan.");
      } else {
        onNotice(e instanceof Error ? e.message : "Couldn't apply the suggestion.");
      }
    } finally {
      setBusy(null);
    }
  }

  if (unavailable || !items || items.length === 0) return null;

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>
          Suggested plan changes
          <span className="ml-2 rounded-full bg-btn px-1.5 text-xs font-medium text-text">{items.length}</span>
        </h2>
        <span className="flex items-center gap-2 text-xs text-muted">
          {usingMockApi && <span className={pillCls}>Sample</span>}
          Nothing changes until someone accepts
        </span>
      </div>
      <ul>
        {items.map((s) => (
          <li key={s.suggestion_id} className="border-b border-line px-4 py-4 last:border-b-0">
            <div className="flex items-start gap-3">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-purple" aria-hidden>
                <path d="M2 4h8M2 8h5M2 12h8M12 2.5l2 1.5-2 1.5M12 10.5l2 1.5-2 1.5" />
              </svg>
              <div className="min-w-0 flex-1">
                <p className="text-header">{s.rationale}</p>
                <ul className="mt-3 overflow-hidden rounded-md border border-line-strong">
                  {s.proposed_changes.map((c, i) => (
                    <ChangeRow key={i} change={c} workspace={workspace} />
                  ))}
                </ul>
                <div className="mt-3 flex items-center gap-2">
                  <button className={buttonCls} disabled={busy === s.suggestion_id} onClick={() => review(s, true)}>
                    {busy === s.suggestion_id ? "Applying…" : "Accept changes"}
                  </button>
                  <button className={ghostButtonCls} disabled={busy === s.suggestion_id} onClick={() => review(s, false)}>
                    Reject
                  </button>
                  <span className="ml-1 text-xs text-muted">
                    {s.generated_by === "llm" ? "Suggested by AI" : "Suggested by rules"} · based on plan v{s.based_on_plan_version}
                    {s.evidence_event_ids.length > 0 && ` · ${s.evidence_event_ids.length} events`}
                  </span>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  description: "Description",
  owner_member_id: "Owner",
  priority: "Priority",
  scope: "Scope",
  plan_status: "Status",
  milestone_id: "Milestone",
  target_at: "Target",
  sort_order: "Order",
};

function ChangeRow({ change: c, workspace }: { change: PlanChange; workspace: ProjectWorkspace }) {
  const task = (id: string) => workspace.tasks.find((t) => t.task_id === id);
  const label = (t: Task | undefined) =>
    t ? (<><span className="font-mono text-xs text-muted">{t.task_key}</span> <span className="text-header">{t.title}</span></>) : <span className="text-muted">Unknown task</span>;

  const fmt = (field: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "none";
    if (field === "owner_member_id") {
      const m = workspace.members.find((mm) => mm.member_id === v);
      return m ? (m.github_login ? `@${m.github_login}` : m.display_name) : "someone";
    }
    if (field === "milestone_id") return workspace.milestones.find((m) => m.milestone_id === v)?.name ?? "a milestone";
    if (field === "target_at") return formatDate(String(v));
    if (field === "scope") return v === "must_have" ? "must-have" : "optional";
    return String(v).replace(/_/g, " ");
  };

  let body: React.ReactNode;
  switch (c.op) {
    case "update_task": {
      const t = task(c.task_id);
      body = (
        <>
          <div className="mb-1.5">{label(t)}</div>
          <div className="space-y-1">
            {Object.entries(c.changes).map(([field, after]) => (
              <Diff key={field} label={FIELD_LABEL[field] ?? field} before={fmt(field, t ? (t as unknown as Record<string, unknown>)[field] : undefined)} after={fmt(field, after)} />
            ))}
          </div>
        </>
      );
      break;
    }
    case "create_task":
      body = (<div className="text-sm"><span className="font-semibold text-green">+ New task</span> <span className="text-header">{c.task.title}</span></div>);
      break;
    case "add_dependency":
      body = (<div className="text-sm">{label(task(c.task_id))} <span className="text-green">will depend on</span> {label(task(c.depends_on_task_id))}</div>);
      break;
    case "remove_dependency":
      body = (<div className="text-sm">{label(task(c.task_id))} <span className="text-red">no longer depends on</span> {label(task(c.depends_on_task_id))}</div>);
      break;
    case "update_milestone": {
      const m = workspace.milestones.find((x) => x.milestone_id === c.milestone_id);
      body = (
        <>
          <div className="mb-1.5 text-sm text-header">Milestone “{m?.name ?? "?"}”</div>
          <div className="space-y-1">
            {"target_at" in c.changes && <Diff label="Target" before={fmt("target_at", m?.target_at)} after={fmt("target_at", c.changes.target_at)} />}
            {"name" in c.changes && <Diff label="Name" before={fmt("title", m?.name)} after={fmt("title", c.changes.name)} />}
          </div>
        </>
      );
      break;
    }
  }
  return <li className="border-b border-line bg-bg px-3 py-2.5 last:border-b-0">{body}</li>;
}

function Diff({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <span className="rounded bg-red/10 px-1.5 py-0.5 text-red line-through decoration-red/60">{before}</span>
      <span className="text-faint">→</span>
      <span className="rounded bg-green/10 px-1.5 py-0.5 text-green">{after}</span>
    </div>
  );
}
