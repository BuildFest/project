// Small 16px line icons in the spirit of GitHub's UI (hand-drawn, not copied).
type P = { className?: string };
const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const IconProject = (p: P) => (
  <svg {...base} className={p.className}><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5.5 5v6M8 5v3.5M10.5 5v4.5" /></svg>
);
export const IconPulse = (p: P) => (
  <svg {...base} className={p.className}><path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" /></svg>
);
export const IconChecklist = (p: P) => (
  <svg {...base} className={p.className}><path d="M2 4l1.2 1.2L5.5 3M2 10l1.2 1.2L5.5 9M8 4.2h6M8 10.2h6" /></svg>
);
export const IconCommit = (p: P) => (
  <svg {...base} className={p.className}><circle cx="8" cy="8" r="2.5" /><path d="M1 8h4.5M10.5 8H15" /></svg>
);
export const IconAlert = (p: P) => (
  <svg {...base} className={p.className}><path d="M8 2L14.5 13.5h-13L8 2z" /><path d="M8 6.5v3" /><circle cx="8" cy="11.5" r=".4" fill="currentColor" /></svg>
);
export const IconStop = (p: P) => (
  <svg {...base} className={p.className}><circle cx="8" cy="8" r="6.2" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></svg>
);
export const IconInfo = (p: P) => (
  <svg {...base} className={p.className}><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v3.8" /><circle cx="8" cy="5" r=".4" fill="currentColor" /></svg>
);
export const IconBranches = (p: P) => (
  <svg {...base} className={p.className}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 2.5-2 3.5-7 4" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...base} className={p.className}><path d="M3 8.5l3 3 7-7" /></svg>
);
export const IconPeople = (p: P) => (
  <svg {...base} className={p.className}><circle cx="6" cy="5.5" r="2.3" /><path d="M1.8 13.5c.5-2.3 2.2-3.5 4.2-3.5s3.7 1.2 4.2 3.5" /><path d="M10.5 3.4a2.2 2.2 0 010 4.2M12 10.3c1.2.5 2 1.6 2.2 3.2" /></svg>
);
export const IconMilestone = (p: P) => (
  <svg {...base} className={p.className}><path d="M8 1.5v13" /><path d="M8 3h5l-1.5 2L13 7H8" /></svg>
);
export const IconClock = (p: P) => (
  <svg {...base} className={p.className}><circle cx="8" cy="8" r="6.2" /><path d="M8 4.5V8l2.5 1.5" /></svg>
);
