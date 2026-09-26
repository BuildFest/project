import type { DerivedStatus, PlanStatus } from "./types";

// Small shared UI helpers.

export const inputCls =
  "rounded-md border border-line-strong bg-bg px-3 py-[5px] text-sm text-header placeholder:text-faint focus:border-link focus:outline-none focus:ring-1 focus:ring-link";

// Primary action (one per area) — our orange, GitHub button proportions.
export const buttonCls =
  "inline-flex items-center justify-center rounded-md border border-white/10 bg-signal px-3 py-[5px] text-sm font-medium text-signal-ink hover:bg-signal-hover disabled:cursor-not-allowed disabled:opacity-50";

// Default button — GitHub's grey button.
export const ghostButtonCls =
  "inline-flex items-center justify-center rounded-md border border-line-strong bg-btn px-3 py-[5px] text-sm font-medium text-header hover:bg-btn-hover disabled:cursor-not-allowed disabled:opacity-50";

export const smallButtonCls =
  "inline-flex items-center justify-center rounded-md border border-line-strong bg-btn px-2 py-[2px] text-xs font-medium text-header hover:bg-btn-hover disabled:opacity-50";

export const labelCls = "mb-1.5 block text-sm font-semibold text-header";

// GitHub "Label": small outlined pill.
export const pillCls = "inline-flex items-center rounded-full border border-line-strong px-2 text-xs font-medium text-muted";

// "Box": bordered panel with a header row.
export const boxCls = "overflow-hidden rounded-md border border-line-strong bg-surface";
export const boxHeaderCls =
  "flex items-center justify-between gap-3 border-b border-line-strong bg-raised px-4 py-3";
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

// Map the team's plan status onto the derived vocabulary so the two can be
// compared ("blocked" ~ "possibly_blocked"; cancelled tasks aren't compared).
export function planAsDerived(s: PlanStatus): DerivedStatus | null {
  if (s === "cancelled") return null;
  if (s === "blocked") return "possibly_blocked";
  return s;
}

// Reverse: what plan_status to write when the team accepts what Pit Crew saw.
export function derivedAsPlan(s: DerivedStatus): PlanStatus {
  return s === "possibly_blocked" ? "blocked" : s;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
