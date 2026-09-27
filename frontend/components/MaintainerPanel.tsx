"use client";

import { useEffect, useState } from "react";
import { ApiError, askPitCrew, generateDigest, listMaintainerNotes } from "@/lib/api";
import type { MaintainerCitation, MaintainerNote, ProjectState, ProjectWorkspace } from "@/lib/types";
import { boxCls, boxHeaderCls, boxTitleCls, buttonCls, inputCls, smallButtonCls, timeAgo } from "@/lib/ui";

// Ask Pit Crew and the periodic digest (contract §5.0). Notes are read-only:
// answering never changes the plan.

export default function MaintainerPanel({
  workspace,
  state,
  onTask,
}: {
  workspace: ProjectWorkspace;
  state: ProjectState | null;
  onTask: (taskId: string) => void;
}) {
  const pid = workspace.project.project_id;
  const [notes, setNotes] = useState<MaintainerNote[] | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<"ask" | "digest" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listMaintainerNotes(pid).then(
      (n) => !cancelled && setNotes(n),
      () => !cancelled && setNotes([])
    );
    return () => {
      cancelled = true;
    };
  }, [pid]);

  async function run(kind: "ask" | "digest") {
    setBusy(kind);
    setError(null);
    try {
      const note = kind === "ask" ? await askPitCrew(pid, question) : await generateDigest(pid);
      setNotes((prev) => [note, ...(prev ?? [])]);
      if (kind === "ask") setQuestion("");
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 429
          ? "Pit Crew is answering a lot of questions right now. Try again in a minute."
          : e instanceof Error ? e.message : "Something went wrong."
      );
    } finally {
      setBusy(null);
    }
  }

  const digest = notes?.find((n) => n.kind === "digest");
  const answers = (notes ?? []).filter((n) => n.kind === "answer");
  const [latest, ...earlier] = answers;
  const q = question.trim();

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>Ask Pit Crew</h2>
        <button className={smallButtonCls} onClick={() => run("digest")} disabled={busy !== null}>
          {busy === "digest" ? "Summarizing…" : "New digest"}
        </button>
      </div>

      <form className="flex gap-2 border-b border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.length >= 2) run("ask");
        }}>
        <input className={`${inputCls} min-w-0 flex-1`} value={question} maxLength={1000}
          placeholder="What's blocking the demo? Who's working on auth?"
          onChange={(e) => setQuestion(e.target.value)} />
        <button className={buttonCls} disabled={busy !== null || q.length < 2}>
          {busy === "ask" ? "Thinking…" : "Ask"}
        </button>
      </form>

      {error && <p className="border-b border-line px-4 py-2 text-sm text-red">{error}</p>}

      {notes === null ? (
        <p className="px-4 py-4 text-sm text-muted">Loading…</p>
      ) : !latest && !digest ? (
        <p className="px-4 py-4 text-sm text-muted">
          Ask about the plan, the repo or the team. Answers cite the tasks and events they rely on.
        </p>
      ) : (
        <div className="divide-y divide-line">
          {latest && <NoteView note={latest} workspace={workspace} state={state} onTask={onTask} />}
          {digest && <NoteView note={digest} workspace={workspace} state={state} onTask={onTask} />}
          {earlier.length > 0 && (
            <div className="px-4 py-2">
              <button className="text-xs text-muted hover:text-link" onClick={() => setShowEarlier((s) => !s)}>
                {showEarlier ? "▾" : "▸"} {earlier.length} earlier question{earlier.length === 1 ? "" : "s"}
              </button>
            </div>
          )}
          {showEarlier && earlier.map((n) => (
            <NoteView key={n.note_id} note={n} workspace={workspace} state={state} onTask={onTask} />
          ))}
        </div>
      )}
    </section>
  );
}

function NoteView({
  note: n,
  workspace,
  state,
  onTask,
}: {
  note: MaintainerNote;
  workspace: ProjectWorkspace;
  state: ProjectState | null;
  onTask: (taskId: string) => void;
}) {
  return (
    <article className="px-4 py-3 text-sm">
      <p className="text-xs text-muted">
        {n.kind === "digest" ? "Digest" : <>Q: <span className="text-header">{n.question}</span></>}
        <span className="ml-2 text-faint">
          {timeAgo(n.created_at)} · {n.generated_by === "llm" ? "AI" : "rules"}
        </span>
      </p>
      <p className="mt-1 whitespace-pre-wrap text-text">{n.body}</p>
      {n.citations.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {n.citations.filter((c) => nameable(c, state)).map((c) => (
            <Citation key={`${c.type}:${c.id}`} c={c} workspace={workspace} state={state} onTask={onTask} />
          ))}
          {countByType(n.citations.filter((c) => !nameable(c, state))).map(([type, count]) => (
            <span key={type} className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
              {count} {CITED[type]}{count === 1 ? "" : "s"}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

const CITED: Record<MaintainerCitation["type"], string> = {
  task: "task",
  event: "repo event",
  signal: "risk",
  collision: "collision",
  replan: "replan suggestion",
};

// Tasks always get their own chip; signals only when /state still has them.
// Everything else is summarized as a count so the row stays readable.
const nameable = (c: MaintainerCitation, state: ProjectState | null) =>
  c.type === "task" || (c.type === "signal" && !!state?.signals.some((s) => s.signal_id === c.id));

function countByType(cs: MaintainerCitation[]) {
  const m = new Map<MaintainerCitation["type"], number>();
  for (const c of cs) m.set(c.type, (m.get(c.type) ?? 0) + 1);
  return [...m.entries()];
}

function Citation({
  c,
  workspace,
  state,
  onTask,
}: {
  c: MaintainerCitation;
  workspace: ProjectWorkspace;
  state: ProjectState | null;
  onTask: (taskId: string) => void;
}) {
  const chip = "rounded-full border border-line px-2 py-0.5 text-xs text-muted";
  if (c.type === "task") {
    const t = workspace.tasks.find((x) => x.task_id === c.id);
    return (
      <button className={`${chip} font-mono hover:border-link hover:text-link`} title={t?.title}
        onClick={() => onTask(c.id)}>
        {t?.task_key ?? "task"}
      </button>
    );
  }
  const signal = state?.signals.find((s) => s.signal_id === c.id);
  return <span className={chip} title={signal?.explanation}>{signal?.title ?? CITED[c.type]}</span>;
}
