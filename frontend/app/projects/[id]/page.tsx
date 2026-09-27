"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import ActivityTab from "@/components/ActivityTab";
import BriefEditor from "@/components/BriefEditor";
import ActingAs from "@/components/ActingAs";
import MilestoneEditor from "@/components/MilestoneEditor";
import Overview from "@/components/Overview";
import PlanTable from "@/components/PlanTable";
import PlanVersionBar from "@/components/PlanVersionBar";
import TeamTab from "@/components/TeamTab";
import { getProject } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";
import { IconChecklist, IconCommit, IconPeople, IconProject, IconPulse } from "@/components/Icons";
import { pillCls } from "@/lib/ui";

type Tab = "overview" | "plan" | "activity" | "team";
const TABS: Tab[] = ["overview", "plan", "activity", "team"];

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  // undefined = loading, null = not found
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Tab lives in the URL hash (#activity) so refresh/links keep it.
  const [tab, setTab] = useState<Tab>(() => {
    const h = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    return (TABS as string[]).includes(h) ? (h as Tab) : "overview";
  });

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

  const { project, tasks } = workspace;
  const active = tasks.filter((t) => !t.archived);

  const TABS_UI: { key: Tab; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: "overview", label: "Overview", icon: <IconPulse /> },
    { key: "plan", label: "Plan", icon: <IconChecklist />, count: active.length },
    { key: "activity", label: "Updates", icon: <IconCommit /> },
    { key: "team", label: "Team", icon: <IconPeople />, count: workspace.members.length },
  ];

  return (
    <>
      {/* Project header — continues the dark top bar, like a GitHub repo header */}
      <div className="border-b border-line-strong bg-topbar">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
            <div className="flex min-w-0 items-center gap-2 text-base">
              <IconProject className="shrink-0 text-muted" />
              <Link href="/" className="text-header hover:text-link hover:underline">Projects</Link>
              <span className="text-muted">/</span>
              <span className="truncate font-semibold text-header">{project.name}</span>
              <span className={pillCls}>{project.task_key_prefix}</span>
            </div>
            <ActingAs workspace={workspace} />
          </div>

          <nav className="-mb-px flex gap-2 overflow-x-auto">
            {TABS_UI.map((t) => (
              <button key={t.key} onClick={() => selectTab(t.key)}
                className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-2 pb-2 pt-1 text-sm ${
                  tab === t.key ? "border-tab font-semibold text-header" : "border-transparent text-text"
                }`}>
                <span className="text-muted">{t.icon}</span>
                <span className="rounded-md px-1 py-0.5 hover:bg-btn">{t.label}</span>
                {t.count !== undefined && (
                  <span className="rounded-full bg-btn px-1.5 text-xs font-medium text-text">{t.count}</span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-6">
        {tab === "overview" ? (
          <Overview workspace={workspace} onWorkspaceChange={setWorkspace} />
        ) : tab === "plan" ? (
          <>
            <div className="grid gap-6 lg:grid-cols-2">
              <BriefEditor workspace={workspace} onChange={setWorkspace} />
              <MilestoneEditor workspace={workspace} onChange={setWorkspace} />
            </div>
            <PlanVersionBar workspace={workspace} onChange={setWorkspace} />
            <PlanTable workspace={workspace} onChange={setWorkspace} />
          </>
        ) : tab === "activity" ? (
          <ActivityTab workspace={workspace} />
        ) : (
          <TeamTab workspace={workspace} onChange={setWorkspace} />
        )}
      </main>
    </>
  );
}
