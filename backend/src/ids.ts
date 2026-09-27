import { monotonicFactory } from "ulid";

// Monotonic so IDs minted in the same millisecond still sort in creation
// order; rows inserted in one transaction share now() and fall back to ID order.
const ulid = monotonicFactory();

// Prefixed ULIDs, e.g. "task_01JQ983A...". The prefix makes IDs self-describing
// in logs and evidence arrays; the ULID sorts by creation time.
export function newId(prefix: "proj" | "mem" | "ms" | "task" | "repo" | "event" | "link" | "sig" | "col" | "tl" | "dec"): string {
  return `${prefix}_${ulid()}`;
}
