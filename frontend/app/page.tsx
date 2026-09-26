"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listProjects } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";
import { boxCls, boxHeaderCls, boxTitleCls, buttonCls, formatDate } from "@/lib/ui";

export default function Home() {
  // undefined = still loading from storage
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects().then(
      (ws) => setWorkspaces(ws),
      (e) => setError(e instanceof Error ? e.message : "Couldn't load projects.")
    );
  }, []);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-header">Projects</h1>
          <p className="text-sm text-muted">
            Your plan, connected to what&apos;s actually happening in the repo.
          </p>
        </div>
        <Link href="/new" className={buttonCls}>New project</Link>
      </div>

      <section className={boxCls}>
        <div className={boxHeaderCls}>
          <h2 className={boxTitleCls}>Your projects</h2>
          <span className="text-xs text-muted">{workspaces?.length ?? ""}</span>
        </div>

        {error ? (
          <div className="px-4 py-10 text-center">
            <p className="font-semibold text-red">Can&apos;t load projects</p>
            <p className="mt-1 text-sm text-muted">{error}</p>
            <p className="mt-3 text-xs text-faint">
              To use sample data instead, delete <span className="font-mono">frontend/.env.local</span> and restart{" "}
              <span className="font-mono">npm run dev</span>.
            </p>
          </div>
        ) : workspaces === undefined ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Loading…</p>
        ) : workspaces.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="font-semibold text-header">No projects yet</p>
            <p className="mt-1 text-sm text-muted">Create a project to write your plan and track it against GitHub.</p>
            <Link href="/new" className={`${buttonCls} mt-4 inline-block`}>Create your first project</Link>
          </div>
        ) : (
          <ul>
            {workspaces.map(({ project, members, tasks }) => {
              const active = tasks.filter((t) => !t.archived);
              const done = active.filter((t) => t.plan_status === "complete").length;
              const pct = active.length ? Math.round((done / active.length) * 100) : 0;
              return (
                <li key={project.project_id} className="border-b border-line last:border-b-0">
                  <Link href={`/projects/${project.project_id}`}
                    className="flex items-center justify-between gap-6 px-4 py-3 hover:bg-raised">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-link">{project.name}</span>
                        <span className="rounded-full border border-line px-2 font-mono text-xs text-muted">
                          {project.task_key_prefix}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs text-muted">
                        {members.map((m) => m.display_name).join(", ") || "No team yet"}
                        {" · "}due {formatDate(project.deadline_at)}
                      </div>
                    </div>
                    <div className="w-36 shrink-0">
                      <div className="mb-1 text-right text-xs text-muted">
                        {done}/{active.length} tasks
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-line">
                        <div className="h-full rounded-full bg-green" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
