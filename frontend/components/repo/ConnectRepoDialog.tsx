"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, connectRepository, listRepositories, startBackfill, usingMockApi } from "@/lib/api";
import type { ConnectRepositoryResult, Repository } from "@/lib/types";
import { buttonCls, ghostButtonCls, inputCls, smallButtonCls } from "@/lib/ui";

// Two steps (contract §4.1): 1) name the repo, 2) paste the webhook into GitHub
// and wait for GitHub's ping to flip the repo to "connected".
export default function ConnectRepoDialog({
  projectId,
  onClose,
  onConnected,
}: {
  projectId: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [repoName, setRepoName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectRepositoryResult | null>(null);
  const [repo, setRepo] = useState<Repository | null>(null);
  const [backfill, setBackfill] = useState<"idle" | "started" | "unavailable">("idle");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Step 2: poll until GitHub's ping marks the repo connected.
  const repoId = result?.repository.repository_id;
  useEffect(() => {
    if (!repoId) return;
    let stop = false;
    const tick = () =>
      listRepositories(projectId).then(
        (rs) => {
          if (stop) return;
          const r = rs.find((x) => x.repository_id === repoId);
          if (r) setRepo(r);
          if (r?.connection_status === "connected") onConnected();
        },
        () => {}
      );
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [repoId, projectId, onConnected]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await connectRepository(projectId, repoName);
      setResult(r);
      setRepo(r.repository);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError("That repository is already connected to this project.");
      else if (err instanceof ApiError && err.status === 400)
        setError(`${err.message} Check the name, and that the backend's GITHUB_TOKEN can see this repo (it's private).`);
      else if (err instanceof ApiError && err.status === 502) setError("GitHub isn't responding right now. Try again in a moment.");
      else setError(err instanceof Error ? err.message : "Couldn't connect the repository.");
    } finally {
      setBusy(false);
    }
  }

  async function runBackfill() {
    if (!repo) return;
    try {
      await startBackfill(projectId, repo.repository_id);
      setBackfill("started");
    } catch {
      setBackfill("unavailable");
    }
  }

  const connected = repo?.connection_status === "connected";
  const localUrl = result && /localhost|127\.0\.0\.1/.test(result.webhook_url);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-16">
      <div role="dialog" aria-modal aria-label="Connect a repository"
        className="w-full max-w-xl overflow-hidden rounded-md border border-line-strong bg-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-line-strong bg-raised px-4 py-3">
          <h2 className="text-sm font-semibold text-header">Connect a GitHub repository</h2>
          <button className="text-muted hover:text-header" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        {!result ? (
          <form onSubmit={connect} className="space-y-4 p-4">
            <p className="text-sm text-muted">
              Pit Crew watches pushes, branches and pull requests on this repository and compares them with your plan.
            </p>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-header">Repository</span>
              <input autoFocus className={`${inputCls} w-full font-mono`} placeholder="BuildFest/project"
                value={repoName} onChange={(e) => setRepoName(e.target.value)} />
              <span className="mt-1.5 block text-xs text-muted">owner/name, or paste the github.com URL.</span>
            </label>
            {error && <p className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={ghostButtonCls} onClick={onClose}>Cancel</button>
              <button className={buttonCls} disabled={busy || !repoName.trim()}>{busy ? "Connecting…" : "Continue"}</button>
            </div>
          </form>
        ) : (
          <div className="space-y-4 p-4 text-sm">
            <Status repo={repo} />

            {!connected && (
              <>
                <p className="text-muted">
                  Add a webhook on GitHub so pushes and pull requests reach Pit Crew:
                </p>
                <ol className="space-y-3">
                  <Step n={1}>
                    Open{" "}
                    <a className="text-link hover:underline" target="_blank" rel="noreferrer"
                      href={`https://github.com/${result.repository.full_name}/settings/hooks/new`}>
                      {result.repository.full_name} → Settings → Webhooks → Add webhook
                    </a>
                  </Step>
                  <Step n={2}>
                    <span className="text-header">Payload URL</span>
                    <CopyField value={result.webhook_url} />
                  </Step>
                  <Step n={3}>
                    <span className="text-header">Content type</span>: <span className="font-mono">application/json</span>
                  </Step>
                  <Step n={4}>
                    <span className="text-header">Secret</span>
                    <CopyField value={result.webhook_secret} secret />
                    <span className="mt-1 block text-xs text-yellow">Shown only once. Copy it now.</span>
                  </Step>
                  <Step n={5}>
                    Events: <span className="text-header">Let me select individual events</span> → tick{" "}
                    <span className="text-header">Pushes</span> and <span className="text-header">Pull requests</span>, then{" "}
                    <span className="text-header">Add webhook</span>.
                  </Step>
                </ol>
                {localUrl && (
                  <p className="rounded-md border border-yellow/40 bg-yellow/10 px-3 py-2 text-xs text-yellow">
                    This URL points at localhost, which GitHub can&apos;t reach. Use the deployed backend, or expose it with
                    a tunnel (e.g. <span className="font-mono">ngrok http 8787</span>) and set <span className="font-mono">PUBLIC_BASE_URL</span>.
                  </p>
                )}
                {usingMockApi && (
                  <p className="text-xs text-faint">Sample mode: the connection will turn green on its own in a few seconds.</p>
                )}
              </>
            )}

            {connected && (
              <div className="rounded-md border border-line-strong p-3">
                <div className="font-semibold text-header">Import existing history</div>
                <p className="mt-0.5 text-muted">
                  Pull in branches, pull requests and recent commits from before the webhook existed.
                </p>
                <div className="mt-2">
                  {backfill === "idle" && <button className={smallButtonCls} onClick={runBackfill}>Import history</button>}
                  {backfill === "started" && <span className="text-xs text-green">Import started. Activity will fill in shortly.</span>}
                  {backfill === "unavailable" && (
                    <span className="text-xs text-muted">History import isn&apos;t available on the backend yet (contract §4.3).</span>
                  )}
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <button className={connected ? buttonCls : ghostButtonCls} onClick={onClose}>
                {connected ? "Done" : "I'll finish later"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function Status({ repo }: { repo: Repository | null }) {
  if (!repo) return null;
  const connected = repo.connection_status === "connected";
  const failed = repo.connection_status === "error";
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line-strong bg-raised px-3 py-2">
      <span className="font-mono text-header">{repo.full_name}</span>
      {connected ? (
        <span className="flex items-center gap-1.5 text-xs font-medium text-green">
          <span className="h-2 w-2 rounded-full bg-green" /> Connected, GitHub pinged Pit Crew
        </span>
      ) : failed ? (
        <span className="text-xs font-medium text-red">Webhook error</span>
      ) : (
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-yellow" /> Waiting for GitHub…
        </span>
      )}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line-strong text-xs text-muted">{n}</span>
      <div className="min-w-0 flex-1 text-text">{children}</div>
    </li>
  );
}

function CopyField({ value, secret }: { value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-line-strong bg-raised px-2 py-1 font-mono text-xs text-header">
        {shown ? value : "•".repeat(Math.min(value.length, 32))}
      </code>
      {secret && (
        <button className={smallButtonCls} onClick={() => setShown((s) => !s)}>{shown ? "Hide" : "Show"}</button>
      )}
      <button className={smallButtonCls}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setShown(true);
          }
        }}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
