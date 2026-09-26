import Link from "next/link";

// App header, GitHub-style: slim bar with the wordmark on the left.
export default function TopBar() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-3 px-6">
        <Link href="/" className="flex items-center gap-2">
          <span aria-hidden className="grid h-6 w-6 place-items-center rounded-md bg-signal">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-white" />
          </span>
          <span className="font-display text-lg font-bold uppercase tracking-wide text-header">
            Pit Crew
          </span>
        </Link>
      </div>
    </header>
  );
}
