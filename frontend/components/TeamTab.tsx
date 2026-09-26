"use client";

import { useEffect, useMemo, useState } from "react";
import { addMember, listEvents, removeMember, updateMember } from "@/lib/api";
import type { AccessLevel, ProjectMember, ProjectWorkspace } from "@/lib/types";
import {
  boxCls,
  boxHeaderCls,
  boxTitleCls,
  buttonCls,
  inputCls,
  pillCls,
  smallButtonCls,
} from "@/lib/ui";

// Team members: who owns what, and the GitHub usernames that let Pit Crew
// attribute commits and PRs. Coordination only, no productivity stats.
export default function TeamTab({
  workspace,
  onChange,
}: {
  workspace: ProjectWorkspace;
  onChange: (w: ProjectWorkspace) => void;
}) {
  const { project, members, tasks } = workspace;
  const pid = project.project_id;
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState("");
  const [unknownActors, setUnknownActors] = useState<string[]>([]);

  // GitHub users seen in the repo who aren't on the team yet.
  useEffect(() => {
    let cancelled = false;
    listEvents(pid, { limit: 200 }).then(
      (page) => {
        if (cancelled) return;
        const known = new Set(members.map((m) => m.github_login?.toLowerCase()).filter(Boolean));
        const seen = new Set<string>();
        for (const e of page.items) if (e.actor && !known.has(e.actor.toLowerCase())) seen.add(e.actor);
        setUnknownActors([...seen].sort());
      },
      () => !cancelled && setUnknownActors([])
    );
    return () => {
      cancelled = true;
    };
  }, [pid, members]);

  async function run(fn: () => Promise<ProjectWorkspace>) {
    try {
      setError(null);
      onChange(await fn());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() && !login.trim()) return;
    const ok = await run(() =>
      addMember(pid, { display_name: name || login.replace(/^@/, ""), github_login: login || null, role_label: role || null })
    );
    if (ok) {
      setName("");
      setLogin("");
      setRole("");
    }
  }

  const owners = members.filter((m) => m.access_level === "owner").length;
  const openTasks = (id: string) =>
    tasks.filter((t) => !t.archived && t.owner_member_id === id && t.plan_status !== "complete" && t.plan_status !== "cancelled").length;
  const unassigned = tasks.filter((t) => !t.archived && !t.owner_member_id && t.plan_status !== "cancelled").length;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-6">
        {error && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-red/40 bg-red/10 px-4 py-2.5 text-sm text-red">
            <span>{error}</span>
            <button className="text-xs text-muted hover:text-header" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        <section className={boxCls}>
          <div className={boxHeaderCls}>
            <h2 className={boxTitleCls}>
              Members <span className="ml-2 rounded-full bg-btn px-1.5 text-xs font-medium text-text">{members.length}</span>
            </h2>
          </div>

          {members.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">No members yet. Add your teammates below.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Name</th>
                    <th className="px-2 py-2 font-semibold">GitHub username</th>
                    <th className="px-2 py-2 font-semibold">Role</th>
                    <th className="px-2 py-2 font-semibold">Access</th>
                    <th className="px-2 py-2 font-semibold">Open tasks</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <MemberRow key={m.member_id} m={m} openTasks={openTasks(m.member_id)}
                      isLastOwner={m.access_level === "owner" && owners === 1}
                      onPatch={(patch) => run(() => updateMember(pid, m.member_id, patch))}
                      onRemove={() => run(() => removeMember(pid, m.member_id))} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-2 border-t border-line bg-raised/50 p-4">
            <input className={`${inputCls} min-w-40 flex-1`} placeholder="Name" value={name}
              onChange={(e) => setName(e.target.value)} autoComplete="off" data-1p-ignore />
            <div className="flex min-w-40 flex-1 items-center rounded-md border border-line-strong bg-bg focus-within:border-link">
              <span className="pl-3 text-sm text-faint">@</span>
              <input className="w-full bg-transparent px-1 py-[5px] text-sm text-header placeholder:text-faint focus:outline-none"
                placeholder="github-username" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="off" data-1p-ignore />
            </div>
            <input className={`${inputCls} w-40`} placeholder="Role (optional)" value={role}
              onChange={(e) => setRole(e.target.value)} autoComplete="off" data-1p-ignore />
            <button className={buttonCls} disabled={!name.trim() && !login.trim()}>Add member</button>
          </form>
        </section>

        {unknownActors.length > 0 && (
          <section className={boxCls}>
            <div className={boxHeaderCls}>
              <h2 className={boxTitleCls}>Seen in the repository, not on the team</h2>
            </div>
            <p className="px-4 pt-3 text-sm text-muted">
              These GitHub users pushed commits or opened PRs. Add them so their work is attributed to a teammate.
            </p>
            <ul className="p-4 pt-2">
              {unknownActors.map((a) => (
                <li key={a} className="flex items-center justify-between border-b border-line py-2 last:border-b-0">
                  <span className="font-mono text-sm text-header">@{a}</span>
                  <button className={smallButtonCls}
                    onClick={() => run(() => addMember(pid, { display_name: a, github_login: a }))}>
                    Add to team
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="space-y-4 text-sm">
        <section>
          <h3 className="mb-2 text-base font-semibold text-header">About the team</h3>
          <p className="text-muted">
            GitHub usernames are how Pit Crew knows who pushed a commit or opened a PR. Anyone without one shows up as an
            unknown contributor.
          </p>
        </section>
        <section className="border-t border-line pt-4">
          <ul className="space-y-1.5 text-muted">
            <li><span className="font-semibold text-header">{unassigned}</span> task{unassigned === 1 ? "" : "s"} without an owner</li>
            <li><span className="font-semibold text-header">{members.filter((m) => !m.github_login).length}</span> member{members.filter((m) => !m.github_login).length === 1 ? "" : "s"} without a GitHub username</li>
          </ul>
        </section>
        <section className="border-t border-line pt-4 text-xs text-faint">
          Pit Crew tracks ownership for coordination. It never scores or ranks teammates.
        </section>
      </aside>
    </div>
  );
}

const ACCESS: AccessLevel[] = ["owner", "editor", "viewer"];

function MemberRow({
  m,
  openTasks,
  isLastOwner,
  onPatch,
  onRemove,
}: {
  m: ProjectMember;
  openTasks: number;
  isLastOwner: boolean;
  onPatch: (p: Partial<{ display_name: string; github_login: string | null; role_label: string | null; access_level: AccessLevel }>) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const initial = useMemo(() => (m.display_name || m.github_login || "?").slice(0, 1).toUpperCase(), [m]);
  const cell = `${inputCls} w-full !py-1`;

  return (
    <tr className="border-b border-line align-middle last:border-b-0 hover:bg-raised/60">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-btn text-xs font-semibold text-header">{initial}</span>
          <input key={m.display_name} className={cell} defaultValue={m.display_name} autoComplete="off" data-1p-ignore
            onBlur={(e) => e.target.value.trim() && e.target.value !== m.display_name && onPatch({ display_name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center rounded-md border border-line-strong bg-bg focus-within:border-link">
          <span className="pl-2.5 text-sm text-faint">@</span>
          <input key={m.github_login ?? ""} className="w-full bg-transparent px-1 py-1 text-sm text-header placeholder:text-faint focus:outline-none"
            defaultValue={m.github_login ?? ""} placeholder="add username" autoComplete="off" data-1p-ignore
            onBlur={(e) => {
              const v = e.target.value.trim().replace(/^@/, "");
              if (v !== (m.github_login ?? "")) onPatch({ github_login: v || null });
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
      </td>
      <td className="px-2 py-2">
        <input key={m.role_label ?? ""} className={cell} defaultValue={m.role_label ?? ""} placeholder="e.g. Frontend"
          autoComplete="off" data-1p-ignore
          onBlur={(e) => e.target.value.trim() !== (m.role_label ?? "") && onPatch({ role_label: e.target.value.trim() || null })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      </td>
      <td className="px-2 py-2">
        <select className={cell} value={m.access_level} disabled={isLastOwner}
          title={isLastOwner ? "A project needs at least one owner" : undefined}
          onChange={(e) => onPatch({ access_level: e.target.value as AccessLevel })}>
          {ACCESS.map((a) => (<option key={a} value={a}>{a[0].toUpperCase() + a.slice(1)}</option>))}
        </select>
      </td>
      <td className="px-2 py-2 text-muted">{openTasks}</td>
      <td className="px-4 py-2 text-right">
        {isLastOwner ? (
          <span className={pillCls}>Owner</span>
        ) : confirming ? (
          <span className="flex items-center justify-end gap-2 text-xs">
            <span className="text-muted">{openTasks ? `${openTasks} task${openTasks === 1 ? "" : "s"} become unassigned.` : "Remove?"}</span>
            <button className="font-semibold text-red hover:underline" onClick={onRemove}>Remove</button>
            <button className="text-muted hover:text-header" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        ) : (
          <button className="text-xs text-muted hover:text-red" onClick={() => setConfirming(true)}>Remove</button>
        )}
      </td>
    </tr>
  );
}
