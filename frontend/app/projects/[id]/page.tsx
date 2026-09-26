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
    return <main className="p-8 text-sm text-muted">Loading project…</main>;
  }

  if (workspace === null) {
    return (
      <main className="mx-auto max-w-2xl space-y-3 p-8">
        <p>Project not found.</p>
        <Link href="/" className="text-sm text-signal hover:underline">← All projects</Link>
      </main>
    );
  }

  const { project, members, tasks } = workspace;
  const active = tasks.filter((t) => !t.archived);
  const done = active.filter((t) => t.plan_status === "complete").length;

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-8">
      <header className="space-y-1">
        <Link href="/" className="text-sm text-muted hover:underline">← All projects</Link>
        <h1 className="font-display text-5xl font-bold uppercase tracking-wide leading-none border-l-4 border-signal pl-3">
          {project.name}{" "}
          <span className="align-middle rounded-sm border border-line px-2 py-0.5 font-mono text-sm font-normal normal-case tracking-normal text-muted">
            {project.task_key_prefix}
          </span>
        </h1>
        <p className="text-sm text-muted">
          {members.map((m) => (m.github_login ? `${m.display_name} (@${m.github_login})` : m.display_name)).join(", ") || "No team yet"}
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
