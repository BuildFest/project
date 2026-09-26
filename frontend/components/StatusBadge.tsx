import type { DerivedStatus, PlanStatus } from "@/lib/types";

// GitHub-style label: thin colored border + colored text, no fill.
const STYLES: Record<string, { label: string; cls: string }> = {
  not_started: { label: "Not started", cls: "border-line-strong text-muted" },
  in_progress: { label: "In progress", cls: "border-blue/60 text-blue" },
  complete: { label: "Complete", cls: "border-green/60 text-green" },
  possibly_blocked: { label: "Possibly blocked", cls: "border-yellow/60 text-yellow" },
  blocked: { label: "Blocked", cls: "border-red/60 text-red" },
  cancelled: { label: "Cancelled", cls: "border-line-strong text-faint line-through" },
};

export const statusLabel = (s: string) => STYLES[s]?.label ?? s;

export default function StatusBadge({ status }: { status: DerivedStatus | PlanStatus }) {
  const s = STYLES[status] ?? STYLES.not_started;
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 text-xs font-medium leading-5 ${s.cls}`}>
      {s.label}
    </span>
  );
}
