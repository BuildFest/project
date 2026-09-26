"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import ActivityTimeline from "@/components/ActivityTimeline";
import BriefEditor from "@/components/BriefEditor";
import MilestoneEditor from "@/components/MilestoneEditor";
import PlanTable from "@/components/PlanTable";
import { getProject } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";
import { formatDate } from "@/lib/ui";

type Tab = "plan" | "activity";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  // undefined = loading, null = not found
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Tab lives in the URL hash (#activity) so refresh/links keep it.
  const [tab, setTab] = useState<Tab>(() =>
    typeof window !== "undefined" && window.location.hash === "#activity" ? "activity" : "plan"
  );

  useEffect(() => {
    getProject(id)
      .then((w) => setWorkspace(w ?? null))
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load project."));
  }, [id]);

  function selectTab(t: Tab) {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  }

  if (loadError) {
    return (
      <main className="mx-auto w-full max-w-7xl px-6 py-8">
        <div className="rounded-md border border-red/40 bg-red/10 px-4 py-3 text-sm text-red">{loadError}</div>
      </main>
    );
  }

  if (workspace === undefined) {
    return <main className="mx-auto w-full max-w-7xl px-6 py-8 text-sm text-muted">Loading project…</main>;
  }

  if (workspace === null) {
    return (
      <main className="mx-auto w-full max-w-7xl space-y-3 px-6 py-8">
        <p className="text-header">Project not found.</p>
        <Link href="/" className="text-sm text-link hover:underline">← All projects</Link>
      </main>
    );
  }

  const { project, members, tasks } = workspace;
  const active = tasks.filter((t) => !t.archived);
  const done = active.filter((t) => t.plan_status === "complete").length;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      <header>
        <nav className="mb-2 text-sm text-muted">
          <Link href="/" className="text-link hover:underline">Projects</Link>
          <span className="mx-1.5">/</span>
          <span className="font-semibold text-header">{project.name}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-header">{project.name}</h1>
          <span className="rounded-full border border-line px-2 font-mono text-xs text-muted">
            {project.task_key_prefix}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted">
          {members
            .map((m) => (m.github_login ? `${m.display_name} (@${m.github_login})` : m.display_name))
            .join(", ") || "No team yet"}
          {" · "}due {formatDate(project.deadline_at)}
          {" · "}{done}/{active.length} tasks complete
        </p>
      </header>

      {/* GitHub-style underline tabs */}
      <nav className="flex gap-1 border-b border-line">
        {([
          ["plan", "Plan", active.length],
          ["activity", "Activity", null],
        ] as const).map(([key, label, count]) => (
          <button key={key} onClick={() => selectTab(key)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${
              tab === key
                ? "border-signal font-semibold text-header"
                : "border-transparent text-muted hover:border-line-strong hover:text-text"
            }`}>
            {label}
            {count !== null && (
              <span className="rounded-full bg-line px-1.5 text-xs text-muted">{count}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === "plan" ? (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <BriefEditor workspace={workspace} onChange={setWorkspace} />
            <MilestoneEditor workspace={workspace} onChange={setWorkspace} />
          </div>
          <PlanTable workspace={workspace} onChange={setWorkspace} />
        </>
      ) : (
        <ActivityTimeline workspace={workspace} />
      )}
    </main>
  );
}
