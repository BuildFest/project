"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectWorkspace } from "@/lib/types";
import { boxCls, boxHeaderCls, boxTitleCls, formatDate, smallButtonCls } from "@/lib/ui";
import BriefFullscreen from "./brief/BriefFullscreen";
import BriefView from "./brief/BriefView";

// Brief card on the Plan tab: rendered preview + opens the full-screen editor.
export default function BriefEditor({
  workspace,
  onChange,
}: {
  workspace: ProjectWorkspace;
  onChange: (w: ProjectWorkspace) => void;
}) {
  const { brief } = workspace;
  const [open, setOpen] = useState(false);
  const hasContent = brief.content.trim().length > 0;

  // Only fade the bottom of the preview when the brief is actually cut off.
  const previewRef = useRef<HTMLButtonElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 4);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [hasContent]);

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>Brief</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Updated {formatDate(brief.updated_at)}</span>
          <button className={smallButtonCls} onClick={() => setOpen(true)}>
            {hasContent ? "Edit" : "Write brief"}
          </button>
        </div>
      </div>

      {hasContent ? (
        <div className="relative">
          <button ref={previewRef} className="block max-h-72 w-full overflow-hidden px-4 py-3 text-left"
            onClick={() => setOpen(true)} title="Open the brief">
            <BriefView markdown={brief.content} />
          </button>
          {clipped && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent" />
          )}
        </div>
      ) : (
        <button className="block w-full px-4 py-8 text-center hover:bg-raised/60" onClick={() => setOpen(true)}>
          <p className="font-semibold text-header">No brief yet</p>
          <p className="mt-1 text-sm text-muted">
            Capture the idea, requirements, architecture and definition of done. Opens a full-screen editor.
          </p>
        </button>
      )}

      {open && <BriefFullscreen workspace={workspace} onChange={onChange} onClose={() => setOpen(false)} />}
    </section>
  );
}
