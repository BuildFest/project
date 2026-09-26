// Tiptap setup shared by the brief viewer and the full-screen editor.
// The brief is stored as Markdown (contract §2.5: content_format "markdown"),
// so everything here round-trips through @tiptap/markdown.

import { TaskItem, TaskList } from "@tiptap/extension-list";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

export function briefExtensions(opts: { placeholder?: string } = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({
      placeholder: opts.placeholder ?? "Write your project brief…",
    }),
    CharacterCount,
    Markdown,
  ];
}

// Starter structure from the PRD: idea, requirements, architecture, decisions,
// constraints, definition of done.
export const BRIEF_TEMPLATE = `# Idea

What are we building, and for whom?

## Requirements

- [ ] Must-have: 
- [ ] Must-have: 
- [ ] Nice-to-have: 

## Architecture

How the pieces fit together (frontend, backend, data, integrations).

## Technical decisions

- 

## Constraints

- Deadline: 

## Definition of done

- [ ] Demo works end-to-end
`;
