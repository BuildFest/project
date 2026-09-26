"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import BriefEditor from "@/components/BriefEditor";
import MilestoneEditor from "@/components/MilestoneEditor";
import PlanTable from "@/components/PlanTable";
import { getProject } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";
import { formatDate } from "@/lib/ui";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  // undefined = loading, null = not found
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null | undefined>(undefined);

  useEffect(() => {
    getProject(id).then((w) => setWorkspace(w ?? null));
  }, [id]);

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

      <div className="grid gap-6 lg:grid-cols-2">
        <BriefEditor workspace={workspace} onChange={setWorkspace} />
        <MilestoneEditor workspace={workspace} onChange={setWorkspace} />
      </div>

      <PlanTable workspace={workspace} onChange={setWorkspace} />
    </main>
  );
}
