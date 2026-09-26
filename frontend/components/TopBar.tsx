"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// App header, like GitHub's: near-black bar. On project pages the project
// header (breadcrumb + tabs) continues directly below it in the same color,
// so the divider line is drawn there instead.
export default function TopBar() {
  const onProject = usePathname().startsWith("/projects/");
  return (
    <header className={`bg-topbar ${onProject ? "" : "border-b border-line"}`}>
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-6">
        <Link href="/" className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-btn">
          <Logo />
          <span className="text-sm font-semibold text-header">Pit Crew</span>
        </Link>
      </div>
    </header>
  );
}

function Logo() {
  // Small pit-board mark: rounded square with a checkered corner.
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--pc-signal)" />
      <rect x="7" y="7" width="5" height="5" fill="#fff" />
      <rect x="12" y="12" width="5" height="5" fill="#fff" />
      <rect x="12" y="7" width="5" height="5" fill="#fff" opacity="0.35" />
      <rect x="7" y="12" width="5" height="5" fill="#fff" opacity="0.35" />
    </svg>
  );
}
