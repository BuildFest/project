"use client";

import { useCallback, useEffect, useState } from "react";
import { addMember, listEvents, removeMember, updateMember, type MemberInput } from "@/lib/api";
import type { AccessLevel, ProjectMember, ProjectWorkspace } from "@/lib/types";
import { buttonCls, inputCls, timeAgo } from "@/lib/ui";

type MemberPatch = Partial<MemberInput>;
type Mutate = (fn: () => Promise<ProjectWorkspace>) => Promise<void>;
type LastSeen = { at: string; branch: string | null };
type RepoActivity =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; unknown: string[]; lastSeen: Record<string, LastSeen> };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const sectionLabelCls = "text-xs font-semibold uppercase tracking-[.14em] text-faint";

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
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activity, setActivity] = useState<RepoActivity>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // Recent repository events: each member's latest activity, plus GitHub
  // users who aren't on the team yet. Events arrive newest first.
  useEffect(() => {
    let cancelled = false;
    listEvents(pid, { limit: 200 }).then(
      (page) => {
        if (cancelled) return;
        const known = new Set(members.map((m) => m.github_login?.toLowerCase()).filter(Boolean));
        const unknown = new Set<string>();
        const lastSeen: Record<string, LastSeen> = {};
        for (const e of page.items) {
          if (!e.actor) continue;
          const login = e.actor.toLowerCase();
          if (!known.has(login)) unknown.add(e.actor);
          else if (!lastSeen[login]) lastSeen[login] = { at: e.occurred_at, branch: e.branch };
        }
        setActivity({ status: "ready", unknown: [...unknown].sort(), lastSeen });
      },
      () => !cancelled && setActivity({ status: "error" })
    );
    return () => {
      cancelled = true;
    };
  }, [pid, members, attempt]);

  // Throws on failure so each form can show the error next to itself.
  const mutate: Mutate = useCallback(async (fn) => onChange(await fn()), [onChange]);

  const owners = members.filter((m) => m.access_level === "owner").length;
  const openTasks = (id: string) =>
    tasks.filter((t) => !t.archived && t.owner_member_id === id && t.plan_status !== "complete" && t.plan_status !== "cancelled").length;
  const unassigned = tasks.filter((t) => !t.archived && !t.owner_member_id && t.plan_status !== "cancelled" && t.plan_status !== "complete").length;
  const withoutLogin = members.filter((m) => !m.github_login).length;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line-strong pb-5">
        <div>
          <h2 className="text-xl font-semibold text-header">Team</h2>
          <p className="mt-1 text-sm text-muted">Who&apos;s on the project, and how their GitHub activity is attributed.</p>
        </div>
        {!adding && <button className={buttonCls} onClick={() => setAdding(true)}>Add member</button>}
      </header>

      <ul className="flex flex-wrap gap-x-6 gap-y-2 border-b border-line py-4 text-sm text-muted">
        <HealthItem ok={unassigned === 0} count={unassigned} label={`open task${unassigned === 1 ? "" : "s"} without an owner`} />
        <HealthItem ok={withoutLogin === 0} count={withoutLogin} label={`member${withoutLogin === 1 ? "" : "s"} without a GitHub username`} />
        {activity.status === "ready" && (
          <HealthItem ok={activity.unknown.length === 0} count={activity.unknown.length}
            label={`contributor${activity.unknown.length === 1 ? "" : "s"} not on the team`} />
        )}
      </ul>

      <section className="border-b border-line pt-6">
        <h3 className={sectionLabelCls}>Members · {members.length}</h3>
        {members.length > 0 && <ColumnHeader />}
        <ul className="divide-y divide-line">
          {adding && (
            <AddMemberForm
              onCancel={() => setAdding(false)}
              onAdd={async (input) => {
                await mutate(() => addMember(pid, input));
                setAdding(false);
              }} />
          )}
          {members.map((m) =>
            editingId === m.member_id ? (
              <EditMemberForm key={m.member_id} m={m} openTasks={openTasks(m.member_id)}
                isLastOwner={m.access_level === "owner" && owners === 1}
                onCancel={() => setEditingId(null)}
                onSave={async (patch) => {
                  await mutate(() => updateMember(pid, m.member_id, patch));
                  setEditingId(null);
                }}
                onRemove={async () => {
                  await mutate(() => removeMember(pid, m.member_id));
                  setEditingId(null);
                }} />
            ) : (
              <MemberRow key={m.member_id} m={m} openTasks={openTasks(m.member_id)} activity={activity}
                onEdit={() => setEditingId(m.member_id)} />
            )
          )}
        </ul>
        {members.length === 0 && !adding && (
          <div className="py-16 text-center">
            <div className="mx-auto mb-3 h-8 w-px bg-line-strong" />
            <p className="font-medium text-header">No teammates yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
              Add the people on this project with their GitHub usernames so Pit Crew can connect their commits and PRs to the plan.
            </p>
            <button className={`${buttonCls} mt-4`} onClick={() => setAdding(true)}>Add member</button>
          </div>
        )}
      </section>

      <RepositoryContributors activity={activity}
        onRetry={() => { setActivity({ status: "loading" }); setAttempt((n) => n + 1); }}
        onAdd={(login) => mutate(() => addMember(pid, { display_name: login, github_login: login }))} />

      <p className="py-6 text-xs text-faint">Pit Crew tracks ownership for coordination. It never scores or ranks teammates.</p>
    </div>
  );
}

