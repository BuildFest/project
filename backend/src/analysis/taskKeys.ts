import type { GithubEvent } from "./types.js";

// Finds task keys like PC-12 in free text. Matching is case-insensitive so
// branch names such as pc-12-auth-api work, and keys are returned normalized
// (uppercase prefix, no leading zeros) in order of first appearance.
export function extractTaskKeys(text: string | null | undefined, prefix: string): string[] {
  if (!text) return [];
  const pattern = new RegExp(`(?<![A-Za-z0-9])${prefix}-(\\d+)(?![A-Za-z0-9])`, "gi");
  const keys: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const key = `${prefix.toUpperCase()}-${Number(match[1])}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Keys referenced by an event, most specific source first: the PR title is
// what the author wrote about the work, then the branch, then the commit.
export function extractEventTaskKeys(event: GithubEvent, prefix: string): string[] {
  const sources = [
    event.pull_request?.title,
    event.pull_request?.head_branch,
    event.branch,
    event.commit?.message,
  ];
  const keys: string[] = [];
  for (const source of sources) {
    for (const key of extractTaskKeys(source, prefix)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}
