"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createProject } from "@/lib/api";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/lib/ui";

type MemberDraft = { display_name: string; github_login: string };

// "Pit Crew" -> "PC", "BadgerPlay" -> "BP", "api" -> "API"
function suggestPrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  let p =
    words.length > 1
      ? words.map((w) => w[0]).join("")
      : (name.match(/[A-Z]/g)?.join("") ?? "").length > 1
        ? name.match(/[A-Z]/g)!.join("")
        : name.slice(0, 3);
  p = p.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]/.test(p)) p = "P" + p;
  return p.slice(0, 6);
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className={labelCls}>
        {label}
        {required && <span className="ml-0.5 text-red">*</span>}
      </div>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [brief, setBrief] = useState("");
  const [members, setMembers] = useState<MemberDraft[]>([{ display_name: "", github_login: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectivePrefix = prefixTouched ? prefix : suggestPrefix(name);

  function updateMember(i: number, patch: Partial<MemberDraft>) {
    setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    let ws;
    try {
      ws = await createProject({
      name: name.trim(),
      task_key_prefix: effectivePrefix.toUpperCase(),
      deadline_at: deadline ? new Date(deadline).toISOString() : null,
      members: members
        .filter((m) => m.display_name.trim() || m.github_login.trim())
        .map((m) => ({
          display_name: m.display_name.trim() || m.github_login.trim().replace(/^@/, ""),
          github_login: m.github_login.trim().replace(/^@/, "") || null,
        })),
      brief,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the project.");
      setSaving(false);
      return;
    }
    router.push(`/projects/${ws.project.project_id}`);
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-header">Create a new project</h1>
      <p className="mt-1 text-sm text-muted">
        A project holds your team&apos;s plan. Connect a repository later and Pit Crew compares the
        plan with what&apos;s actually happening in the code.
      </p>
      <p className="mt-3 text-xs italic text-muted">
        Required fields are marked with an asterisk (<span className="text-red">*</span>).
      </p>

      <form onSubmit={handleSubmit}>
        <hr className="my-6 border-line" />

        <div className="space-y-6">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-60 flex-1">
              <Field label="Project name" required hint="Great project names are short and memorable.">
                <input className={`${inputCls} w-full`} value={name} autoFocus required
                  onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
            <div className="w-36">
              <Field label="Task prefix" required hint={`Tasks: ${effectivePrefix || "PC"}-1, ${effectivePrefix || "PC"}-2…`}>
                <input className={`${inputCls} w-full font-mono uppercase`} value={effectivePrefix}
                  placeholder="PC" required pattern="[A-Za-z][A-Za-z0-9]{0,9}"
                  title="Letters/numbers, starts with a letter, max 10"
                  onChange={(e) => {
                    setPrefixTouched(true);
                    setPrefix(e.target.value);
                  }} />
              </Field>
            </div>
          </div>

          <Field label="Deadline" required hint="When the project is due, e.g. the hackathon submission time.">
            <input className={`${inputCls} w-64`} type="datetime-local" value={deadline} required
              onChange={(e) => setDeadline(e.target.value)} />
          </Field>

          <Field label="Description" hint="The brief: what you're building and what done looks like. Markdown works. You can edit it later.">
            <textarea className={`${inputCls} h-28 w-full`} value={brief}
              onChange={(e) => setBrief(e.target.value)} />
          </Field>
        </div>

        <hr className="my-6 border-line" />

        <h2 className="text-base font-semibold text-header">Team</h2>
        <p className="mt-1 mb-4 text-sm text-muted">
          GitHub usernames let Pit Crew match commits and pull requests to people.
        </p>

        <div className="overflow-hidden rounded-md border border-line">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-3 border-b border-line bg-raised px-3 py-2 text-xs font-semibold text-muted">
            <span>Name</span>
            <span>GitHub username</span>
            <span className="w-16" />
          </div>
          {members.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
              <input className={`${inputCls} w-full`} placeholder="Ada" value={m.display_name}
                onChange={(e) => updateMember(i, { display_name: e.target.value })} />
              <div className="flex items-center rounded-md border border-line bg-bg focus-within:border-link">
                <span className="pl-2.5 text-sm text-faint">@</span>
                <input className="w-full bg-transparent px-1 py-1.5 text-sm text-text placeholder:text-faint focus:outline-none"
                  placeholder="ada-codes" value={m.github_login}
                  onChange={(e) => updateMember(i, { github_login: e.target.value })} />
              </div>
              <button type="button" className="w-16 text-right text-xs text-muted hover:text-red disabled:invisible"
                disabled={members.length === 1}
                onClick={() => setMembers((ms) => ms.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={`${ghostButtonCls} mt-3`}
          onClick={() => setMembers((ms) => [...ms, { display_name: "", github_login: "" }])}>
          Add member
        </button>

        <hr className="my-6 border-line" />

        {error && (
          <p className="mb-4 rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>
        )}
        <div className="flex items-center gap-3">
          <button className={buttonCls} disabled={saving || !name.trim()}>
            {saving ? "Creating…" : "Create project"}
          </button>
          <Link href="/" className="text-sm text-link hover:underline">Cancel</Link>
        </div>
      </form>
    </main>
  );
}
