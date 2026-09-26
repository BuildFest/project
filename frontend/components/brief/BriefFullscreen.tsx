"use client";

import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { updateBrief } from "@/lib/api";
import type { ProjectWorkspace } from "@/lib/types";
import { buttonCls, ghostButtonCls, inputCls, smallButtonCls, timeAgo } from "@/lib/ui";
import { BRIEF_TEMPLATE, briefExtensions } from "./extensions";

type SaveState = "saved" | "dirty" | "saving" | "error";
const AUTOSAVE_MS = 1200;

// Full-screen brief editor. Autosaves (debounced) as Markdown; Cmd/Ctrl+S saves
// immediately; Esc or "Done" saves and closes.
export default function BriefFullscreen({
  workspace,
  onChange,
  onClose,
}: {
  workspace: ProjectWorkspace;
  onChange: (w: ProjectWorkspace) => void;
  onClose: () => void;
}) {
  const pid = workspace.project.project_id;
  const [status, setStatus] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<string>(workspace.brief.updated_at);
  const [error, setError] = useState<string | null>(null);
  const lastSaved = useRef(workspace.brief.content);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // onUpdate is bound when the editor is created, so it calls save through a
  // ref to always get the latest version (which knows about the editor).
  const saveRef = useRef<() => Promise<boolean>>(async () => true);

  const editor = useEditor({
    extensions: briefExtensions({
      placeholder: "Describe the idea, requirements, architecture and definition of done…  (Markdown shortcuts work: # heading, - list, [ ] task, > quote, ``` code)",
    }),
    content: workspace.brief.content,
    contentType: "markdown",
    immediatelyRender: false,
    autofocus: "end",
    editorProps: { attributes: { class: "pc-prose pc-prose-editable", spellcheck: "true" } },
    onUpdate: () => {
      setStatus("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
    },
  });

  const save = useCallback(async () => {
    if (!editor) return true;
    if (timer.current) clearTimeout(timer.current);
    const md = editor.getMarkdown();
    if (md === lastSaved.current) {
      setStatus("saved");
      return true;
    }
    setStatus("saving");
    try {
      const w = await updateBrief(pid, md);
      lastSaved.current = md;
      setSavedAt(w.brief.updated_at);
      setStatus("saved");
      setError(null);
      onChange(w);
      return true;
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Couldn't save the brief.");
      return false;
    }
  }, [editor, pid, onChange]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // Clear any pending autosave timer on unmount.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const done = useCallback(async () => {
    if (await save()) onClose();
  }, [save, onClose]);

  // Keyboard: Cmd/Ctrl+S to save, Esc to save & close. Lock page scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        void done();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [save, done]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (status === "dirty" || status === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status]);

  const counts = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      words: ed?.storage.characterCount.words() ?? 0,
      empty: ed?.isEmpty ?? true,
    }),
  });

  // Rendered into <body> so no parent (overflow, transforms, stacking) can
  // affect the overlay or its toolbar.
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-modal aria-label="Edit project brief">
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line-strong bg-topbar px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted">{workspace.project.name}</span>
          <span className="text-muted">/</span>
          <span className="font-semibold text-header">Brief</span>
          <SaveBadge status={status} savedAt={savedAt} />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-faint sm:inline">⌘S to save · Esc to close</span>
          <button className={buttonCls} onClick={done} disabled={status === "saving"}>Done</button>
        </div>
      </div>

      {/* Toolbar */}
      {editor && <Toolbar editor={editor} />}

      {error && (
        <div className="border-b border-red/40 bg-red/10 px-4 py-2 text-center text-sm text-red">
          {error}{" "}
          <button className="underline" onClick={() => void save()}>Retry</button>
        </div>
      )}

      {/* Document */}
      <div className="flex-1 overflow-y-auto" onClick={() => editor?.commands.focus()}>
        <div className="mx-auto w-full max-w-3xl px-6 py-10" onClick={(e) => e.stopPropagation()}>
          {counts?.empty && editor && (
            <div className="mb-6 rounded-md border border-dashed border-line-strong px-4 py-3 text-sm text-muted">
              Starting from scratch?{" "}
              <button className="text-link hover:underline"
                onClick={() => editor.chain().focus().setContent(BRIEF_TEMPLATE, { contentType: "markdown" }).run()}>
                Insert the brief template
              </button>{" "}
              (idea, requirements, architecture, decisions, constraints, definition of done).
            </div>
          )}
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* Footer */}
      <div className="flex h-8 shrink-0 items-center justify-end gap-4 border-t border-line bg-topbar px-4 text-xs text-faint">
        <span>{counts?.words ?? 0} words</span>
        <span>Saved as Markdown</span>
      </div>
    </div>,
    document.body
  );
}

