"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createProject, listProjects } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";

// "Rameez @rameez-gh, Divij @divij" -> [{display_name, github_login}]
function parseTeam(raw: string) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, login] = entry.split("@").map((s) => s.trim());
      return { display_name: name || login, github_login: login || null };
    });
}

export default function Home() {
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[]>([]);
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("PC");
  const [team, setTeam] = useState("");
  const [deadline, setDeadline] = useState("");
  const [brief, setBrief] = useState("");

  useEffect(() => {
    listProjects().then(setWorkspaces);
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    await createProject({
      name: name.trim(),
      task_key_prefix: prefix.trim().toUpperCase(),
      deadline_at: deadline ? new Date(deadline).toISOString() : null,
      members: parseTeam(team),
      brief,
    });
    setWorkspaces(await listProjects());
    setName("");
    setTeam("");
    setDeadline("");
    setBrief("");
  }

  const input =
    "w-full rounded-sm border border-line bg-surface p-2 text-sm";
  const label = "block font-display text-xs font-semibold uppercase tracking-[0.12em] text-muted";

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-8">
      <header>
        <h1 className="font-display text-5xl font-bold uppercase tracking-wide leading-none border-l-4 border-signal pl-3">Pit Crew</h1>
        <p className="text-sm text-muted">
          Your plan, connected to what&apos;s actually happening in the repo.
        </p>
      </header>

      <form
        onSubmit={handleCreate}
        className="space-y-3 rounded-sm border border-line bg-surface p-4"
      >
        <h2 className="font-display text-lg font-semibold uppercase tracking-wider">New project</h2>

        <div className="flex gap-3">
          <label className={`${label} flex-1`}>
            Project name
            <input className={`${input} mt-1`} placeholder="Pit Crew" value={name}
              onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className={`${label} w-28`}>
            Task prefix
            <input className={`${input} mt-1 uppercase`} placeholder="PC" value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              pattern="[A-Za-z][A-Za-z0-9]{0,9}" title="Letters/numbers, starts with a letter, max 10"
              required />
          </label>
        </div>

        <label className={label}>
          Team (name @github-username, comma-separated)
          <input className={`${input} mt-1`} placeholder="Rameez @rameez, Divij @divij" value={team}
            onChange={(e) => setTeam(e.target.value)} />
        </label>

        <label className={label}>
          Deadline / target milestone
          <input className={`${input} mt-1`} type="datetime-local" value={deadline}
            onChange={(e) => setDeadline(e.target.value)} required />
        </label>

        <label className={label}>
          Project brief (markdown)
          <textarea className={`${input} mt-1 h-32`} value={brief}
            onChange={(e) => setBrief(e.target.value)} />
        </label>

        <button className="rounded-sm bg-signal px-4 py-2 text-sm text-signal-ink">
          Create project
        </button>
      </form>

      <section>
        <h2 className="mb-2 font-display text-lg font-semibold uppercase tracking-wider">Projects</h2>
        {workspaces.length === 0 && (
          <p className="text-sm text-muted">No projects yet — create one above.</p>
        )}
        {workspaces.map(({ project, members }) => (
          <Link key={project.project_id} href={`/projects/${project.project_id}`}
            className="mb-2 block rounded-sm border border-line p-3 hover:border-signal">
            <div className="font-medium">
              {project.name}{" "}
              <span className="ml-1 rounded-sm border border-line px-1.5 py-0.5 font-mono text-xs text-muted">
                {project.task_key_prefix}
              </span>
            </div>
            <div className="text-sm text-muted">
              {members.map((m) => m.display_name).join(", ") || "No team yet"}
              {project.deadline_at && ` · due ${new Date(project.deadline_at).toLocaleString()}`}
            </div>
          </Link>
        ))}
      </section>
    </main>
  );
}
