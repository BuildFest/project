"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";
import { briefExtensions } from "./extensions";

// Read-only rendering of the Markdown brief with the same styles as the editor.
export default function BriefView({ markdown }: { markdown: string }) {
  const editor = useEditor({
    extensions: briefExtensions(),
    content: markdown,
    contentType: "markdown",
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { class: "pc-prose" } },
  });

  // Keep in sync when the brief is saved elsewhere.
  useEffect(() => {
    if (editor && editor.getMarkdown() !== markdown) {
      editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
    }
  }, [editor, markdown]);

  return <EditorContent editor={editor} />;
}