function SaveBadge({ status, savedAt }: { status: SaveState; savedAt: string }) {
  const text = {
    saved: `Saved ${timeAgo(savedAt)}`,
    dirty: "Unsaved changes",
    saving: "Saving…",
    error: "Not saved",
  }[status];
  const color = status === "error" ? "text-red" : status === "saved" ? "text-faint" : "text-muted";
  return <span className={`ml-2 whitespace-nowrap text-xs ${color}`}>{text}</span>;
}

// ---------------------------------------------------------------------------

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");

  const chain = () => editor.chain().focus();

  function openLink() {
    setUrl((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinkOpen(true);
  }
  function applyLink(e: React.FormEvent) {
    e.preventDefault();
    const href = url.trim();
    if (!href) chain().extendMarkRange("link").unsetLink().run();
    else chain().extendMarkRange("link").setLink({ href }).run();
    setLinkOpen(false);
  }

  return (
    <div className="relative z-10 shrink-0 border-b border-line-strong bg-raised">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-0.5 px-4 py-1.5">
        <Btn label="Heading 1" active={s.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()}>H1</Btn>
        <Btn label="Heading 2" active={s.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>H2</Btn>
        <Btn label="Heading 3" active={s.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}>H3</Btn>
        <Sep />
        <Btn label="Bold (⌘B)" active={s.bold} onClick={() => chain().toggleBold().run()}><b>B</b></Btn>
        <Btn label="Italic (⌘I)" active={s.italic} onClick={() => chain().toggleItalic().run()}><i className="font-serif">I</i></Btn>
        <Btn label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}><s>S</s></Btn>
        <Btn label="Inline code" active={s.code} onClick={() => chain().toggleCode().run()}><span className="font-mono text-xs">{"<>"}</span></Btn>
        <Btn label="Link" active={s.link} onClick={openLink}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1" /></svg>
        </Btn>
        <Sep />
        <Btn label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 4h8M6 8h8M6 12h8" /><circle cx="2.5" cy="4" r=".8" fill="currentColor" /><circle cx="2.5" cy="8" r=".8" fill="currentColor" /><circle cx="2.5" cy="12" r=".8" fill="currentColor" /></svg>
        </Btn>
        <Btn label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5M2 3l1-.5V6M2 9.2c.3-.5 1.8-.6 1.8.3 0 .7-1.8 1.4-1.8 2h1.9" /></svg>
        </Btn>
        <Btn label="Checklist" active={s.task} onClick={() => chain().toggleTaskList().run()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="4" height="4" rx="1" /><path d="M2.3 11l1 1 1.7-2M8 4.5h6M8 11h6" /></svg>
        </Btn>
        <Btn label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 3v10M6 5h8M6 8h8M6 11h5" /></svg>
        </Btn>
        <Btn label="Code block" active={s.codeBlock} onClick={() => chain().toggleCodeBlock().run()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" /></svg>
        </Btn>
        <Btn label="Divider" onClick={() => chain().setHorizontalRule().run()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 8h12" /></svg>
        </Btn>
        <Sep />
        <Btn label="Undo (⌘Z)" disabled={!s.canUndo} onClick={() => chain().undo().run()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5H10a3 3 0 010 6H7" /><path d="M6.5 4L4 6.5 6.5 9" /></svg>
        </Btn>
        <Btn label="Redo (⇧⌘Z)" disabled={!s.canRedo} onClick={() => chain().redo().run()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 6.5H6a3 3 0 000 6h3" /><path d="M9.5 4L12 6.5 9.5 9" /></svg>
        </Btn>
      </div>

      {linkOpen && (
        <form onSubmit={applyLink} className="mx-auto flex max-w-5xl items-center gap-2 border-t border-line px-4 py-2">
          <span className="text-xs text-muted">Link</span>
          <input autoFocus className={`${inputCls} flex-1 !py-1 text-xs`} placeholder="https://…"
            value={url} onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setLinkOpen(false))} />
          <button className={smallButtonCls}>Apply</button>
          {s.link && (
            <button type="button" className={smallButtonCls}
              onClick={() => { chain().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); }}>
              Remove
            </button>
          )}
          <button type="button" className={`${ghostButtonCls} !px-2 !py-1 text-xs`} onClick={() => setLinkOpen(false)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

function Btn({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} /* keep editor selection */
      onClick={onClick}
      className={`grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-sm ${
        active ? "bg-btn-hover text-header" : "text-muted hover:bg-btn hover:text-header"
      } disabled:opacity-40 disabled:hover:bg-transparent`}>
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-1 h-5 w-px bg-line-strong" />;
}
