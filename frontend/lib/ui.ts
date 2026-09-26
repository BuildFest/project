// Small shared UI helpers.

export const inputCls =
  "rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm text-text placeholder:text-faint hover:border-line-strong focus:border-link focus:outline-none";

// Primary action (one per area).
export const buttonCls =
  "rounded-md border border-black/20 bg-signal px-3 py-1.5 text-sm font-semibold text-signal-ink hover:bg-signal-hover disabled:cursor-not-allowed disabled:opacity-50";

// Secondary action — GitHub-style default button.
export const ghostButtonCls =
  "rounded-md border border-line bg-raised px-3 py-1.5 text-sm font-medium text-text hover:border-line-strong hover:bg-line disabled:cursor-not-allowed disabled:opacity-50";

export const labelCls = "mb-1 block text-sm font-medium text-text";

// "Box" pattern: bordered panel with a header strip.
export const boxCls = "overflow-hidden rounded-md border border-line bg-surface";
export const boxHeaderCls =
  "flex items-center justify-between gap-3 border-b border-line bg-raised px-4 py-2.5";
export const boxTitleCls = "text-sm font-semibold text-header";
export const boxBodyCls = "p-4";

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
