// Small shared UI helpers.

export const inputCls =
  "rounded-sm border border-line bg-surface px-2 py-1 text-sm text-text placeholder:text-faint hover:border-line-strong focus:border-signal focus:outline-none";

export const buttonCls =
  "rounded-sm bg-signal px-3 py-1.5 font-display text-sm font-semibold uppercase tracking-wider text-signal-ink hover:brightness-110 disabled:opacity-40";

export const ghostButtonCls =
  "rounded-sm border border-line-strong px-3 py-1.5 font-display text-sm font-semibold uppercase tracking-wider text-text hover:border-signal hover:text-signal";

// Section headings and table headers — condensed, uppercase, tracked.
export const labelCls = "font-display text-xs font-semibold uppercase tracking-[0.12em] text-muted";
export const sectionTitleCls = "font-display text-lg font-semibold uppercase tracking-wider text-text";

export const panelCls = "rounded-sm border border-line bg-surface p-4";

// ISO string -> value for <input type="datetime-local"> (local time, no seconds)
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// "BP-3" + "Auth API routes" -> "bp-3-auth-api-routes"
export function suggestedBranch(taskKey: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `${taskKey.toLowerCase()}-${slug}` : taskKey.toLowerCase();
}

export const statusStyles: Record<string, string> = {
  not_started: "border-line text-muted",
  in_progress: "border-blue/50 bg-blue/10 text-blue",
  blocked: "border-red/50 bg-red/10 text-red",
  complete: "border-green/50 bg-green/10 text-green",
  cancelled: "border-line text-faint line-through",
};