function HealthItem({ ok, count, label }: { ok: boolean; count: number; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${ok ? "bg-green" : "bg-yellow"}`} aria-hidden />
      <span><span className="font-semibold text-header">{count}</span> {label}</span>
    </li>
  );
}

// ---- member row ---------------------------------------------------------------

// Shared by the column header and each row so they stay aligned.
const ROW_GRID = "sm:grid sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_5.5rem_minmax(0,1fr)_5rem_2.5rem] sm:items-center sm:gap-4";

// A stable colour per member, so the same person reads the same everywhere on the page.
const TONES = [
  { tile: "bg-blue/15 text-blue", text: "text-blue" },
  { tile: "bg-green/15 text-green", text: "text-green" },
  { tile: "bg-purple/15 text-purple", text: "text-purple" },
  { tile: "bg-signal/20 text-tab", text: "text-tab" },
];
function toneFor(id: string) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ColumnHeader() {
  return (
    <div className={`hidden pb-2 pt-4 text-[11px] font-semibold uppercase tracking-[.14em] text-faint ${ROW_GRID}`}>
      <span>Member</span>
      <span>GitHub</span>
      <span>Access</span>
      <span>Last active</span>
      <span className="text-right">Open tasks</span>
      <span />
    </div>
  );
}

function MemberRow({ m, openTasks, activity, onEdit }: {
  m: ProjectMember; openTasks: number; activity: RepoActivity; onEdit: () => void;
}) {
  const tone = toneFor(m.member_id);
  const seen = activity.status === "ready" && m.github_login ? activity.lastSeen[m.github_login.toLowerCase()] : undefined;

  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 py-4 ${ROW_GRID}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold ${tone.tile}`} aria-hidden>
          {initials(m.display_name)}
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold text-header">{m.display_name}</p>
          <p className="truncate text-xs">
            <span className={m.role_label ? tone.text : "text-faint"}>{m.role_label ?? "No role"}</span>
            {m.access_level === "owner" && <span className="text-faint"> · Owner</span>}
          </p>
        </div>
      </div>

      <button className="self-center text-xs font-medium text-muted hover:text-header sm:order-last sm:justify-self-end"
        onClick={onEdit} aria-label={`Edit ${m.display_name}`}>
        Edit
      </button>

      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 pl-12 text-sm sm:contents">
        <div className="min-w-0 truncate">
          {m.github_login ? (
            <a href={`https://github.com/${encodeURIComponent(m.github_login)}`} target="_blank" rel="noreferrer"
              className="font-mono text-muted hover:text-link">{m.github_login}</a>
          ) : (
            <button className="inline-flex items-center gap-1.5 text-xs text-yellow hover:underline" onClick={onEdit}>
              <span className="h-1.5 w-1.5 rounded-full bg-yellow" aria-hidden />
              Add username
            </button>
          )}
        </div>
        <span className="text-text">{capitalize(m.access_level)}</span>
        <div className="min-w-0">
          {!m.github_login ? (
            <span className="text-faint">—</span>
          ) : activity.status === "loading" ? (
            <span className="block h-3 w-20 animate-pulse rounded bg-raised" aria-label="Loading activity" />
          ) : seen ? (
            <p className="truncate">
              <span className="text-text">{timeAgo(seen.at)}</span>
              {seen.branch && <span className="font-mono text-xs text-faint"> · {seen.branch}</span>}
            </p>
          ) : (
            <span className="text-faint">{activity.status === "error" ? "Unavailable" : "No recent activity"}</span>
          )}
        </div>
        <span className={`font-mono sm:text-right ${openTasks ? "text-header" : "text-faint"}`}>
          {openTasks}<span className="font-sans text-xs text-faint sm:hidden"> open tasks</span>
        </span>
      </div>
    </li>
  );
}

