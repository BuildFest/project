"use client";

import { useEffect, useState } from "react";
import { createProject, listProjects } from "@/lib/api";
import { Project } from "@/lib/types";

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [deadline, setDeadline] = useState("");
  const [brief, setBrief] = useState("");

  useEffect(() => {
    listProjects().then(setProjects);
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    await createProject({
      name: name.trim(),
      team: team.split(",").map((s) => s.trim()).filter(Boolean),
      deadline: new Date(deadline).toISOString(),
      brief,
    });
    setProjects(await listProjects());
    setName("");
    setTeam("");
    setDeadline("");
    setBrief("");
  }

  const input =
    "w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-8">
      <header>
        <h1 className="text-3xl font-bold">Pit Crew</h1>
        <p className="text-sm text-zinc-500">
          Your plan, connected to what&apos;s actually happening in the repo.
        </p>
      </header>

      <form
        onSubmit={handleCreate}
        className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <h2 className="font-semibold">New project</h2>
        <input className={input} placeholder="Project name" value={name}
          onChange={(e) => setName(e.target.value)} required />
        <input className={input} placeholder="Team (comma-separated)" value={team}
          onChange={(e) => setTeam(e.target.value)} />
        <label className="block text-sm text-zinc-500">
          Deadline / target milestone
          <input className={`${input} mt-1`} type="datetime-local" value={deadline}
            onChange={(e) => setDeadline(e.target.value)} required />
        </label>
        <textarea className={`${input} h-32`} placeholder="Project brief (markdown)"
          value={brief} onChange={(e) => setBrief(e.target.value)} />
        <button className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-zinc-900">
          Create project
        </button>
      </form>

      <section>
        <h2 className="mb-2 font-semibold">Projects</h2>
        {projects.length === 0 && (
          <p className="text-sm text-zinc-500">No projects yet — create one above.</p>
        )}
        {projects.map((p) => (
          <div key={p.id} className="mb-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="font-medium">{p.name}</div>
            <div className="text-sm text-zinc-500">
              {p.team.join(", ") || "No team yet"} · due {new Date(p.deadline).toLocaleString()}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