// ---- repository contributors ---------------------------------------------------

function RepositoryContributors({
  activity,
  onRetry,
  onAdd,
}: {
  activity: RepoActivity;
  onRetry: () => void;
  onAdd: (login: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(login: string) {
    setPending(login);
    setError(null);
    try {
      await onAdd(login);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(null);
    }
  }

  // Nothing worth a section: the team already covers everyone in the repo.
  if (activity.status === "ready" && activity.unknown.length === 0) return null;

  return (
    <section className="border-b border-line py-6">
      <h3 className={`${sectionLabelCls} mb-3`}>Not on the team yet</h3>
      {activity.status === "loading" ? (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-transparent" aria-hidden />
          Checking recent repository activity…
        </p>
      ) : activity.status === "error" ? (
        <p className="flex items-center gap-3 text-sm">
          <span className="text-red">Couldn&apos;t load repository activity.</span>
          <button className="text-xs font-medium text-link hover:underline" onClick={onRetry}>Try again</button>
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">
            These GitHub users pushed commits or opened PRs. Add them so their work is attributed to a teammate.
          </p>
          {error && <p className="mt-2 text-sm text-red" role="alert">{error}</p>}
          <ul className="mt-3 flex flex-wrap gap-2">
            {activity.unknown.map((login) => (
              <li key={login} className="inline-flex items-center gap-3 rounded-md bg-raised px-3 py-1.5 text-sm">
                <span className="font-mono text-header">{login}</span>
                <button className="text-xs font-medium text-tab hover:underline disabled:opacity-50" disabled={pending !== null}
                  onClick={() => void add(login)}>
                  {pending === login ? "Adding…" : "Add"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---- forms ----------------------------------------------------------------------

const ACCESS: AccessLevel[] = ["owner", "editor", "viewer"];
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
const fieldLabelCls = "mb-1 block text-xs font-medium text-muted";
const formCls = "space-y-3 rounded-md border-l-2 border-signal bg-raised/50 px-4 py-4";
const textButtonCls = "px-2 text-sm text-muted hover:text-header disabled:opacity-50";

function LoginInput({ value, onChange, disabled, autoFocus }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; autoFocus?: boolean;
}) {
  return (
    <div className="flex items-center rounded-md border border-line-strong bg-bg focus-within:border-link focus-within:ring-1 focus-within:ring-link">
      <span className="pl-3 text-sm text-faint">@</span>
      <input className="w-full bg-transparent px-1 py-[5px] text-sm text-header placeholder:text-faint focus:outline-none disabled:opacity-60"
        placeholder="github-username" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
        autoFocus={autoFocus} autoComplete="off" data-1p-ignore />
    </div>
  );
}

// Runs a form action, tracking which one is in flight and keeping its error.
function useFormAction<A extends string>() {
  const [busy, setBusy] = useState<A | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(action: A, fn: () => Promise<void>) {
    setBusy(action);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, run };
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-red" role="alert">{message}</p>;
}

function EditMemberForm({
  m,
  openTasks,
  isLastOwner,
  onCancel,
  onSave,
  onRemove,
}: {
  m: ProjectMember;
  openTasks: number;
  isLastOwner: boolean;
  onCancel: () => void;
  onSave: (patch: MemberPatch) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [name, setName] = useState(m.display_name);
  const [login, setLogin] = useState(m.github_login ?? "");
  const [role, setRole] = useState(m.role_label ?? "");
  const [access, setAccess] = useState<AccessLevel>(m.access_level);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useFormAction<"save" | "remove">();

  const patch: MemberPatch = {};
  if (name.trim() !== m.display_name) patch.display_name = name.trim();
  const cleanLogin = login.trim().replace(/^@/, "");
  if (cleanLogin !== (m.github_login ?? "")) patch.github_login = cleanLogin || null;
  if (role.trim() !== (m.role_label ?? "")) patch.role_label = role.trim() || null;
  if (access !== m.access_level) patch.access_level = access;
  const dirty = Object.keys(patch).length > 0;
  const locked = busy !== null;

  return (
    <li className="py-4">
      <form className={formCls}
        onSubmit={(e) => { e.preventDefault(); if (dirty && name.trim() && !locked) void run("save", () => onSave(patch)); }}
        onKeyDown={(e) => e.key === "Escape" && !locked && onCancel()}>
        <p className="text-sm font-semibold text-header">Edit {m.display_name}</p>
        <fieldset disabled={locked} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_8rem]">
          <label>
            <span className={fieldLabelCls}>Name</span>
            <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} autoFocus
              autoComplete="off" data-1p-ignore />
            {!name.trim() && <span className="mt-1 block text-xs text-red">Name can&apos;t be empty.</span>}
          </label>
          <div>
            <span className={fieldLabelCls}>GitHub username</span>
            <LoginInput value={login} onChange={setLogin} disabled={locked} />
          </div>
          <label>
            <span className={fieldLabelCls}>Role</span>
            <input className={`${inputCls} w-full`} value={role} placeholder="e.g. Frontend" onChange={(e) => setRole(e.target.value)}
              autoComplete="off" data-1p-ignore />
          </label>
          <label>
            <span className={fieldLabelCls}>Access</span>
            <select className={`${inputCls} w-full`} value={access} disabled={isLastOwner || locked}
              title={isLastOwner ? "A project needs at least one owner" : undefined}
              onChange={(e) => setAccess(e.target.value as AccessLevel)}>
              {ACCESS.map((a) => <option key={a} value={a}>{capitalize(a)}</option>)}
            </select>
          </label>
        </fieldset>
        <FormError message={error} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          {isLastOwner ? (
            <span className="text-xs text-faint">The last owner can&apos;t be removed.</span>
          ) : confirming ? (
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="text-muted">{openTasks ? `${openTasks} task${openTasks === 1 ? "" : "s"} become unassigned.` : "Remove?"}</span>
              <button type="button" className="font-semibold text-red hover:underline disabled:opacity-50" disabled={locked}
                onClick={() => void run("remove", onRemove)}>
                {busy === "remove" ? "Removing…" : "Remove"}
              </button>
              <button type="button" className="text-muted hover:text-header disabled:opacity-50" disabled={locked}
                onClick={() => setConfirming(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="text-xs text-muted hover:text-red disabled:opacity-50" disabled={locked}
              onClick={() => setConfirming(true)}>Remove from team</button>
          )}
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className={textButtonCls} disabled={locked} onClick={onCancel}>Cancel</button>
            <button className={buttonCls} disabled={!dirty || !name.trim() || locked}>{busy === "save" ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </form>
    </li>
  );
}

function AddMemberForm({ onCancel, onAdd }: { onCancel: () => void; onAdd: (input: MemberInput) => Promise<void> }) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState("");
  const { busy, error, run } = useFormAction<"add">();
  const cleanLogin = login.trim().replace(/^@/, "");
  const ready = !!(name.trim() || cleanLogin);
  const locked = busy !== null;

  return (
    <li className="py-4">
      <form className={formCls}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || locked) return;
          void run("add", () => onAdd({ display_name: name.trim() || cleanLogin, github_login: cleanLogin || null, role_label: role.trim() || null }));
        }}
        onKeyDown={(e) => e.key === "Escape" && !locked && onCancel()}>
        <p className="text-sm font-semibold text-header">New member</p>
        <fieldset disabled={locked} className="grid gap-3 sm:grid-cols-3">
          <div>
            <span className={fieldLabelCls}>GitHub username</span>
            <LoginInput value={login} onChange={setLogin} disabled={locked} autoFocus />
          </div>
          <label>
            <span className={fieldLabelCls}>Name</span>
            <input className={`${inputCls} w-full`} value={name} placeholder={cleanLogin || "Full name"}
              onChange={(e) => setName(e.target.value)} autoComplete="off" data-1p-ignore />
          </label>
          <label>
            <span className={fieldLabelCls}>Role <span className="text-faint">(optional)</span></span>
            <input className={`${inputCls} w-full`} value={role} placeholder="e.g. Frontend"
              onChange={(e) => setRole(e.target.value)} autoComplete="off" data-1p-ignore />
          </label>
        </fieldset>
        <FormError message={error} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-faint">{ready ? "" : "Enter a GitHub username or a name."}</span>
          <div className="flex items-center gap-2">
            <button type="button" className={textButtonCls} disabled={locked} onClick={onCancel}>Cancel</button>
            <button className={buttonCls} disabled={!ready || locked}>{busy === "add" ? "Adding…" : "Add member"}</button>
          </div>
        </div>
      </form>
    </li>
  );
}
